// The speech engine: Silero VAD cuts the sound into phrases at each pause,
// and Whisper (through sherpa-onnx, which ships prebuilt for Windows, macOS
// and Linux) turns each phrase into text, on the CPU, offline.
import type { ModelFiles } from './models'
import { SAMPLE_RATE } from './audio'

/** Splits a stream of frames into finished phrases. */
export interface Segmenter {
  /** Feeds a frame; returns any phrases that ended in it. */
  accept(frame: Float32Array): Float32Array[]
  /** Ends the stream; returns the phrase still being spoken, if any. */
  flush(): Float32Array[]
  /** True while someone is speaking. */
  isSpeaking(): boolean
  reset(): void
}

/** Turns one phrase of audio into text. */
export interface Recognizer {
  transcribe(samples: Float32Array): Promise<string>
}

export type Engine = { segmenter: Segmenter; recognizer: Recognizer }

export type EngineOptions = {
  /** A Whisper language code such as "en" or "de"; empty detects the language. */
  language?: string
  threads?: number
  /** How long a pause ends a phrase, in seconds. */
  pause?: number
}

type Sherpa = {
  Vad: new (config: object, bufferSeconds: number) => {
    acceptWaveform(samples: Float32Array): void
    isEmpty(): boolean
    isDetected(): boolean
    front(external?: boolean): { samples: Float32Array; start: number }
    pop(): void
    flush(): void
    reset(): void
  }
  OfflineRecognizer: {
    createAsync(config: object): Promise<{
      createStream(): { acceptWaveform(wave: { sampleRate: number; samples: Float32Array }): void }
      decodeAsync(stream: object): Promise<unknown>
      getResult(stream: object): { text: string }
    }>
  }
}

async function loadSherpa(): Promise<Sherpa> {
  const mod = (await import('sherpa-onnx-node')) as unknown as Sherpa & { default?: Sherpa }
  return mod.default ?? mod
}

export async function createEngine(files: ModelFiles, options: EngineOptions = {}): Promise<Engine> {
  const sherpa = await loadSherpa()
  const threads = options.threads ?? 4
  const recognizer = await sherpa.OfflineRecognizer.createAsync({
    featConfig: { sampleRate: SAMPLE_RATE, featureDim: 80 },
    modelConfig: {
      whisper: {
        encoder: files.encoder,
        decoder: files.decoder,
        language: options.language ?? '',
        task: 'transcribe',
      },
      tokens: files.tokens,
      numThreads: threads,
      provider: 'cpu',
      debug: 0,
    },
  })
  const vadConfig = {
    sileroVad: {
      model: files.vad,
      threshold: 0.5,
      minSpeechDuration: 0.25,
      minSilenceDuration: options.pause ?? 0.6,
      // Whisper reads at most 30 s at a time, so a long run without a pause
      // is cut before that.
      maxSpeechDuration: 25,
      windowSize: 512,
    },
    sampleRate: SAMPLE_RATE,
    numThreads: 1,
    debug: 0,
  }
  const vad = new sherpa.Vad(vadConfig, 120)
  const drain = () => {
    const out: Float32Array[] = []
    while (!vad.isEmpty()) {
      // Copy: the segment may point into the VAD's own buffer.
      out.push(Float32Array.from(vad.front(false).samples))
      vad.pop()
    }
    return out
  }
  return {
    segmenter: {
      accept(frame) {
        vad.acceptWaveform(frame)
        return drain()
      },
      flush() {
        vad.flush()
        const out = drain()
        vad.reset()
        return out
      },
      isSpeaking: () => vad.isDetected(),
      reset: () => vad.reset(),
    },
    recognizer: {
      async transcribe(samples) {
        const stream = recognizer.createStream()
        stream.acceptWaveform({ sampleRate: SAMPLE_RATE, samples })
        await recognizer.decodeAsync(stream)
        return recognizer.getResult(stream).text
      },
    },
  }
}
