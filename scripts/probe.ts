// Prints the prompt box and bar a few times during a dictation, to see how it looks.
import { join } from 'node:path'
import { launch } from './drive'
const root = join(import.meta.dir, '..')
const d = await launch(join(root, 'playground'), { OPENCODE_DICTATION_WAV: join(root, 'test/fixtures/two-phrases.wav') })
await d.waitFor(/Ask anything|What's new/, 30000); await Bun.sleep(1500)
if (d.text().includes("What's new")) { d.write('\x1b'); await d.waitForGone("What's new") }
await d.click('🎙')
const seen = new Set<string>()
const end = Date.now() + 9000
while (Date.now() < end) {
  const lines = d.screen()
  const bar = lines.findIndex(l => l.includes('●') || l.includes('◌'))
  if (bar > 0) {
    const shot = lines.slice(bar - 5, bar + 1).filter(l => l.trim()).map(l => l.trimEnd()).join('\n')
    if (!seen.has(shot)) { seen.add(shot); console.log(shot + '\n---') }
  }
  await Bun.sleep(150)
}
await d.close()
