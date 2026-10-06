/**
 * The mapping between the framework's built-in copy of Glass and the package it came from.
 *
 * ONE DEFINITION, TWO READERS. `scripts/check-builtin.test.mjs` asserts against this map and
 * `scripts/sync-builtin.mjs` acts on it, because the failure this file exists to prevent is exactly a
 * second copy of the mapping: two lists that agree on the day they are written and diverge quietly
 * afterwards. Adding a file to the built-in means adding a row HERE, and both readers see it.
 *
 * WHAT A ROW SAYS. `[label, inFramework, inPackage, mode]`, where the mode is how the two files are
 * supposed to relate — and, for the writer, whether it may touch the framework's copy at all:
 *
 *   `raw`     the same bytes, copied verbatim. A diff is a divergence, and `--write` copies theirs over.
 *   `marker`  the same bytes once the project marker is substituted (the ids differ by design), so a diff
 *             is a divergence and `--write` re-copies and re-substitutes.
 *   `sheets`  a `.js` file that CONTAINS the CSS rather than being it: the four overlay sheets inside it
 *             are compared, marker-normalized. `--write` may only re-substitute the marker in place — it
 *             must never copy the package's file over this one, because the surrounding module is not the
 *             package's (its head, its tail and its requires were rewritten for the framework).
 *   `none`    deliberately different, and compared for existence and mojibake only. `--write` refuses
 *             these outright: `skin.js` calls the overlay from `apply`/`cleanup`, and the manifest's id,
 *             name, package and version say something different here on purpose.
 */

/** Names the skin package for both readers. A path this repository cannot derive: the two are not siblings. */
export const SKIN_PACKAGE_ENV = 'DSH_SKIN_PACKAGE'

/** Every file the two trees share. Add a row here when the built-in gains one. */
export const BUILT_IN_MAP = [
  ['skin.js', 'src/client/skins/glass/skin.js', 'src/client/projects/liquid-glass/skin.js', 'none'],
  ['tokens.css', 'src/client/skins/glass/tokens.css', 'src/client/projects/liquid-glass/tokens.css', 'raw'],
  ['glass.css', 'src/client/skins/glass/glass.css', 'src/client/projects/liquid-glass/glass.css', 'raw'],
  ['overlay.js', 'src/client/skins/glass/overlay.js', 'src/client/index.js', 'sheets'],
  ['manifest.js', 'src/client/skins/glass/manifest.js', 'src/client/manifest.generated.js', 'none'],
  ['boot.css', 'src/host/skins/glass/boot.css', 'src/host/boot.css', 'marker'],
]

/**
 * The directories whose CONTENTS are asserted, so a whole new file cannot slip in unnoticed.
 *
 * The map above only covers files both sides already have, which is the one drift it cannot see: a sheet
 * added here and forgotten there. Each entry is `[which root, directory relative to it, its files, sorted]`
 * — and the root is named rather than implied, because a directory that exists in one repository and not
 * the other is not a failure to report twice: the first version of this list said only the path, and the
 * reader dutifully looked for the framework's tree inside the package.
 */
export const BUILT_IN_TREES = [
  ['framework', 'src/client/skins/glass', 'glass.css,manifest.js,overlay.js,skin.js,tokens.css'],
  ['package', 'src/client/projects/liquid-glass', 'glass.css,skin.js,tokens.css'],
]

/** The package's marker, which every generated selector in its copy carries. */
export const PACKAGE_MARKER = 'data-ui-project-liquid-glass'
/** The built-in's own, substituted for the one above. */
export const BUILT_IN_MARKER = 'data-ui-project-glass'

/** The package's text as the built-in's copy should read. */
export function normalizeMarker(/** @type {string} */ text) {
  return text.split(PACKAGE_MARKER).join(BUILT_IN_MARKER)
}

/**
 * How many characters in `text` are the wreckage of an encoding accident.
 *
 * The trap this counts is recorded in `docs/known-issues.md` section 2: a PowerShell 5.1 read-replace-write
 * round trip decodes a BOM-less UTF-8 file as ANSI, mangles every em dash, and loses a byte at some places
 * — which is why the writer refuses to save a file whose count is not zero, rather than repairing it.
 */
export function mojibakeCount(/** @type {string} */ text) {
  const replacements = text.match(/\uFFFD/g) ?? []
  const cjk = text.match(/[\u9000-\u9fff]/g) ?? []
  return replacements.length + cjk.length
}

/** The four overlay sheets, extracted from the `.js` file that carries them. */
export function overlaySheets(/** @type {string} */ text) {
  return Object.fromEntries(
    [...text.matchAll(/const (OVERLAY_[A-Z]+) = `([\s\S]*?)`/g)].map((match) => [match[1], match[2]]),
  )
}
