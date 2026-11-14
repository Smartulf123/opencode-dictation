// One dictation: the microphone is open, every pause turns what was said
// into a phrase of text, and phrases come out in the order they were spoken.
// While a phrase is still being spoken, a draft of it is transcribed every
// so often, so the words can be shown before the pause.
import { FRAME, SAMPLE_RATE, peakOf, type AudioSource } from './audio'
import type { Engine } from './engine'
import { cleanPhrase } from './text'

export type SessionState = 'idle' | 'starting' | 'listening' | 'finishing'

export type SessionEvents = {
  /** A finished phrase, already cleaned, never empty. */
  onPhrase(text: string): void
  /** A draft of the phrase being spoken right now; '' when there is none. */
  onDraft?(text: string): void
  /** Whether finished phrases are waiting to be written out. */
  onBusy?(busy: boolean): void
  onState?(state: SessionState): void
  /** The loudness of the latest frame (0..1) and whether speech is detected. */
  onLevel?(peak: number, speaking: boolean): void
  onError?(error: unknown): void
}

export type SessionOptions = {
  /** How often a draft of the current phrase is made, in seconds of audio. */
  draftEvery?: number
  /** A phrase must be this long, in seconds, before it gets a draft. */
  draftAfter?: number
}

/** Sound kept from just before speech is detected, so drafts don't miss the first word. */
const PREROLL_FRAMES = 10

export class DictationSession {
  state: SessionState = 'idle'
  private source?: AudioSource
  private engine?: Engine
  /** Every use of the recognizer runs one after another: phrases keep their order. */
  private chain: Promise<void> = Promise.resolve()
  private discard = false
  private pending = 0
  private drafting = false
  /** The phrase being spoken: its frames and a number that changes with each phrase. */
  private current: Float32Array[] = []
  private utterance = 0
  private recent: Float32Array[] = []
  private sinceDraft = 0
  private draftShown = false
  /** Which phrase the draft on show belongs to. */
  private draftFor = -1
  private readonly draftEveryFrames: number
  private readonly draftAfterFrames: number

  constructor(
    private readonly events: SessionEvents,
    options: SessionOptions = {},
  ) {
    this.draftEveryFrames = Math.round(((options.draftEvery ?? 0.6) * SAMPLE_RATE) / FRAME)
    this.draftAfterFrames = Math.round(((options.draftAfter ?? 0.4) * SAMPLE_RATE) / FRAME)
  }

  private setState(state: SessionState) {
    this.state = state
    this.events.onState?.(state)
  }

  private setDraft(text: string) {
    if (text === '' && !this.draftShown) {
      return
    }
    this.draftShown = text !== ''
    this.events.onDraft?.(text)
  }

  private setPending(delta: number) {
    const wasBusy = this.pending > 0
    this.pending += delta
    if (wasBusy !== this.pending > 0) {
      this.events.onBusy?.(this.pending > 0)
    }
  }

  /**
   * Opens the source and starts listening. `engine` may be a promise, so the
   * model can still be loading while the microphone opens.
   */
  async start(source: AudioSource, engine: Engine | Promise<Engine>): Promise<void> {
    if (this.state !== 'idle') {
      return
    }
    this.discard = false
    this.current = []
    this.recent = []
    this.setState('starting')
    const stillStarting = () => (this.state as SessionState) === 'starting'
    try {
      this.engine = await engine
      if (!stillStarting()) {
        // Stopped while the model was loading: never open the microphone.
        return
      }
      this.engine.segmenter.reset()
      this.source = source
      await source.start(frame => this.onFrame(frame))
    } catch (error) {
      this.source = undefined
      this.setState('idle')
      throw error
    }
    if (stillStarting()) {
      this.setState('listening')
    } else if (this.source === source) {
      // Stopped while the microphone was opening.
      this.source = undefined
      await source.stop()
    }
  }

  private onFrame(frame: Float32Array) {
    const engine = this.engine
    if (!engine || (this.state !== 'listening' && this.state !== 'starting')) {
      return
    }
    const phrases = engine.segmenter.accept(frame)
    for (const phrase of phrases) {
      this.queue(phrase)
    }
    const speaking = engine.segmenter.isSpeaking()
    if (phrases.length > 0) {
      // That phrase is finished; the next one starts fresh.
      this.current = []
      this.utterance++
    }
    if (speaking) {
      if (this.current.length === 0) {
        this.current = [...this.recent]
        this.sinceDraft = 0
      }
      this.current.push(frame)
      this.sinceDraft++
      this.maybeDraft()
    }
    this.recent.push(frame)
    if (this.recent.length > PREROLL_FRAMES) {
      this.recent.shift()
    }
    this.events.onLevel?.(peakOf(frame), speaking)
  }

  /** Transcribes what has been said so far of the current phrase, when the recognizer is free. */
  private maybeDraft() {
    const engine = this.engine
    if (
      !engine ||
      !this.events.onDraft ||
      this.drafting ||
      this.pending > 0 ||
      this.sinceDraft < this.draftEveryFrames ||
      this.current.length < this.draftAfterFrames
    ) {
      return
    }
    this.sinceDraft = 0
    this.drafting = true
    const utterance = this.utterance
    const samples = concat(this.current)
    this.chain = this.chain.then(async () => {
      try {
        if (this.discard || this.state !== 'listening' || utterance !== this.utterance) {
          return
        }
        const text = cleanPhrase(await engine.recognizer.transcribe(samples))
        // Only show it if that phrase is still being spoken.
        if (text && !this.discard && this.state === 'listening' && utterance === this.utterance) {
          this.draftFor = utterance
          this.setDraft(text)
        }
      } catch {
        // A failed draft is not worth a message; the finished phrase will say.
      } finally {
        this.drafting = false
      }
    })
  }

  private queue(samples: Float32Array) {
    const engine = this.engine
    if (!engine) {
      return
    }
    const utterance = this.utterance
    this.setPending(1)
    this.chain = this.chain.then(async () => {
      try {
        if (this.discard) {
          return
        }
        const text = cleanPhrase(await engine.recognizer.transcribe(samples))
        if (!this.discard) {
          if (this.draftFor <= utterance) {
            // The draft was of this phrase (or older): the real text replaces it.
            this.setDraft('')
          }
          if (text) {
            this.events.onPhrase(text)
          }
        }
      } catch (error) {
        this.events.onError?.(error)
      } finally {
        this.setPending(-1)
      }
    })
  }

  /** Stops listening and waits until the last words are written out. */
  async stop(): Promise<void> {
    if (this.state !== 'listening' && this.state !== 'starting') {
      await this.chain
      return
    }
    this.setState('finishing')
    await this.source?.stop()
    this.source = undefined
    this.current = []
    this.utterance++
    for (const phrase of this.engine?.segmenter.flush() ?? []) {
      this.queue(phrase)
    }
    await this.chain
    this.setDraft('')
    this.setState('idle')
  }

  /** Stops listening and throws away anything not yet written out. */
  async cancel(): Promise<void> {
    this.discard = true
    if (this.state === 'idle') {
      return
    }
    this.setState('finishing')
    await this.source?.stop()
    this.source = undefined
    this.current = []
    this.utterance++
    this.engine?.segmenter.reset()
    await this.chain
    this.setDraft('')
    this.setState('idle')
  }
}

function concat(frames: Float32Array[]): Float32Array {
  const out = new Float32Array(frames.reduce((n, f) => n + f.length, 0))
  let at = 0
  for (const f of frames) {
    out.set(f, at)
    at += f.length
  }
  return out
}
