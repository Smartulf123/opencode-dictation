import { describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, readdirSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { FRAME, WavFileSource, readWav, toFloat, type AudioSource } from '../src/core/audio'
import type { Engine } from '../src/core/engine'
import { downloadsFor, ensureModel, isModelReady, modelFiles } from '../src/core/models'
import { DictationSession, type SessionState } from '../src/core/session'
import { cleanPhrase, joinAtCursor, levelBar } from '../src/core/text'

const FIXTURE = join(import.meta.dir, 'fixtures', 'two-phrases.wav')

describe('text', () => {
  test('keeps real speech and trims it', () => {
    expect(cleanPhrase('  Please refactor the login function. ')).toBe('Please refactor the login function.')
  })
  test('drops sound tags and silence hallucinations', () => {
    expect(cleanPhrase('[BLANK_AUDIO]')).toBe('')
    expect(cleanPhrase('(music)')).toBe('')
    expect(cleanPhrase(' Thank you. ')).toBe('')
    expect(cleanPhrase('you')).toBe('')
    expect(cleanPhrase('Fix the bug [inaudible] in main')).toBe('Fix the bug in main')
  })
  test('joins a phrase to what is already typed', () => {
    expect(joinAtCursor('', 'Hello.')).toBe('Hello.')
    expect(joinAtCursor('Fix this', 'and that.')).toBe(' and that.')
    expect(joinAtCursor('Fix this ', 'and that.')).toBe('and that.')
    expect(joinAtCursor('line\n', 'next')).toBe('next')
    expect(joinAtCursor('x', '')).toBe('')
  })
  test('capitalises a phrase that starts a sentence', () => {
    expect(joinAtCursor('Fix the login.', 'then add tests.')).toBe(' Then add tests.')
    expect(joinAtCursor('', 'hello')).toBe('Hello')
    expect(joinAtCursor('Fix the login and', 'then add tests.')).toBe(' then add tests.')
  })
  test('draws a level meter', () => {
    expect(levelBar(0)).toBe('▁▁▁▁▁')
    expect(levelBar(1)).toBe('█████')
    expect(levelBar(0.5)).toHaveLength(5)
  })
})

describe('models', () => {
  test('puts each model in its own folder and shares the VAD', () => {
    const files = modelFiles('base', '/cache')
    expect(files.encoder.replace(/\\/g, '/')).toBe('/cache/models/whisper-base/base-encoder.int8.onnx')
    expect(files.vad.replace(/\\/g, '/')).toBe('/cache/models/silero_vad.onnx')
    expect(downloadsFor('tiny', '/cache').map(d => d.url)).toContain(
      'https://huggingface.co/csukuangfj/sherpa-onnx-whisper-tiny/resolve/main/tiny-tokens.txt',
    )
  })

  test('downloads only what is missing and reports progress', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dictation-'))
    const asked: string[] = []
    const fakeFetch = (async (url: string) => {
      asked.push(url)
      return new Response('model bytes')
    }) as unknown as typeof fetch
    let last = 0
    expect(isModelReady('tiny', root)).toBe(false)
    await ensureModel('tiny', done => (last = done), root, fakeFetch)
    expect(asked).toHaveLength(4)
    expect(last).toBeGreaterThan(0)
    expect(isModelReady('tiny', root)).toBe(true)
    await ensureModel('tiny', () => {}, root, fakeFetch)
    expect(asked).toHaveLength(4)
  })

  test('leaves no half-written file when a download fails', async () => {
    const root = mkdtempSync(join(tmpdir(), 'dictation-'))
    const failing = (async () => new Response('nope', { status: 404 })) as unknown as typeof fetch
    await expect(ensureModel('base', () => {}, root, failing)).rejects.toThrow('HTTP 404')
    const dir = join(root, 'models', 'whisper-base')
    expect(existsSync(dir) ? readdirSync(dir) : []).toEqual([])
  })
})

describe('audio', () => {
  test('reads the 16 kHz fixture', () => {
    const samples = readWav(FIXTURE)
    expect(samples.length / 16000).toBeGreaterThan(5)
    expect(Math.max(...samples.subarray(0, 40000).map(Math.abs))).toBeGreaterThan(0.05)
  })
  test('converts 16-bit samples to floats', () => {
    expect([...toFloat(new Int16Array([0, 16384, -32768]))]).toEqual([0, 0.5, -1])
  })
  test('plays a file as frames, then silence', async () => {
    const frames: Float32Array[] = []
    await new WavFileSource(new Float32Array(FRAME * 2).fill(0.5), false).start(f => frames.push(f))
    expect(frames.length).toBeGreaterThan(2)
    expect(frames[0]![0]).toBe(0.5)
    expect(frames.at(-1)![0]).toBe(0)
  })
})

/** A fake engine: every frame whose first sample is > 0 ends a phrase named by that sample. */
function fakeEngine(delays: Record<number, number> = {}): Engine {
  let speaking: number[] = []
  return {
    segmenter: {
      accept(frame) {
        if (frame[0]! > 0) {
          speaking.push(frame[0]!)
        }
        if (frame[0]! < 0 && speaking.length) {
          const out = [Float32Array.from(speaking)]
          speaking = []
          return out
        }
        return []
      },
      flush() {
        const out = speaking.length ? [Float32Array.from(speaking)] : []
        speaking = []
        return out
      },
      isSpeaking: () => speaking.length > 0,
      reset() {
        speaking = []
      },
    },
    recognizer: {
      async transcribe(samples) {
        const id = Math.round(samples[0]! * 10)
        await Bun.sleep(delays[id] ?? 1)
        return `phrase ${id}`
      },
    },
  }
}

/** A source the test drives by hand. */
class ManualSource implements AudioSource {
  push?: (frame: Float32Array) => void
  started = false
  stopped = false
  async start(onFrame: (frame: Float32Array) => void) {
    this.started = true
    this.push = onFrame
  }
  async stop() {
    this.stopped = true
  }
  say(value: number) {
    this.push!(new Float32Array([value]))
  }
}

describe('session', () => {
  test('writes phrases in spoken order even when a later one is faster', async () => {
    const phrases: string[] = []
    const states: SessionState[] = []
    const session = new DictationSession({ onPhrase: p => phrases.push(p), onState: s => states.push(s) })
    const source = new ManualSource()
    await session.start(source, fakeEngine({ 1: 40, 2: 1 }))
    source.say(0.1)
    source.say(-1)
    source.say(0.2)
    source.say(-1)
    await session.stop()
    expect(phrases).toEqual(['phrase 1', 'phrase 2'])
    expect(states).toEqual(['starting', 'listening', 'finishing', 'idle'])
    expect(source.stopped).toBe(true)
  })

  test('stop writes the phrase still being spoken', async () => {
    const phrases: string[] = []
    const session = new DictationSession({ onPhrase: p => phrases.push(p) })
    const source = new ManualSource()
    await session.start(source, fakeEngine())
    source.say(0.3)
    await session.stop()
    expect(phrases).toEqual(['phrase 3'])
  })

  test('cancel throws the words away', async () => {
    const phrases: string[] = []
    const session = new DictationSession({ onPhrase: p => phrases.push(p) })
    const source = new ManualSource()
    await session.start(source, fakeEngine({ 4: 30 }))
    source.say(0.4)
    source.say(-1)
    source.say(0.5)
    await session.cancel()
    expect(phrases).toEqual([])
    expect(session.state).toBe('idle')
  })

  test('stopping while the model loads never opens the microphone', async () => {
    const session = new DictationSession({ onPhrase: () => {} })
    const source = new ManualSource()
    let resolve!: (engine: Engine) => void
    const starting = session.start(source, new Promise<Engine>(r => (resolve = r)))
    await session.stop()
    resolve(fakeEngine())
    await starting
    expect(source.started).toBe(false)
    expect(session.state).toBe('idle')
  })

  test('shows a draft while a phrase is spoken, then replaces it with the real text', async () => {
    const drafts: string[] = []
    const phrases: string[] = []
    const busy: boolean[] = []
    const session = new DictationSession(
      { onPhrase: p => phrases.push(p), onDraft: t => drafts.push(t), onBusy: b => busy.push(b) },
      { draftEvery: (2 * 512) / 16000, draftAfter: (2 * 512) / 16000 },
    )
    const source = new ManualSource()
    await session.start(source, fakeEngine())
    for (let i = 0; i < 4; i++) {
      source.say(0.1)
      await Bun.sleep(5)
    }
    expect(drafts).toContain('phrase 1')
    expect(phrases).toEqual([])
    source.say(-1)
    await session.stop()
    expect(phrases).toEqual(['phrase 1'])
    expect(drafts.at(-1)).toBe('')
    expect(busy).toEqual([true, false])
  })

  test('never shows a draft after cancelling', async () => {
    const drafts: string[] = []
    const session = new DictationSession(
      { onPhrase: () => {}, onDraft: t => drafts.push(t) },
      { draftEvery: (2 * 512) / 16000, draftAfter: (2 * 512) / 16000 },
    )
    const source = new ManualSource()
    await session.start(source, fakeEngine({ 1: 30 }))
    for (let i = 0; i < 3; i++) {
      source.say(0.1)
    }
    await session.cancel()
    expect(drafts.filter(Boolean)).toEqual([])
  })

  test('a failing transcription is reported and the rest continue', async () => {
    const phrases: string[] = []
    const errors: unknown[] = []
    const engine = fakeEngine()
    const real = engine.recognizer.transcribe
    engine.recognizer.transcribe = async s => (Math.round(s[0]! * 10) === 1 ? Promise.reject(new Error('boom')) : real(s))
    const session = new DictationSession({ onPhrase: p => phrases.push(p), onError: e => errors.push(e) })
    const source = new ManualSource()
    await session.start(source, engine)
    source.say(0.1)
    source.say(-1)
    source.say(0.2)
    await session.stop()
    expect(phrases).toEqual(['phrase 2'])
    expect(errors).toHaveLength(1)
  })
})
