'use strict'

/**
 * The questions freebuff draws at the bottom of its screen, and how to answer
 * them the way a person does.
 *
 * A dialog is not a yes/no prompt with a keyboard shortcut: it is a box with a
 * question and a list of choices, where the highlighted row is moved with the
 * arrow keys and confirmed with Enter, multi-select rows are toggled with the
 * space bar, and the empty input box disappears while it is open. Typing `y`
 * at one of those does nothing at all, which is why the supervisor could not
 * pick anything.
 *
 * Parsing is deliberately conservative. Only the bottom of the screen can be a
 * dialog, the choices have to form one run of at least two rows, and a run of
 * numbered lines from the agent's own conversation is not accepted while the
 * input box is still drawn (see `parse`): a transcript full of "1. ... 2. ..."
 * must never be mistaken for a question.
 */

/** Box borders and their padding, stripped from both ends of a row. */
function trimBorders (row) {
  return String(row == null ? '' : row)
    .replace(/^[\s│┃|║]+/, '')
    .replace(/[\s│┃|║╮╯╗┐╭╰┌└├┤┬┴┼─]+$/, '')
    .trim()
}

/** The row the highlighted choice is drawn with. */
const CURSOR = /^([❯›▶►➤→>▸▹☞⇒»])\s*/
/** Radio buttons: filled means chosen. */
const RADIO = /^([◉○◯●◎◍⊙])\s*/
/** Checkboxes: ticked means chosen. */
const CHECK = /^([☑☐✅❌✓✔✗✘])\s*/
/** A checkbox drawn with brackets, `[x]` / `[ ]`. */
const BRACKET = /^\[([ xX✓✔])\]\s+/
/** `1.` / `1)` / `(1)` before a choice. */
const NUMBER = /^\(?(\d{1,2})[.)]\s+/
/** Plain bullets: only used as a weak signal, never alone. */
const BULLET = /^[-*•·]\s+/

/** Glyphs that mean "chosen" and "not chosen" for a radio or checkbox row. */
const CHOSEN = new Set(['◉', '●', '◎', '◍', '⊙', '☑', '✅', '✓', '✔'])
const EMPTY = new Set(['○', '◯', '☐', '❌', '✗', '✘'])

/**
 * A line of help under the choices ("Space toggles · Enter confirms"). It is
 * part of the dialog box but not a choice, so it ends the list.
 */
const HINT = /(?:space|enter|esc|escape|tab|arrows?|↑|↓|press|use)\b[^.\n]{0,60}(?:toggle|select|confirm|choose|move|close|continue|exit|cancel)|(?:↑\/?↓|↑↓)/i

/**
 * Read one row as a possible choice.
 *
 * Decorations stack in either order (`❯ 1. Yes`, `1. ❯ Yes`, `[x] 2. Ship it`),
 * so they are peeled off one at a time rather than matched as one pattern.
 */
function classify (row) {
  const text = trimBorders(row)
  if (!text) return { option: false }
  let rest = text
  let cursor = false
  let checked = null
  let number = null

  for (let step = 0; step < 4; step += 1) {
    let match
    if (!cursor && (match = CURSOR.exec(rest))) {
      cursor = true
      rest = rest.slice(match[0].length)
      continue
    }
    if (checked === null && (match = RADIO.exec(rest))) {
      checked = CHOSEN.has(match[1]) ? true : EMPTY.has(match[1]) ? false : null
      rest = rest.slice(match[0].length)
      continue
    }
    if (checked === null && (match = CHECK.exec(rest))) {
      checked = CHOSEN.has(match[1]) ? true : EMPTY.has(match[1]) ? false : null
      rest = rest.slice(match[0].length)
      continue
    }
    if (checked === null && (match = BRACKET.exec(rest))) {
      checked = match[1].trim() !== ''
      rest = rest.slice(match[0].length)
      continue
    }
    if (number === null && (match = NUMBER.exec(rest))) {
      number = Number(match[1])
      rest = rest.slice(match[0].length)
      continue
    }
    break
  }

  const body = rest.trim()
  if (!body) return { option: false }
  const bullet = BULLET.test(rest)
  const decorated = cursor || checked !== null || number !== null
  // A plain line under a choice list is one of the choices (a two-row yes/no
  // list only marks the cursor on one of them), unless it is a help line.
  const hint = !decorated && HINT.test(text)
  return {
    option: decorated && !hint,
    plain: !decorated && !hint,
    hint,
    text: body,
    cursor,
    checked,
    number,
    bullet,
    decorated
  }
}

const NONE = { kind: 'none', question: '', options: [], multi: false, cursor: 1, strong: false }

/**
 * Find the dialog at the bottom of a screen.
 *
 * @param {string[]} rows   the visible rows, top to bottom
 * @param {object} [options]
 * @param {boolean} [options.boxIdle]  is an empty input box drawn right now?
 * @param {number} [options.maxBelow]  how many rows may follow the choices
 * @returns {{kind:'none'|'choice'|'yesno', question:string, options:Array,
 *   multi:boolean, cursor:number, strong:boolean}}
 */
function parse (rows, options = {}) {
  const list = (Array.isArray(rows) ? rows : []).map(trimBorders)
  const entries = list.map((row) => classify(row))
  const maxRows = options.maxRows ?? 8
  const windowStart = Math.max(0, entries.length - maxRows)

  // The list starts at the topmost decorated row near the bottom of the screen
  // (a cursor, a checkbox, or a number), and runs down through the plain rows
  // that belong to it. A help line ends it, and so does an empty row.
  let start = -1
  for (let index = windowStart; index < entries.length; index += 1) {
    if (entries[index].option && entries[index].decorated) {
      start = index
      break
    }
  }
  if (start < 0) {
    // A bare `(y/n)` question draws no choices at all.
    const tail = entries.slice(-4)
    const line = tail.map((entry) => entry.text).filter(Boolean).join(' ')
    if (/\(y\/n\)|\[y\/n\]|\(yes\/no\)/i.test(line)) {
      const question = tail.map((entry) => entry.text).find((text) => /\(y\/n\)|\[y\/n\]|\(yes\/no\)/i.test(text)) || ''
      return yesNo(question, false)
    }
    return NONE
  }

  let end = start
  while (end + 1 < entries.length && end - start + 1 < maxRows) {
    const next = entries[end + 1]
    if (next.hint) break
    if (!next.option && !next.plain) break
    end += 1
  }
  const block = entries.slice(start, end + 1)
  if (block.length < 2) return NONE
  // The choices and the question are the last thing drawn. A numbered list in
  // the conversation is not at the bottom, and has the prompt box under it.
  const below = entries.length - 1 - end
  if (below > (options.maxBelow ?? 4)) return NONE

  // An empty input box means the session is ready for a message, not asking a
  // question. Only a run with an unmistakable choice marker survives that.
  const marked = block.some((entry) => entry.cursor || entry.checked !== null)
  if (options.boxIdle && !marked) return NONE
  // A run of bare bullets is prose, whatever it looks like.
  if (block.every((entry) => entry.bullet && !entry.decorated)) return NONE
  // A run of ticked / unticked rows with nothing highlighted is the agent's own
  // markdown task list, not a question. A real multi-select marks the row a
  // person would be on with a cursor, so without one there is nothing to move
  // and nothing to confirm — and treating a checklist as a dialog escalated a
  // working session and held its nudges still.
  if (!block.some((entry) => entry.cursor) && block.some((entry) => entry.checked !== null)) return NONE

  // The question is the row above the choices. Prefer one that reads as a
  // question, but keep the nearest line as the title of a titled box.
  let question = ''
  for (let index = start - 1; index >= Math.max(0, start - 6); index -= 1) {
    if (entries[index].option) continue
    const row = list[index]
    if (!row || row.length < 2) continue
    question = row
    if (/\?\s*$|[:?]\s*$/.test(row)) break
  }

  const choices = block.map((entry, index) => ({
    index: index + 1,
    text: entry.text,
    cursor: entry.cursor,
    checked: entry.checked,
    number: entry.number
  }))
  if (choices.every((choice) => !choice.text)) return NONE
  const cursorIndex = choices.findIndex((choice) => choice.cursor)
  const yesno = /\(y\/n\)|\[y\/n\]|\(yes\/no\)/i.test(question) ||
    (choices.length === 2 && choices.every((choice) =>
      /^(?:yes|no|allow|deny|approve|reject|continue|cancel)\b/i.test(choice.text)))
  const multi = choices.some((choice) => choice.checked !== null) ||
    /(?:select|choose)\b[^.]*\b(?:all|multiple|any|one or more)\b|space\s*(?:to|bar)|checkbox/i.test(question)

  return {
    kind: yesno && !multi ? 'yesno' : 'choice',
    question,
    options: choices,
    multi,
    cursor: cursorIndex >= 0 ? cursorIndex + 1 : (choices[0].number || 1),
    marked,
    // Strong enough to act on without the input box being gone: a real cursor
    // or checkbox, or a title that is a question.
    strong: marked || /\?\s*$/.test(question)
  }
}

/** A `(y/n)` question with no rows at all: two choices, chosen by word. */
function yesNo (question, marked) {
  return {
    kind: 'yesno',
    question,
    options: [
      { index: 1, text: 'Yes', cursor: false, checked: null, number: null },
      { index: 2, text: 'No', cursor: false, checked: null, number: null }
    ],
    multi: false,
    cursor: 1,
    marked,
    strong: true
  }
}

/** `2`, `'2'`, `[2, 3]`, `'2,3'` -> `[2, 3]`. */
function normaliseChoices (value) {
  const raw = Array.isArray(value) ? value : String(value == null ? '' : value).split(/[,+\s]+/)
  const out = []
  for (const item of raw) {
    const number = Number(item)
    if (Number.isInteger(number) && number > 0 && !out.includes(number)) out.push(number)
  }
  return out
}

/** Move the highlight from `from` to `to` with the arrow keys. */
function moveKeys (from, to) {
  if (to === from) return ''
  const key = to > from ? '\u001b[B' : '\u001b[A'
  return key.repeat(Math.abs(to - from))
}

/**
 * The keystrokes that choose the given options, exactly as a person would:
 * arrows to the row, Enter to confirm; a space toggles a multi-select row.
 */
function keysFor (dialog, choices) {
  if (!dialog || dialog.kind === 'none') return null
  const wanted = normaliseChoices(choices)
    .filter((number) => number >= 1 && number <= dialog.options.length)
  if (wanted.length === 0) return null

  if (dialog.kind === 'yesno' && !dialog.marked) {
    const choice = dialog.options[wanted[0] - 1]
    const yes = !/^(?:no|deny|reject|cancel)\b/i.test(choice.text)
    return yes ? 'y\r' : 'n\r'
  }

  if (!dialog.multi) {
    const target = wanted[0]
    return `${moveKeys(dialog.cursor || 1, target)}\r`
  }

  // Multi-select: end up with exactly the chosen rows ticked, toggling only the
  // ones whose state is wrong, then confirm.
  let at = dialog.cursor || 1
  let keys = ''
  for (const option of dialog.options) {
    const want = wanted.includes(option.index)
    const have = option.checked === true
    if (want === have) continue
    keys += moveKeys(at, option.index)
    at = option.index
    keys += ' '
  }
  return `${keys}\r`
}

/** The option whose text matches, for "approve" / "deny" and named choices. */
function optionMatching (dialog, pattern) {
  if (!dialog || !dialog.options) return 0
  const match = dialog.options.find((option) => pattern.test(option.text))
  return match ? match.index : 0
}

/**
 * The keys for one queued answer. A choice is resolved against the dialog on
 * screen right now, so a number always means what the person is looking at;
 * plain keys (`\r`, `y\r`, `\u001b`) are passed through unchanged.
 */
function answerKeys (dialog, answer) {
  if (!answer) return null
  if (typeof answer.keys === 'string' && answer.keys) return answer.keys
  return keysFor(dialog, answer.choice)
}

/** One line for a log or a phone screen. */
function describe (dialog) {
  if (!dialog || dialog.kind === 'none') return ''
  const choices = dialog.options
    .map((option) => `${option.index}. ${option.text}${option.checked ? ' (on)' : ''}`)
    .join(' · ')
  return `${dialog.question || 'A question'} ${choices}`.replace(/\s+/g, ' ').trim()
}

module.exports = {
  NONE,
  parse,
  classify,
  keysFor,
  answerKeys,
  optionMatching,
  normaliseChoices,
  describe,
  trimBorders
}
