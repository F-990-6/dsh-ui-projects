/**
 * The fake DOM this suite runs the browser half against.
 *
 * Extracted from `verify.mjs` unchanged, so that `load-check.mjs` can build a REAL runtime over the
 * same document the suite already uses. The alternative was a second, drifting copy of a matcher
 * whose entire purpose is to fail loudly on a selector form it does not implement.
 *
 * IT IS A MOVE, NOT A REWRITE. Every function body below is byte for byte what `verify.mjs` held,
 * and the extraction commit carries the comparison that proves it. The one addition is the sandbox
 * seam: `createElement`'s `clientHeight` reads the suite's sandbox as a module-level binding, and a
 * moved function cannot close over a binding it no longer shares — so the binding lives here and is
 * handed over by whoever owns the sandbox. Nothing else changed, including the fact that reading it
 * before a sandbox exists yields 0 rather than throwing.
 */

/**
 * The sandbox the fake elements read, handed over by the owner of the real one.
 *
 * Assigned once, right after the bundle is loaded, and never reassigned — which is why a single
 * call is enough and why the property reads below always see the live object.
 * @type {Record<string, any>}
 */
let sandbox = {}

/** @param {Record<string, any>} next */
export function setSandbox(next) {
  sandbox = next
}

/**
 * Compile a simple selector into a predicate.
 *
 * Handles `tag`, `#id`, `.class`, `[attr]` and `[attr="value"]`, in any combination, and throws
 * for everything else. Throwing is the point: a harness matcher that silently returned nothing
 * for an unsupported form would hide exactly the bug class it is here to catch.
 * @param {string} selector
 * @returns {(element: any) => boolean}
 */
export function parseCompound(selector) {
  const text = String(selector).trim()
  if (text === '' || /[\s>,+~]/.test(text)) {
    throw new Error(`the fake DOM cannot match a complex selector: ${JSON.stringify(selector)}`)
  }
  /** @type {((element: any) => boolean)[]} */
  const tests = []
  let rest = text
  const tag = /^[a-zA-Z][\w-]*/.exec(rest)
  if (tag !== null) {
    const wanted = tag[0].toUpperCase()
    tests.push((element) => element.tagName === wanted)
    rest = rest.slice(tag[0].length)
  }
  while (rest.length > 0) {
    const id = /^#([\w-]+)/.exec(rest)
    if (id !== null) {
      const wanted = id[1]
      tests.push((element) => element.id === wanted)
      rest = rest.slice(id[0].length)
      continue
    }
    const cls = /^\.([\w-]+)/.exec(rest)
    if (cls !== null) {
      const wanted = cls[1]
      tests.push((element) => String(element.className).split(/\s+/).includes(wanted))
      rest = rest.slice(cls[0].length)
      continue
    }
    const attr = /^\[([\w-]+)(?:=["']?([^"'\]]*)["']?)?\]/.exec(rest)
    if (attr !== null) {
      const name = attr[1]
      const value = attr[2]
      tests.push((element) =>
        value === undefined ? element.hasAttribute(name) : element.getAttribute(name) === value,
      )
      rest = rest.slice(attr[0].length)
      continue
    }
    throw new Error(`the fake DOM cannot match part of a selector: ${JSON.stringify(rest)} of ${JSON.stringify(selector)}`)
  }
  if (tests.length === 0) throw new Error(`empty selector: ${JSON.stringify(selector)}`)
  return (element) => tests.every((test) => test(element))
}

/**
 * Would this selector match this element, allowing for a marker ancestor?
 *
 * The scoper's output is always `<marker> <authored selector>`, so the form that has to be
 * checkable is "a compound matching an ancestor, then a compound matching the element". A real CSS
 * engine would do far more; this does exactly enough to answer the question the tests ask, and
 * still refuses anything else rather than guessing.
 * @param {string} selector
 * @param {any} element
 * @returns {boolean}
 */
export function matchesWithAncestors(selector, element) {
  const parts = String(selector).trim().split(/\s+/)
  if (parts.length === 1) {
    try {
      return parseCompound(parts[0])(element)
    } catch {
      return false
    }
  }
  if (parts.length !== 2) return false
  let ancestor = element.parentNode
  while (ancestor !== null && ancestor !== undefined) {
    if (parseCompound(parts[0])(ancestor) && parseCompound(parts[1])(element)) return true
    ancestor = ancestor.parentNode
  }
  return false
}

/** @param {string} tagName */
export function createElement(tagName) {
  /** @type {Map<string, string>} */
  const attributes = new Map()
  /** @type {any} */
  const element = {
    tagName: String(tagName).toUpperCase(),
    id: '',
    className: '',
    textContent: '',
    /**
     * A style declaration that stores what the runtime writes.
     *
     * The opacity control works by setting a custom property and reading it back, so a fake
     * that silently dropped writes would make that whole path untestable — and the code
     * under test is precisely the code that needs testing.
     */
    style: {
      /** @type {Map<string, string>} */
      properties: new Map(),
      /** @param {string} name @param {string} value */
      setProperty(name, value) {
        this.properties.set(name, String(value))
      },
      /** @param {string} name */
      removeProperty(name) {
        this.properties.delete(name)
      },
      /** @param {string} name */
      getPropertyValue(name) {
        return this.properties.get(name) ?? ''
      },
    },
    parentNode: /** @type {any} */ (null),
    children: /** @type {any[]} */ ([]),
    removed: false,
    getAttribute: (/** @type {string} */ name) => (attributes.has(name) ? attributes.get(name) : null),
    setAttribute: (/** @type {string} */ name, /** @type {unknown} */ value) => {
      attributes.set(name, String(value))
    },
    removeAttribute: (/** @type {string} */ name) => {
      attributes.delete(name)
    },
    hasAttribute: (/** @type {string} */ name) => attributes.has(name),
    /**
     * The first descendant matching a selector, for the selector forms this package uses.
     *
     * A deliberately narrow matcher rather than a CSS engine — but it FAILS LOUDLY on a form it
     * does not implement rather than quietly matching nothing, because a selector quietly
     * matching nothing is the exact failure this whole package has been chasing.
     * @param {string} selector
     * @returns {any | null}
     */
    querySelector: (selector) => element.querySelectorAll(selector)[0] ?? null,
    /**
     * A box, because the runtime tells a column from a container by whether the element
     * actually occupies the grid. A fake DOM has no layout, so the box is declared:
     * everything is a real box unless it is marked as the overlay or the handle.
     * @returns {{ x: number, y: number, width: number, height: number }}
     */
    getBoundingClientRect: () => {
      const overlay = attributes.has('data-test-overlay')
      return overlay ? { x: 0, y: 0, width: 0, height: 0 } : { x: 0, y: 0, width: 120, height: 600 }
    },
    /**
     * The container's content height, which the runtime compares against the viewport to decide
     * whether the boot page is in the way. Declared rather than computed, so a test can put the
     * container into the oversized state on purpose.
     * @type {number}
     */
    scrollHeight: 0,
    /** The viewport height, which `boot()` sets on the fake `window`. */
    get clientHeight() {
      return sandbox.window?.innerHeight ?? 0
    },
    /**
     * Every descendant matching a selector, depth first.
     *
     * Supports the forms this package actually uses — a tag name, and any combination of tag,
     * `#id`, `.class`, `[attr]` and `[attr="value"]` — and THROWS on anything else. A matcher
     * that quietly returned nothing for an unimplemented form would reproduce, inside the test
     * harness, the same silent-no-match class of bug the harness exists to catch.
     * @param {string} selector
     */
    querySelectorAll: (selector) => {
      const compound = parseCompound(selector)
      const found = []
      const walk = (/** @type {any} */ node) => {
        for (const child of node.children) {
          if (compound(child)) found.push(child)
          walk(child)
        }
      }
      walk(element)
      return found
    },
    remove() {
      element.removed = true
      if (element.parentNode !== null) {
        const index = element.parentNode.children.indexOf(element)
        if (index >= 0) element.parentNode.children.splice(index, 1)
      }
    },
    /** @param {any} child */
    appendChild(child) {
      child.parentNode = element
      element.children.push(child)
      return child
    },
    /** @param {any} child */
    insertBefore(child) {
      child.parentNode = element
      element.children.unshift(child)
      return child
    },
    /**
     * Remove a child.
     *
     * Needed because a re-render is exactly "the shell replaces the frame's children", and a
     * harness that cannot express that cannot test the repair of it.
     * @param {any} child
     */
    removeChild(child) {
      const index = element.children.indexOf(child)
      if (index >= 0) element.children.splice(index, 1)
      child.parentNode = null
      return child
    },
  }
  return element
}

export function createFakeDom() {
  const root = createElement('html')
  const head = createElement('head')
  const body = createElement('body')
  root.appendChild(head)
  root.appendChild(body)
  const document = {
    documentElement: root,
    head,
    body,
    createElement,
    getElementById: (/** @type {string} */ id) => {
      const found = root.querySelectorAll('div').find((el) => el.id === id)
      return found ?? (root.id === id ? root : null)
    },
    /**
     * Document-level queries, which the diagnostics uses.
     *
     * Delegated to the document element, because on a real page `document.querySelectorAll` walks
     * the whole tree exactly as `documentElement.querySelectorAll` does — minus the root element
     * itself, which is the same behaviour the real one has for a descendant combinator.
     * @param {string} selector
     */
    querySelectorAll: (selector) => root.querySelectorAll(selector),
    /** @param {string} selector */
    querySelector: (selector) => root.querySelector(selector),
  }
  return {
    document,
    root,
    head,
    body,
    /** @returns {any[]} */
    styles: () => head.children.filter((child) => child.tagName === 'STYLE'),
    allCss: () => head.children.map((child) => child.textContent).join('\n'),
    /**
     * The ambient field, wherever it was placed.
     *
     * Deliberately a search rather than a direct-child lookup: the layer belongs INSIDE the
     * application's floating layer, not under `<body>`. Hanging it off the body is what made
     * the shell's own sidebar measurement collapse the sidebar to a rail whenever the skin
     * was on, so the placement is part of the behaviour under test.
     * @returns {any[]}
     */
    ambient: () =>
      [body, ...body.querySelectorAll('div')].filter(
        (element) => element.className === 'ds-ambient ui-ambient-layer',
      ),
    /**
     * Put the application frame into the document, as the shell does when it finishes booting.
     *
     * Assigned by `boot`, which owns the stub: the fake DOM factory deliberately knows nothing
     * about the frame, so that a test can control exactly when it appears.
     * @type {() => any}
     */
    mountFrame: () => {
      throw new Error('boot() has not assigned mountFrame')
    },
  }
}

export function createStorage() {
  /** @type {Map<string, string>} */
  const map = new Map()
  return {
    map,
    getItem: (/** @type {string} */ key) => (map.has(key) ? map.get(key) : null),
    setItem: (/** @type {string} */ key, /** @type {unknown} */ value) => {
      map.set(key, String(value))
    },
    removeItem: (/** @type {string} */ key) => {
      map.delete(key)
    },
  }
}

/**
 * A `MutationObserver` the harness can drive.
 *
 * The runtime marks its columns in response to the DOM changing — the shell mounting the
 * application IS that mutation — so a fake that never fires would leave the path untested,
 * and one that fired eagerly would test nothing. This records its callbacks and exposes
 * `flushAll()` so a test can say "the DOM just changed" at the moment it means.
 */
export class FakeMutationObserver {
  /** @param {() => void} callback */
  constructor(callback) {
    this.callback = callback
    this.callbacks = [callback]
    FakeMutationObserver.instances.push(this)
  }

  observe() {
    this.callbacks = [this.callback]
  }

  disconnect() {
    this.callbacks = []
  }

  flush() {
    for (const callback of [...this.callbacks]) callback()
  }

  static instances = []

  static reset() {
    FakeMutationObserver.instances = []
  }

  static flushAll() {
    for (const instance of [...FakeMutationObserver.instances]) instance.flush()
  }
}

/**
 * A `getComputedStyle` that answers the one question this package asks of it.
 *
 * The runtime identifies the application frame by asking the DOM what it is — a grid
 * with a multi-track template and more than one child — rather than by naming a
 * CSS-module class, so the harness has to be able to answer that. Everything else
 * reports empty values, which is honest: this fake DOM has no layout engine.
 * @param {ReturnType<typeof createFakeDom>} dom
 * @returns {(el: any) => any}
 */
export function wrapGetComputedStyle(dom) {
  const empty = {
    display: 'block',
    gridTemplateColumns: 'none',
    backgroundColor: 'rgba(0, 0, 0, 0)',
    backdropFilter: 'none',
    getPropertyValue: () => '',
  }
  return (element) => {
    if (element === undefined || element === null) return empty
    // Only the element explicitly marked as the frame reports as one. Deriving it from
    // "has more than one child" made the mount point itself look like a frame, which is
    // a harness fiction rather than a property of the shipped markup.
    const isFrame = element.hasAttribute?.('data-test-frame') === true
    return {
      ...empty,
      display: isFrame ? 'grid' : 'block',
      gridTemplateColumns: isFrame ? '280px 1fr 0px' : 'none',
      // The overlay layer is absolutely positioned, which is how the runtime tells a
      // container apart from a column.
      position: element.getAttribute?.('data-test-overlay') === '' ? 'absolute' : 'static',
    }
  }
}
