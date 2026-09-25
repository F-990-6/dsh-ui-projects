/**
 * Bracket-balance an ES module by tokenizing it, not by counting characters.
 *
 * Counting `{` and `}` naively is useless on a file full of CSS in template literals,
 * regexes and comments — every one of them produces a false signal. This walks the source
 * with a small state machine that skips comments, string literals, template literals and
 * regular-expression literals, so the balance it reports is the code's, not the text's.
 *
 * Usage: node scripts/balance-check.mjs [file]
 */
import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'

const path = resolve(process.argv[2] ?? 'scripts/verify.mjs')
const source = await readFile(path, 'utf8')

/** @type {{ char: string, line: number }[]} */
const stack = []
const open = { '{': '}', '(': ')', '[': ']' }
const close = { '}': '{', ')': '(', ']': '[' }
let line = 1
let index = 0
/** Template-literal nesting: each entry remembers how many `${` are open. */
const templates = []
/** What the previous significant token was, to tell a regex from a division. */
let previous = ''

const problems = []

while (index < source.length) {
  const char = source[index]
  const next = source[index + 1]
  if (char === '\n') {
    line += 1
    index += 1
    continue
  }

  // Comments
  if (char === '/' && next === '/') {
    while (index < source.length && source[index] !== '\n') index += 1
    continue
  }
  if (char === '/' && next === '*') {
    index += 2
    while (index < source.length && !(source[index] === '*' && source[index + 1] === '/')) {
      if (source[index] === '\n') line += 1
      index += 1
    }
    index += 2
    continue
  }

  // A regex literal can only start where a value cannot precede it.
  if (char === '/' && !/[\w$)\]]/.test(previous)) {
    let cursor = index + 1
    let inClass = false
    let closed = false
    while (cursor < source.length) {
      const c = source[cursor]
      if (c === '\\') {
        cursor += 2
        continue
      }
      if (c === '\n') break
      if (c === '[') inClass = true
      else if (c === ']') inClass = false
      else if (c === '/' && !inClass) {
        closed = true
        break
      }
      cursor += 1
    }
    if (closed) {
      index = cursor + 1
      previous = 'regex'
      continue
    }
  }

  // String literals
  if (char === '"' || char === "'") {
    const quote = char
    index += 1
    while (index < source.length && source[index] !== quote) {
      if (source[index] === '\\') index += 1
      else if (source[index] === '\n') line += 1
      index += 1
    }
    index += 1
    previous = 'string'
    continue
  }

  // Template literals, including nested `${ ... }`
  if (char === '`') {
    index += 1
    let depth = 0
    while (index < source.length) {
      const c = source[index]
      if (c === '\\') {
        index += 2
        continue
      }
      if (c === '\n') line += 1
      if (c === '`' && depth === 0) {
        index += 1
        break
      }
      if (c === '$' && source[index + 1] === '{') {
        depth += 1
        index += 2
        continue
      }
      if (c === '}' && depth > 0) {
        depth -= 1
        index += 1
        continue
      }
      index += 1
    }
    previous = 'template'
    continue
  }

  if (open[char] !== undefined) {
    stack.push({ char, line })
    previous = char
    index += 1
    continue
  }
  if (close[char] !== undefined) {
    const top = stack.pop()
    if (top === undefined) problems.push(`line ${line}: stray "${char}"`)
    else if (top.char !== close[char]) {
      problems.push(`line ${line}: "${char}" closes "${top.char}" opened on line ${top.line}`)
    }
    previous = char
    index += 1
    continue
  }

  if (!/\s/.test(char)) previous = char
  index += 1
}

for (const entry of stack) problems.push(`line ${entry.line}: "${entry.char}" is never closed`)

if (problems.length === 0) {
  process.stdout.write(`${path}: balanced\n`)
} else {
  process.stdout.write(`${path}: ${problems.length} problem(s)\n`)
  for (const problem of problems.slice(-12)) process.stdout.write(`  ${problem}\n`)
  process.exitCode = 1
}
void templates
