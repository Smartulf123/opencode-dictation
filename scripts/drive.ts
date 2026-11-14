// Drives a real OpenCode in a pseudo-terminal: presses keys, clicks with the
// mouse and reads the screen, so the plugin can be tested end to end. The
// spoken test clip stands in for the microphone (OPENCODE_DICTATION_WAV).
import { Terminal } from '@xterm/headless'

export type Driver = {
  screen(): string[]
  text(): string
  waitFor(pattern: RegExp | string, timeoutMs?: number): Promise<string[]>
  waitForGone(pattern: RegExp | string, timeoutMs?: number): Promise<void>
  write(data: string): void
  /** Clicks the first cell showing `label`. */
  click(label: string): Promise<void>
  find(label: string): { row: number; col: number } | undefined
  close(): Promise<void>
}

const COLS = 120
const ROWS = 36

function matches(lines: string[], pattern: RegExp | string): boolean {
  const all = lines.join('\n')
  return typeof pattern === 'string' ? all.includes(pattern) : pattern.test(all)
}

export async function launch(cwd: string, env: Record<string, string> = {}): Promise<Driver> {
  const term = new Terminal({ cols: COLS, rows: ROWS, allowProposedApi: true })
  const decoder = new TextDecoder()
  const proc = Bun.spawn([process.env.OPENCODE_BIN ?? `${process.env.APPDATA}/npm/node_modules/@opencode/cli/bin/opencode.exe`], {
    cwd,
    env: { ...process.env, ...env },
    terminal: {
      cols: COLS,
      rows: ROWS,
      data(_t, data) {
        term.write(decoder.decode(data, { stream: true }))
      },
    },
  })
  const screen = () => {
    const buf = term.buffer.active
    const lines: string[] = []
    for (let i = 0; i < ROWS; i++) {
      lines.push(buf.getLine(buf.viewportY + i)?.translateToString(true) ?? '')
    }
    return lines
  }
  const until = async (ok: () => boolean, what: string, timeoutMs: number) => {
    const end = Date.now() + timeoutMs
    while (Date.now() < end) {
      if (ok()) {
        return
      }
      await Bun.sleep(100)
    }
    throw new Error(`Timed out waiting for ${what}. Screen:\n${screen().join('\n')}`)
  }
  const find = (label: string) => {
    const lines = screen()
    for (let row = lines.length - 1; row >= 0; row--) {
      const col = lines[row]!.indexOf(label)
      if (col >= 0) {
        return { row, col }
      }
    }
    return undefined
  }
  const write = (data: string) => proc.terminal!.write(data)
  return {
    screen,
    text: () => screen().join('\n'),
    find,
    write,
    async waitFor(pattern, timeoutMs = 20000) {
      await until(() => matches(screen(), pattern), String(pattern), timeoutMs)
      return screen()
    },
    async waitForGone(pattern, timeoutMs = 20000) {
      await until(() => !matches(screen(), pattern), `${pattern} to go away`, timeoutMs)
    },
    async click(label) {
      const at = find(label)
      if (!at) {
        throw new Error(`Nothing on screen shows "${label}"`)
      }
      // SGR mouse: press and release of the left button, 1-based cell.
      const x = at.col + 1
      const y = at.row + 1
      write(`\x1b[<0;${x};${y}M`)
      await Bun.sleep(50)
      write(`\x1b[<0;${x};${y}m`)
    },
    async close() {
      proc.kill()
      await proc.exited
      term.dispose()
    },
  }
}
