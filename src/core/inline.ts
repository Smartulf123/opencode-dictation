// The draft in the prompt itself: while a phrase is being spoken, its words
// so far are written into the prompt at the cursor (greyed out where the
// editor allows it), replaced in place as the draft improves, and replaced
// by the final text at the pause. If you edit the draft by hand it is left
// alone, so speaking never fights with typing.
import { joinAtCursor } from './text'

/** The bit of an OpenTUI edit buffer this needs. */
export type Editor = {
  plainText: string
  cursorOffset: number
  insertText(text: string): void
  setSelection(start: number, end: number): void
  deleteSelection(): boolean
  isDestroyed?: boolean
  syntaxStyle?: { registerStyle(name: string, style: object): number } | null
  addHighlightByCharRange?(highlight: { start: number; end: number; styleId: number; hlRef?: number }): void
  removeHighlightsByRef?(ref: number): void
  extmarks?: { create(options: { start: number; end: number; styleId?: number; priority?: number }): number; delete(id: number): boolean }
}

const HL_REF = 0x6d1c

export class InlineDraft {
  /** Where the draft starts, and the exact text of it now in the prompt (with its leading space). */
  private anchor = 0
  private shown = ''
  private styleId: number | null | undefined
  private mark: number | undefined

  constructor(
    private readonly editor: Editor,
    private readonly draftColor = '#8a8a8a',
  ) {}

  /** True while a draft is in the prompt and still exactly as written. */
  isShown(): boolean {
    return this.shown !== '' && this.intact()
  }

  private intact(): boolean {
    const e = this.editor
    return !e.isDestroyed && e.plainText.slice(this.anchor, this.anchor + this.shown.length) === this.shown
  }

  /** Writes or updates the draft. */
  show(text: string): void {
    this.replace(text, true)
  }

  /** Replaces the draft with the final phrase (or just writes it at the cursor when there is none). */
  commit(text: string): void {
    this.replace(text, false)
    this.shown = ''
  }

  /** Takes the draft back out of the prompt. */
  clear(): void {
    if (this.shown && this.intact()) {
      this.replace('', false)
    }
    this.shown = ''
  }

  private replace(text: string, isDraft: boolean): void {
    const e = this.editor
    if (e.isDestroyed) {
      return
    }
    if (this.shown && !this.intact()) {
      // Edited by hand: the draft is the user's text now.
      this.shown = ''
    }
    const cursor = e.cursorOffset
    let start: number
    let oldLength = 0
    if (this.shown) {
      start = this.anchor
      oldLength = this.shown.length
    } else {
      start = cursor
    }
    const insert = joinAtCursor(e.plainText.slice(0, start), text)
    this.unhighlight()
    if (oldLength > 0) {
      e.setSelection(start, start + oldLength)
      e.deleteSelection()
    }
    // Put the cursor where the text goes, write it, then put the cursor back
    // where the user had it (moved along if it was after the draft).
    e.cursorOffset = start
    if (insert) {
      e.insertText(insert)
    }
    const delta = insert.length - oldLength
    const wasAtDraftEnd = cursor === start + oldLength
    if (wasAtDraftEnd || cursor >= start + oldLength) {
      e.cursorOffset = cursor + delta
    } else if (cursor > start) {
      e.cursorOffset = start + insert.length
    } else {
      e.cursorOffset = cursor
    }
    this.anchor = start
    this.shown = isDraft ? insert : ''
    if (isDraft && insert) {
      this.highlight(start, start + insert.length)
    }
  }

  private highlight(start: number, end: number) {
    const e = this.editor
    try {
      if (this.styleId === undefined) {
        this.styleId = e.syntaxStyle?.registerStyle('dictation.draft', { fg: this.draftColor, italic: true }) ?? null
      }
      if (this.styleId === null) {
        return
      }
      if (e.extmarks) {
        // The prompt keeps its own styled ranges (extmarks) and redraws its
        // highlights from them, so the draft's grey has to be one too.
        this.mark = e.extmarks.create({ start, end, styleId: this.styleId, priority: 10 })
      } else if (e.addHighlightByCharRange) {
        e.addHighlightByCharRange({ start, end, styleId: this.styleId, hlRef: HL_REF })
      }
    } catch {
      // Grey is a nicety; plain text is fine.
      this.styleId = null
    }
  }

  private unhighlight() {
    const e = this.editor
    try {
      if (this.mark !== undefined) {
        e.extmarks?.delete(this.mark)
        this.mark = undefined
      }
      e.removeHighlightsByRef?.(HL_REF)
    } catch {
      // Nothing to remove.
    }
  }
}
