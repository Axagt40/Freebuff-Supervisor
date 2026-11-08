'use strict'

const test = require('node:test')
const assert = require('node:assert')
const dialog = require('../src/dialog')

/**
 * The screen a TUI draws for a question: a box with a title and one row per
 * choice, the highlighted one carrying a cursor. This is the shape that used
 * to be invisible to the supervisor — it typed `y` at it and nothing happened.
 */
const SINGLE = [
  '╭──────────────────────────────╮',
  '│ Which option should run?      │',
  '│ ❯ 1. First                    │',
  '│   2. Second                   │',
  '│   3. Third                    │',
  '╰──────────────────────────────╯'
]

const MULTI = [
  '╭──────────────────────────────╮',
  '│ Select the parts to clean?    │',
  '│ ❯ [ ] Alpha                   │',
  '│   [x] Beta                    │',
  '│   [ ] Gamma                   │',
  '│ Space toggles · Enter confirms │'
]

test('a boxed list of choices is read as a dialog with a question', () => {
  const parsed = dialog.parse(SINGLE)
  assert.equal(parsed.kind, 'choice')
  assert.equal(parsed.question, 'Which option should run?')
  assert.deepEqual(parsed.options.map((option) => option.text), ['First', 'Second', 'Third'])
  assert.equal(parsed.cursor, 1)
  assert.equal(parsed.multi, false)
  assert.equal(parsed.strong, true)
})

test('choosing an option moves the highlight and confirms, like a person', () => {
  const parsed = dialog.parse(SINGLE)
  assert.equal(dialog.keysFor(parsed, [1]), '\r')
  assert.equal(dialog.keysFor(parsed, [3]), '\u001b[B\u001b[B\r')
  // A number the dialog does not offer is not typed as a stray key.
  assert.equal(dialog.keysFor(parsed, [9]), null)
})

test('a choice is resolved against the dialog the person is looking at', () => {
  const parsed = dialog.parse(SINGLE)
  assert.equal(dialog.answerKeys(parsed, { choice: [2] }), '\u001b[B\r')
  assert.equal(dialog.answerKeys(parsed, { keys: 'y\r' }), 'y\r')
  assert.equal(dialog.answerKeys(null, { keys: '\u001b' }), '\u001b')
  assert.equal(dialog.answerKeys(null, { choice: [2] }), null)
})

test('a multi-select question toggles exactly the chosen rows', () => {
  const parsed = dialog.parse(MULTI)
  assert.equal(parsed.multi, true)
  assert.equal(parsed.question, 'Select the parts to clean?')
  // Exactly these two rows on: Alpha toggles on, Beta (already on but not
  // chosen) toggles off, Gamma toggles on, then Enter confirms.
  assert.equal(dialog.keysFor(parsed, [1, 3]), ' \u001b[B \u001b[B \r')
  // Choosing only the row that is already ticked sends no toggles at all.
  assert.equal(dialog.keysFor(parsed, [2]), '\r')
})

test('ordinary numbered prose is not a question', () => {
  // The same rows in the conversation, with the prompt box still drawn below
  // them, are the agent writing a list — not a dialog to answer.
  const prose = [
    'Here is what I did:',
    '1. Read the config',
    '2. Updated the handler',
    '│ ▍Enter a coding task or / for commands │'
  ]
  const parsed = dialog.parse(prose, { boxIdle: true })
  assert.equal(parsed.kind, 'none')

  // Out of the bottom of the screen it is prose too, however it is shaped.
  const scrolled = [
    '❯ 1. First',
    '  2. Second',
    '  3. Third',
    ...Array.from({ length: 8 }, (_, index) => `later line ${index + 1}`)
  ]
  assert.equal(dialog.parse(scrolled).kind, 'none')
})

test("the agent's own checklist is not a question", () => {
  // Agents write markdown task lists as they work. Ticked rows with nothing
  // highlighted used to read as a multi-select dialog, which escalated a
  // working session and held its nudges still.
  const rows = [
    'Progress so far:',
    '☐ refactor the parser',
    '☑ add tests'
  ]
  assert.equal(dialog.parse(rows).kind, 'none')

  // A real multi-select marks the row a person is on.
  assert.equal(dialog.parse(MULTI).kind, 'choice')
})

test('a yes/no screen is answered with the word freebuff expects', () => {
  const rows = [
    '┌────────────────────────────────┐',
    '│ Allow the agent to write files? (y/n) │',
    '└────────────────────────────────┘'
  ]
  const parsed = dialog.parse(rows)
  assert.equal(parsed.kind, 'yesno')
  assert.equal(dialog.keysFor(parsed, [1]), 'y\r')
})

test('yes/no choices drawn as a list are chosen by row, not by letter', () => {
  const rows = [
    '│ Continue this path?           │',
    '│ ❯ Yes                         │',
    '│   No                          │'
  ]
  const parsed = dialog.parse(rows)
  assert.equal(parsed.kind, 'yesno')
  assert.equal(dialog.keysFor(parsed, [2]), '\u001b[B\r')
})

test('choosing by name finds the row that means it', () => {
  const parsed = dialog.parse(SINGLE)
  assert.equal(dialog.optionMatching(parsed, /^sec/i), 2)
  assert.equal(dialog.optionMatching(parsed, /^nope/i), 0)
})

test('choice numbers are read from anything a person says', () => {
  assert.deepEqual(dialog.normaliseChoices(2), [2])
  assert.deepEqual(dialog.normaliseChoices('1,3'), [1, 3])
  assert.deepEqual(dialog.normaliseChoices([3, 3, '2']), [3, 2])
  assert.deepEqual(dialog.normaliseChoices('none'), [])
})

test('a dialog reads as one spoken line', () => {
  const parsed = dialog.parse(MULTI)
  assert.match(dialog.describe(parsed), /Select the parts to clean\? 1\. Alpha · 2\. Beta \(on\) · 3\. Gamma/)
})
