/**
 * A package's preview thumbnail, shared by the settings page's two columns.
 *
 * The projects page renders one from a REGISTERED project's manifest; the installed-package column
 * renders one from the same `dsh.uiProject.preview` field, read by the host off disk (step 56a). They
 * are the same picture described by the same string, so they have to be drawn by the same code: "is
 * this an image path or a CSS background", and "what does a screen reader call it", are one question
 * each, and a second copy is how the two columns would come to disagree about a package that declares
 * the same thing in both places.
 *
 * The markup and the classes are unchanged from the projects page's own version — including the glass
 * layer, which is what makes a gradient read as a *material* rather than as a swatch — because the
 * stylesheet's `.uip-preview*` rules are shared and the two call sites must produce what those rules
 * were written for.
 */

/**
 * Which of three states a declared preview string is in.
 *
 *   `image`     a URL or path the page can fetch
 *   `gradient`  a CSS value to paint as a background
 *   `none`      nothing declared, or an empty string
 *
 * Exported because the installed-package column has to make the SAME decision twice for one row —
 * once to mark the row (`data-uip-preview`, which the stylesheet keys the layout off) and once to
 * decide whether to render a preview at all. A second regex there would be a second answer to one
 * question, which is the class of defect this file exists to remove.
 * @param {unknown} preview
 * @returns {'image'|'gradient'|'none'}
 */
export function previewKindOf(preview) {
  if (typeof preview !== 'string' || preview.length === 0) return 'none'
  return /^(https?:|\.|\/)/.test(preview) ? 'image' : 'gradient'
}

/**
 * Preview thumbnail. A project may ship an image path; otherwise its `preview` string is used as a
 * CSS background and a labelled swatch is generated, so every project gets a visual without shipping
 * binary assets.
 *
 * `project` is duck-typed on the three fields this needs (`preview`, `previewLabel`, `name`) rather
 * than on a project object, so the installed-package column can hand it the same three facts it read
 * from a `package.json` without inventing a registration to do it. `t` only ever needs `previewAlt`,
 * which both dictionaries carry.
 * @param {{ R: any, project: { preview?: unknown, previewLabel?: unknown, name?: string }, t: any }} input
 * @returns {any} a React element
 */
export function createPreview(input) {
  const { R, project, t } = input
  const alt = project.previewLabel ?? t.previewAlt(project.name)

  if (previewKindOf(project.preview) === 'image') {
    return R.createElement(
      'div',
      { className: 'uip-preview', key: 'preview' },
      R.createElement('img', { className: 'uip-previewImage', src: project.preview, alt, loading: 'lazy' }),
    )
  }

  const style = typeof project.preview === 'string' ? { background: project.preview } : undefined
  return R.createElement(
    'div',
    { className: 'uip-preview', key: 'preview', style, role: 'img', 'aria-label': alt },
    R.createElement('span', { className: 'uip-previewGlass', 'aria-hidden': 'true' }),
  )
}
