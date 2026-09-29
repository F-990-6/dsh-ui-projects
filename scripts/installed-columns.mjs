/**
 * The name column of `check-installed.mjs`'s report: one width per section, decided by what is in it.
 *
 * WHY THIS IS A MODULE OF ITS OWN. The report is printed by a script that cannot be imported — it scans a
 * profile at the top level and calls `process.exit` — so no test can render one of its rows by running it,
 * and the alternative (spawning it and capturing a pipe) is not available where this project's tooling
 * runs. The width rule and the padding live here instead, where the suite can hold them to the property
 * they exist for:
 *
 *   **the second column of a section begins at the same offset in every row of that section, whatever the
 *   longest name in it is.**
 *
 * A CONSTANT WIDTH DOES NOT HAVE THAT PROPERTY. `padEnd` pads and never truncates, so a name longer than
 * the column runs straight into the field after it: `@xjl-resources/dsh-plugin-example-dialog` is 40
 * characters and printed as `…-dialog1.0.0`, and `@xjl-resources/dsh-plugin-liquid-glass` is 38 and printed
 * as `…liquid-glassno findings`. Both were seen on a real profile (recorded in `docs/phase2-scope.md`,
 * group B item 1), so the width has to be a fact about the section being printed rather than a number
 * chosen once.
 */

/**
 * The narrowest the name column may be.
 *
 * A FLOOR, not the width: a section of short names keeps the layout it has always had — the fix for a long
 * name must not buy alignment with blank space that no row needs.
 */
export const NAME_COLUMN_FLOOR = 34

/**
 * How wide the name column of one section is.
 *
 * @param {string[]} cells every name that lands in that column, across the section
 * @returns {number}
 */
export function nameColumnWidth(cells) {
  let longest = 0
  for (const cell of cells) {
    if (typeof cell !== 'string') throw new TypeError(`nameColumnWidth expects names, got ${typeof cell}`)
    if (cell.length > longest) longest = cell.length
  }
  /*
   * One space of separation, so a cell as wide as the column still cannot touch the field after it: the
   * columns that follow a name column start immediately after it and carry their own trailing pad, which is
   * where the visible gap between the OTHER columns comes from.
   */
  return Math.max(NAME_COLUMN_FLOOR, longest + 1)
}

/**
 * Pad one cell to a column's width, or leave it alone when it is already wider.
 * @param {unknown} text
 * @param {number} width
 * @returns {string}
 */
export function pad(text, width) {
  return String(text).padEnd(width)
}
