import { describe, expect, test } from 'bun:test'
import { InlineDraft, type Editor } from '../src/core/inline'

/** A plain-text stand-in for OpenTUI's edit buffer. */
class FakeEditor implements Editor {
  plainText: string
  cursorOffset: number
  private sel: [number, number] | null = null
  highlights: { start: number; end: number }[] = []
  syntaxStyle = { registerStyle: () => 7 }
  constructor(text = '', cursor = text.length) {
    this.plainText = text
    this.cursorOffset = cursor
  }
  insertText(text: string) {
    const c = this.cursorOffset
    this.plainText = this.plainText.slice(0, c) + text + this.plainText.slice(c)
    this.cursorOffset = c + text.length
  }
  setSelection(start: number, end: number) {
    this.sel = [start, end]
  }
  deleteSelection() {
    if (!this.sel) {
      return false
    }
    const [a, b] = this.sel
    this.plainText = this.plainText.slice(0, a) + this.plainText.slice(b)
    this.cursorOffset = a
    this.sel = null
    return true
  }
  addHighlightByCharRange(h: { start: number; end: number }) {
    this.highlights.push({ start: h.start, end: h.end })
  }
  removeHighlightsByRef() {
    this.highlights = []
  }
}

describe('draft in the prompt', () => {
  test('grows in place and becomes the final text', () => {
    const e = new FakeEditor('Hello there.')
    const d = new InlineDraft(e)
    d.show('please')
    expect(e.plainText).toBe('Hello there. Please')
    expect(e.highlights).toEqual([{ start: 12, end: 19 }])
    d.show('please refactor the')
    expect(e.plainText).toBe('Hello there. Please refactor the')
    expect(e.cursorOffset).toBe(e.plainText.length)
    d.commit('please refactor the login function.')
    expect(e.plainText).toBe('Hello there. Please refactor the login function.')
    expect(e.highlights).toEqual([])
    expect(e.cursorOffset).toBe(e.plainText.length)
  })

  test('the next phrase follows the last one', () => {
    const e = new FakeEditor('')
    const d = new InlineDraft(e)
    d.show('fix the')
    d.commit('Fix the login.')
    d.show('then add')
    expect(e.plainText).toBe('Fix the login. Then add')
    d.commit('then add tests.')
    expect(e.plainText).toBe('Fix the login. Then add tests.')
  })

  test('clear takes the draft out again', () => {
    const e = new FakeEditor('Keep this')
    const d = new InlineDraft(e)
    d.show('noise words')
    d.clear()
    expect(e.plainText).toBe('Keep this')
    expect(e.cursorOffset).toBe(9)
  })

  test('works in the middle of the text and keeps the cursor after it', () => {
    const e = new FakeEditor('Start end', 5)
    const d = new InlineDraft(e)
    d.show('middle')
    expect(e.plainText).toBe('Start middle end')
    d.commit('middle bit')
    expect(e.plainText).toBe('Start middle bit end')
    expect(e.cursorOffset).toBe(16)
  })

  test('a draft edited by hand is left alone', () => {
    const e = new FakeEditor('')
    const d = new InlineDraft(e)
    d.show('draft words')
    e.plainText = 'Drift words'
    expect(d.isShown()).toBe(false)
    d.commit('final')
    expect(e.plainText).toBe('Drift words final')
  })

  test('typing right after the draft keeps what was typed', () => {
    const e = new FakeEditor('')
    const d = new InlineDraft(e)
    d.show('draft words')
    e.insertText('!')
    d.commit('final words')
    expect(e.plainText).toBe('Final words!')
  })

  test('commit with no draft just writes at the cursor', () => {
    const e = new FakeEditor('Hi.')
    new InlineDraft(e).commit('there')
    expect(e.plainText).toBe('Hi. There')
  })
})
