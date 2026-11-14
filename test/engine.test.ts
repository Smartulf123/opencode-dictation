// The real thing: Silero VAD and Whisper on a recorded clip of two spoken
// sentences with a pause between them. Skipped until the base model has been
// downloaded (the plugin does that on first use).
import { expect, test } from 'bun:test'
import { join } from 'node:path'
import { WavFileSource } from '../src/core/audio'
import { createEngine } from '../src/core/engine'
import { isModelReady, modelFiles } from '../src/core/models'
import { DictationSession } from '../src/core/session'

const FIXTURE = join(import.meta.dir, 'fixtures', 'two-phrases.wav')

test.skipIf(!isModelReady('base'))(
  'transcribes two spoken phrases, one per pause, in order',
  async () => {
    const engine = await createEngine(modelFiles('base'), { language: 'en' })
    const phrases: string[] = []
    const session = new DictationSession({ onPhrase: p => phrases.push(p) })
    await session.start(WavFileSource.fromFile(FIXTURE, false), engine)
    await session.stop()
    expect(phrases).toHaveLength(2)
    expect(phrases[0]!.toLowerCase()).toContain('refactor the login function')
    expect(phrases[1]!.toLowerCase()).toContain('unit tests for the error cases')
  },
  60_000,
)
