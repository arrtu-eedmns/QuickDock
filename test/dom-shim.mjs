// ── dom-shim.mjs ───────────────────────────────────────────────────────────
// DOM mínimo para rodar blocks.js fora do navegador.
//
// Não é um navegador de mentira: é exatamente o que blocks.js usa e nada mais —
// document.createElement('div'), innerHTML (ler e escrever), childNodes,
// textContent, tagName e getAttribute. O HTML que passa por aqui é o que o
// próprio editor gera (<strong>, <em>, <s>, <code>, <a>, <br>, <mark>), então
// um tokenizador desse tamanho dá conta.

const VOID = new Set(['br', 'hr', 'img', 'input', 'meta', 'link']);

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };

function decode(s) {
  return s.replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, (all, code) => {
    if (code[0] === '#') {
      const hex = code[1] === 'x' || code[1] === 'X';
      const n = parseInt(hex ? code.slice(2) : code.slice(1), hex ? 16 : 10);
      return Number.isFinite(n) ? String.fromCodePoint(n) : all;
    }
    return ENTITIES[code.toLowerCase()] ?? all;
  });
}

const encText = s => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
const encAttr = s => encText(s).replace(/"/g, '&quot;');

class TextNode {
  constructor(data) {
    this.nodeType = 3;
    this.data = data;
    this.childNodes = [];
  }
  get textContent() { return this.data; }
  get outerHTML()   { return encText(this.data); }
}

class Element {
  constructor(tag) {
    this.nodeType = 1;
    this.tagName = tag.toUpperCase();
    this.attributes = new Map();
    this.childNodes = [];
  }
  getAttribute(name) { return this.attributes.has(name) ? this.attributes.get(name) : null; }
  setAttribute(name, value) { this.attributes.set(name, String(value)); }
  removeAttribute(name) { this.attributes.delete(name); }
  appendChild(node) { this.childNodes.push(node); return node; }
  normalize() {}

  get textContent() { return this.childNodes.map(n => n.textContent).join(''); }
  get innerHTML()   { return this.childNodes.map(n => n.outerHTML).join(''); }
  set innerHTML(html) { this.childNodes = parseHTML(html ?? ''); }

  get outerHTML() {
    const name  = this.tagName.toLowerCase();
    const attrs = [...this.attributes].map(([k, v]) => ` ${k}="${encAttr(v)}"`).join('');
    return VOID.has(name) ? `<${name}${attrs}>` : `<${name}${attrs}>${this.innerHTML}</${name}>`;
  }
}

const TAG_RE = /<\/?([a-zA-Z][\w-]*)((?:\s+[\w:-]+(?:\s*=\s*(?:"[^"]*"|'[^']*'|[^\s>]*))?)*)\s*\/?>/g;

function parseAttrs(el, raw) {
  const re = /([\w:-]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
  let m;
  while ((m = re.exec(raw)) !== null) {
    if (m[0] === '') { re.lastIndex++; continue; }   // sem isto o laço não anda
    el.setAttribute(m[1].toLowerCase(), decode(m[2] ?? m[3] ?? m[4] ?? ''));
  }
}

function parseHTML(html) {
  const root  = { childNodes: [] };
  const stack = [root];
  const push  = node => stack[stack.length - 1].childNodes.push(node);

  TAG_RE.lastIndex = 0;
  let pos = 0, m;

  while ((m = TAG_RE.exec(html)) !== null) {
    if (m.index > pos) push(new TextNode(decode(html.slice(pos, m.index))));
    pos = m.index + m[0].length;

    const tag = m[1].toLowerCase();

    if (m[0][1] === '/') {
      // Fecha o mais interno com esse nome; tag solta não derruba a pilha.
      for (let i = stack.length - 1; i > 0; i--) {
        if (stack[i].tagName?.toLowerCase() === tag) { stack.length = i; break; }
      }
      continue;
    }

    const el = new Element(tag);
    parseAttrs(el, m[2] ?? '');
    push(el);
    if (!VOID.has(tag) && !m[0].endsWith('/>')) stack.push(el);
  }

  if (pos < html.length) push(new TextNode(decode(html.slice(pos))));
  return root.childNodes;
}

export function installDomShim() {
  globalThis.Node = { ELEMENT_NODE: 1, TEXT_NODE: 3 };
  globalThis.document = {
    createElement: tag => new Element(tag),
    createTextNode: data => new TextNode(data),
  };
}
