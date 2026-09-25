/**
 * Print a copy-paste probe that finds a SQUEEZED element by measurement, not by name.
 *
 * Three probes in a row failed to identify the settings dialog because each named something — a
 * class from the bundle, a role, an assumption about when it is open. This one starts from the
 * symptom instead: an element whose text wraps one character per line, which shows up as a tall
 * narrow box with many short text nodes. Whatever is being squeezed, it will be in this list.
 *
 * Usage: node scripts/console-probe.mjs
 */

const probe = `(() => {
  const narrowest = [];
  for (const el of document.querySelectorAll('*')) {
    const r = el.getBoundingClientRect();
    // Narrow but tall, and carrying a direct text child: the shape a wrapped label makes.
    if (r.width < 140 && r.height > 60) {
      const text = Array.from(el.childNodes)
        .filter((n) => n.nodeType === 3)
        .map((n) => n.textContent.trim())
        .join('')
        .trim();
      if (text.length >= 2) {
        const s = getComputedStyle(el);
        narrowest.push({
          tag: el.tagName.toLowerCase(),
          classes: String(el.className || '').slice(0, 36),
          text: text.slice(0, 20),
          size: Math.round(r.width) + 'x' + Math.round(r.height),
          at: Math.round(r.x) + ',' + Math.round(r.y),
          parentClasses: String(el.parentElement && el.parentElement.className || '').slice(0, 36),
          parentWidth: el.parentElement ? Math.round(el.parentElement.getBoundingClientRect().width) : null,
          display: s.display,
          writingMode: s.writingMode,
          width: s.width,
          overflowWrap: s.overflowWrap,
          wordBreak: s.wordBreak,
        });
      }
    }
  }

  // The nearest scrollable or clipped ancestor of the first hit, which is usually what squeezed it.
  const chain = [];
  const first = narrowest[0];
  if (first) {
    let el = document.querySelector('.' + String(first.classes).split(' ')[0]);
    let depth = 0;
    while (el && depth < 8) {
      const r = el.getBoundingClientRect();
      const s = getComputedStyle(el);
      chain.push({
        depth,
        classes: String(el.className || '').slice(0, 34),
        width: Math.round(r.width),
        display: s.display,
        maxWidth: s.maxWidth,
        overflow: s.overflow,
        position: s.position,
      });
      el = el.parentElement;
      depth += 1;
    }
  }

  return JSON.stringify({
    viewport: innerWidth + 'x' + innerHeight,
    squeezedCount: narrowest.length,
    squeezed: narrowest.slice(0, 8),
    squeezeChain: chain,
  }, null, 1);
})()`

process.stdout.write('With the squeezed strip on screen, paste this into the console (F12):\n\n')
process.stdout.write(`${probe}\n`)
