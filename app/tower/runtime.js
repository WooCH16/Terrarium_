'use strict';
/**
 * Tiny template runtime for the Terrarium screen.
 *
 * The screen was designed as a "design component": HTML markup with {{holes}},
 * <sc-for> loops and <sc-if> branches, driven by a logic class whose
 * renderVals() returns the values. This file renders that markup with React so
 * the markup in index.html and the logic in app.js stay exactly as designed.
 *
 * Supported (only what the screen uses):
 *   {{ a.b.c }}                 dotted lookup; {{ true }} / {{ false }} literals
 *   attr="{{ x }}"              raw value (function, number, ref…)
 *   attr="a {{x}} b"            interpolated string
 *   <sc-for list="{{xs}}" as="x">…</sc-for>   ($index is in scope)
 *   <sc-if value="{{cond}}">…</sc-if>
 *   style="…"                   parsed into a React style object
 *   on* attributes              bound as React event handlers
 */
(function () {
  const h = React.createElement;

  const EVENTS = {
    onclick: 'onClick', ondoubleclick: 'onDoubleClick', onchange: 'onChange', onkeydown: 'onKeyDown',
    onpointerdown: 'onPointerDown', onpointermove: 'onPointerMove', onpointerup: 'onPointerUp',
    onpointercancel: 'onPointerCancel',
  };
  const RENAMED = { class: 'className', for: 'htmlFor', autocomplete: 'autoComplete', enterkeyhint: 'enterKeyHint', tabindex: 'tabIndex' };
  const VOID = new Set(['input', 'br', 'hr', 'img']);
  const HOLE = /\{\{\s*([^}]+?)\s*\}\}/g;
  const WHOLE = /^\s*\{\{\s*([^}]+?)\s*\}\}\s*$/;

  const camel = (s) => s.replace(/-([a-z])/g, (_m, c) => c.toUpperCase());

  function propName(name, isSvg) {
    let lower = name.toLowerCase();
    if (lower.startsWith('data-ev-')) lower = lower.slice(8); // see mount()
    if (EVENTS[lower]) return EVENTS[lower];
    if (RENAMED[lower]) return RENAMED[lower];
    if (lower.startsWith('aria-') || lower.startsWith('data-')) return lower;
    if (isSvg && name.includes('-')) return camel(name);
    return name;
  }

  function lookup(path, scope) {
    if (path === 'true') return true;
    if (path === 'false') return false;
    if (/^-?\d+(\.\d+)?$/.test(path)) return Number(path);
    let value = scope;
    for (const key of path.split('.')) {
      if (value == null) return undefined;
      value = value[key];
    }
    return value;
  }

  /** "a {{x}} b" -> either {whole: 'x'} or {parts: ['a ', {p:'x'}, ' b']} or a plain string. */
  function compileValue(raw) {
    const whole = WHOLE.exec(raw);
    if (whole) return { whole: whole[1] };
    if (raw.indexOf('{{') < 0) return raw;
    const parts = [];
    let last = 0;
    raw.replace(HOLE, (m, p, idx) => {
      if (idx > last) parts.push(raw.slice(last, idx));
      parts.push({ p });
      last = idx + m.length;
      return m;
    });
    if (last < raw.length) parts.push(raw.slice(last));
    return { parts };
  }

  function evalValue(v, scope) {
    if (typeof v === 'string') return v;
    if (v.whole) return lookup(v.whole, scope);
    let out = '';
    for (const part of v.parts) {
      if (typeof part === 'string') out += part;
      else {
        const x = lookup(part.p, scope);
        out += x == null ? '' : x;
      }
    }
    return out;
  }

  function parseStyle(text) {
    const style = {};
    for (const decl of String(text).split(';')) {
      const i = decl.indexOf(':');
      if (i < 0) continue;
      const prop = decl.slice(0, i).trim();
      const value = decl.slice(i + 1).trim();
      if (!prop || !value) continue;
      if (prop.startsWith('--')) style[prop] = value;
      else if (prop.startsWith('-webkit-')) style['Webkit' + camel('-' + prop.slice(8))] = value;
      else style[camel(prop)] = value;
    }
    return style;
  }

  function compile(node) {
    if (node.nodeType === Node.TEXT_NODE) {
      const text = node.nodeValue;
      if (/^\s*$/.test(text) && text.indexOf('\n') >= 0) return null; // layout-only whitespace
      return { text: compileValue(text.replace(/\s*\n\s*/g, '')) };
    }
    if (node.nodeType !== Node.ELEMENT_NODE) return null;
    const tag = node.localName;
    const children = [];
    node.childNodes.forEach((child) => {
      const c = compile(child);
      if (c) children.push(c);
    });
    if (tag === 'sc-for') {
      return { loop: WHOLE.exec(node.getAttribute('list'))[1], as: node.getAttribute('as'), children };
    }
    if (tag === 'sc-if') {
      return { cond: WHOLE.exec(node.getAttribute('value'))[1], children };
    }
    const isSvg = node.namespaceURI === 'http://www.w3.org/2000/svg';
    const attrs = [];
    for (const attr of Array.from(node.attributes)) {
      if (attr.name.startsWith('hint-')) continue;
      attrs.push({ name: propName(attr.name, isSvg), value: compileValue(attr.value) });
    }
    return { tag, attrs, children };
  }

  function renderList(nodes, scope) {
    const out = [];
    for (let i = 0; i < nodes.length; i++) {
      const r = render(nodes[i], scope, i);
      if (r != null) out.push(r);
    }
    return out;
  }

  function render(node, scope, key) {
    if (node.text !== undefined) {
      const text = evalValue(node.text, scope);
      return text == null || text === '' ? null : String(text);
    }
    if (node.loop) {
      const list = lookup(node.loop, scope) || [];
      return h(React.Fragment, { key }, list.map((item, index) => {
        const inner = Object.create(scope);
        inner[node.as] = item;
        inner.$index = index;
        return h(React.Fragment, { key: index }, ...renderList(node.children, inner));
      }));
    }
    if (node.cond) {
      return lookup(node.cond, scope) ? h(React.Fragment, { key }, ...renderList(node.children, scope)) : null;
    }
    const props = { key };
    for (const attr of node.attrs) {
      const value = evalValue(attr.value, scope);
      props[attr.name] = attr.name === 'style' ? parseStyle(value) : value;
    }
    if (VOID.has(node.tag)) return h(node.tag, props);
    return h(node.tag, props, ...renderList(node.children, scope));
  }

  let template = null;

  /** Base class for the screen's logic: subclasses implement renderVals(). */
  class DCLogic extends React.Component {
    render() {
      return h(React.Fragment, null, ...renderList(template, this.renderVals()));
    }
  }

  /** Compile the markup inside `templateEl` and mount `Component` into `rootEl`. */
  function mount(Component, templateEl, rootEl, props) {
    template = [];
    // The markup sits in a <script type="text/x-template">. Its on* attributes are renamed to
    // data-ev-on* before parsing, because the parser would otherwise treat them as inline event
    // handlers, which the page's CSP forbids (and logs an error for each one).
    const markup = templateEl.textContent.replace(/\s(on[A-Za-z]+)=/g, ' data-ev-$1=');
    const doc = new DOMParser().parseFromString('<body>' + markup + '</body>', 'text/html');
    doc.body.childNodes.forEach((child) => {
      const c = compile(child);
      if (c) template.push(c);
    });
    ReactDOM.createRoot(rootEl).render(h(Component, props || {}));
  }

  window.DCLogic = DCLogic;
  window.DC = { mount };
})();
