// One dictation: the microphone is open, every pause turns what was said
// into a phrase of text, and phrases come out in the order they were spoken.
import { peakOf, type AudioSource } from './audio'
import type { Engine } from './engine'
import { cleanPhrase } from './text'

export type SessionState = 'idle' | 'starting' | 'listening' | 'finishing'

export type SessionEvents = {
  /** A finished phrase, already cleaned, never empty. */
  onPhrase(text: string): void
  onState?(state: SessionState): void
  /** The loudness of the latest frame (0..1) and whether speech is detected. */
  onLevel?(peak: number, speaking: boolean): void
  onError?(error: unknown): void
}

export class DictationSession {
  state: SessionState = 'idle'
  private source?: AudioSource
  private engine?: Engine
  /** Transcriptions run one after another so phrases keep their order. */
  private chain: Promise<void> = Promise.resolve()
  private discard = false

  constructor(private readonly events: SessionEvents) {}

  private setState(state: SessionState) {
    this.state = state
    this.events.onState?.(state)
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
    for (const phrase of engine.segmenter.accept(frame)) {
      this.queue(phrase)
    }
    this.events.onLevel?.(peakOf(frame), engine.segmenter.isSpeaking())
  }

  private queue(samples: Float32Array) {
    const engine = this.engine
    if (!engine) {
      return
    }
    this.chain = this.chain.then(async () => {
      if (this.discard) {
        return
      }
      try {
        const text = cleanPhrase(await engine.recognizer.transcribe(samples))
        if (text && !this.discard) {
          this.events.onPhrase(text)
        }
      } catch (error) {
        this.events.onError?.(error)
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
    for (const phrase of this.engine?.segmenter.flush() ?? []) {
      this.queue(phrase)
    }
    await this.chain
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
    this.engine?.segmenter.reset()
    await this.chain
    this.setState('idle')
  }
}
