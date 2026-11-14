// End-to-end test in a real OpenCode: `bun scripts/e2e.ts [--send]`.
// Needs the plugin listed in ~/.config/opencode/cli.json and the base model
// downloaded. The spoken test clip stands in for the microphone. With
// --send it also presses Enter while dictating, which sends the prompt to
// your configured model (one short message).
import { join } from 'node:path'
import { launch, type Driver } from './drive'

const root = join(import.meta.dir, '..')
const clip = join(root, 'test', 'fixtures', 'two-phrases.wav')
const send = process.argv.includes('--send')
let failures = 0

function check(ok: boolean, what: string) {
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${what}`)
  if (!ok) {
    failures++
  }
}

/** The text in the prompt box: the ┃ lines above its model line. */
function promptText(d: Driver): string {
  const lines = d.screen()
  const model = lines.findIndex(l => /Build · /.test(l))
  let start = model
  while (start > 0 && /^\s*┃/.test(lines[start - 1]!)) {
    start--
  }
  return lines
    .slice(start, model)
    .map(l => l.replace(/^\s*┃\s?/, '').trim())
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim()
}

async function waitPrompt(d: Driver, pattern: RegExp, timeoutMs = 30000) {
  const end = Date.now() + timeoutMs
  while (Date.now() < end) {
    if (pattern.test(promptText(d))) {
      return
    }
    await Bun.sleep(100)
  }
  throw new Error(`Timed out waiting for the prompt to match ${pattern}; it reads "${promptText(d)}"`)
}

async function open(): Promise<Driver> {
  const d = await launch(join(root, 'playground'), { OPENCODE_DICTATION_WAV: clip })
  await d.waitFor(/Ask anything|What's new/, 30000)
  await Bun.sleep(1500)
  if (d.text().includes("What's new")) {
    d.write('\x1b')
    await d.waitForGone("What's new")
  }
  await d.waitFor('🎙')
  return d
}

const d = await open()
try {
  // 1. Typing and speaking mix: type first, then click the mic.
  d.write('Hello there.')
  await d.waitFor('Hello there.')
  await d.click('🎙')
  await d.waitFor('●', 30000)
  check(true, 'clicking the mic starts listening (red dot shown)')
  check(d.text().includes('listening'), 'the footer says it is listening')
  // Watch the prompt box: while the first sentence is spoken, a draft of it
  // shows up in the prompt (and grows) before the final text lands.
  const seen = new Set<string>()
  let greyed = ''
  const end = Date.now() + 30000
  while (Date.now() < end && !/refactor the login function\./i.test(promptText(d))) {
    seen.add(promptText(d))
    greyed ||= d.italic()
    await Bun.sleep(50)
  }
  const drafts = [...seen].filter(t => /^Hello there\. \S/.test(t))
  console.log(`      drafts seen: ${drafts.map(t => JSON.stringify(t.slice(13))).join(', ') || 'none'}`)
  check(drafts.length > 0, 'a draft of the words shows inside the prompt before the pause')
  console.log(`      drawn in grey italics: ${JSON.stringify(greyed)}`)
  check(/refactor|please/i.test(greyed), 'the draft is drawn in grey italics')
  check(!d.text().includes('“'), 'nothing is drawn under the prompt for the draft')
  await waitPrompt(d, /refactor the login function/i)
  check(true, 'the first phrase is typed while still listening')
  await waitPrompt(d, /unit tests for the error cases/i)
  check(d.text().includes('●'), 'still listening after the second phrase')

  // 2. Clicking the dot stops; the prompt keeps the words and is not sent.
  await d.click('●')
  await d.waitFor('🎙', 15000)
  check(d.italic() === '', 'once stopped, all the text is drawn normally (no draft left)')
  const text = promptText(d)
  console.log(`      prompt now: "${text}"`)
  check(/^Hello there\. Please refactor the login function\. ?Then add unit tests for the error cases\.$/i.test(text), 'the prompt reads as one sentence after another, joined to the typed text')
  check(d.text().includes('Ask anything') === false, 'the prompt was not sent')

  // 3. Esc cancels: nothing more is typed.
  d.write('\x15') // ctrl+u clears the line before the cursor
  await Bun.sleep(300)
  for (let i = 0; i < 3 && promptText(d) !== ''; i++) {
    d.write('\x15')
    await Bun.sleep(300)
  }
  d.write('\x1bv') // alt+v
  await d.waitFor('●', 15000)
  check(true, 'alt+v starts listening')
  await Bun.sleep(600)
  d.write('\x1b')
  await d.waitFor('🎙', 15000)
  await Bun.sleep(4000)
  check(!/refactor/i.test(promptText(d)), 'esc cancels and nothing is typed afterwards')
  check(!d.text().includes('●'), 'the red dot is gone after cancelling')

  // 4. /dictate works as a slash command too.
  d.write('/dictate')
  await Bun.sleep(600)
  d.write('\r')
  await d.waitFor('●', 15000)
  check(true, '/dictate starts listening')
  await waitPrompt(d, /refactor the login function/i)

  if (send) {
    // 5. Enter stops, writes the last words and sends.
    await waitPrompt(d, /unit tests/i).catch(() => {})
    d.write('\r')
    await d.waitForGone('●', 30000)
    await d.waitFor(/Please refactor the login function/i, 30000)
    await Bun.sleep(3000)
    const box = promptText(d)
    check(!/refactor/i.test(box), 'enter sends the dictated prompt (the box is empty again)')
    check(/Please refactor the login function/i.test(d.text()), 'the sent message shows in the session')
  } else {
    await d.click('●')
    await d.waitFor('🎙', 15000)
  }
} catch (error) {
  failures++
  console.log(`FAIL  ${error instanceof Error ? error.message : error}`)
} finally {
  await d.close()
}
console.log(failures ? `${failures} failed` : 'all passed')
process.exit(failures ? 1 : 0)
