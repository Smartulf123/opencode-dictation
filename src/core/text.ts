// Turning what Whisper hears into text that reads well in a prompt.

/**
 * Whisper writes sound tags like "[BLANK_AUDIO]", "(music)" or "*coughs*" for
 * noise, and on near-silence it tends to invent stock phrases. These never
 * belong in a prompt.
 */
const NOISE_TAG = /\[[^\]]*\]|\([^)]*\)|\*[^*]*\*|♪+/g
const HALLUCINATIONS = new Set([
  'you',
  'thank you',
  'thanks for watching',
  'thank you for watching',
  'bye',
  'okay',
  '.',
])

/** Cleans one recognised phrase; returns '' when nothing real was said. */
export function cleanPhrase(raw: string): string {
  const text = raw.replace(NOISE_TAG, ' ').replace(/\s+/g, ' ').trim()
  const bare = text.toLowerCase().replace(/[.!?,\s]+$/g, '').trim()
  if (bare === '' || HALLUCINATIONS.has(bare)) {
    return ''
  }
  return text
}

/**
 * The text to insert at the cursor so the phrase joins what is already
 * typed: a space in front unless the cursor is at the start of the prompt or
 * after whitespace.
 */
export function joinAtCursor(before: string, phrase: string): string {
  if (phrase === '') {
    return ''
  }
  const needsSpace = before.length > 0 && !/\s$/.test(before)
  // A phrase that starts a new sentence starts with a capital.
  const startsSentence = before.trim() === '' || /[.!?]\s*$/.test(before)
  const text = startsSentence ? phrase.charAt(0).toUpperCase() + phrase.slice(1) : phrase
  return (needsSpace ? ' ' : '') + text
}

/** A level meter of `width` cells for a peak in 0..1. */
export function levelBar(peak: number, width = 5): string {
  const cells = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█']
  const level = Math.max(0, Math.min(1, peak))
  let out = ''
  for (let i = 0; i < width; i++) {
    const fill = Math.max(0, Math.min(1, level * width - i))
    out += cells[Math.round(fill * (cells.length - 1))]
  }
  return out
}
