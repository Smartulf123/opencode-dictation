// Listens on the real microphone for a few seconds and prints what it hears.
// `bun scripts/mic-check.ts [seconds] [device]`
import { MicrophoneSource, listMicrophones } from '../src/core/audio'
import { createEngine } from '../src/core/engine'
import { ensureModel } from '../src/core/models'
import { DictationSession } from '../src/core/session'

const seconds = Number(process.argv[2] ?? 8)
console.log('microphones:', await listMicrophones())
const engine = await createEngine(await ensureModel('base'), { language: 'en' })
let peak = 0
const session = new DictationSession({
  onPhrase: p => console.log('heard:', JSON.stringify(p)),
  onLevel: l => (peak = Math.max(peak, l)),
  onError: e => console.error(e),
})
const mic = new MicrophoneSource(process.argv[3] ?? '')
await session.start(mic, engine)
console.log('listening on', mic.deviceName, `for ${seconds}s`)
await Bun.sleep(seconds * 1000)
await session.stop()
console.log('loudest frame:', peak.toFixed(3))
