// Minimal DOM helpers. No framework, no build step.

/**
 * el('div.card', {title: 'x'}, child, child, ...)
 * The tag accepts `tag.class.class` and `tag#id` shorthand.
 */
export function el(spec, attrs, ...children) {
  const [head, ...classes] = spec.split('.');
  const [tag, id] = head.split('#');
  const node = document.createElement(tag || 'div');
  if (id) node.id = id;
  if (classes.length) node.className = classes.join(' ');

  if (attrs && (typeof attrs !== 'object' || attrs instanceof Node || Array.isArray(attrs))) {
    children.unshift(attrs);
    attrs = null;
  }
  for (const [k, v] of Object.entries(attrs ?? {})) {
    if (v === null || v === undefined || v === false) continue;
    if (k.startsWith('on') && typeof v === 'function') node.addEventListener(k.slice(2), v);
    else if (k === 'class') node.className = [node.className, v].filter(Boolean).join(' ');
    else if (k in node && k !== 'list' && k !== 'form') node[k] = v;
    else node.setAttribute(k, v);
  }
  append(node, children);
  return node;
}

function append(node, children) {
  for (const c of children.flat(Infinity)) {
    if (c === null || c === undefined || c === false) continue;
    node.append(c instanceof Node ? c : document.createTextNode(String(c)));
  }
}

/** A labelled group box, the web equivalent of the vendor app's TGroupBox. */
export function group(title, ...children) {
  return el('section.group', el('h3.group-title', title), el('div.group-body', ...children));
}

export function hex(v, width = 2) {
  return `0x${v.toString(16).toUpperCase().padStart(width, '0')}`;
}

/** Parse "0x1f", "1F" or "31" into a byte, or null if it is not a byte. */
export function parseByte(text) {
  const t = text.trim();
  if (!t) return null;
  const v = /^0x/i.test(t) ? parseInt(t.slice(2), 16) : parseInt(t, 16);
  return Number.isInteger(v) && v >= 0 && v <= 0xff ? v : null;
}
