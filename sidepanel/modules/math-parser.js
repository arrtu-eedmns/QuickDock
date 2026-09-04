// ── math-parser.js ────────────────────────────────────────────────────────────
// Parser aritmético seguro — sem eval(), sem Function()
// Suporta: + − * / ^ ( ) % (percentual contextual)

function fmt(n) {
  if (!isFinite(n)) return '∞';
  const clean = parseFloat(n.toPrecision(10)); // remove lixo de ponto flutuante
  return clean.toLocaleString('pt-BR', {
    minimumFractionDigits: 0,
    maximumFractionDigits: 2,
  });
}

// ── Parser recursivo descendente ──────────────────────────────────────────────
class MathParser {
  constructor(raw) {
    this.src = raw.trim()
      .replace(/\*\*/g, '^')       // potenciação Python/JS (**) → ^ (antes de qualquer outra substituição)
      // Separador de milhar BR: 1.500 → 1500 | 1.500,50 → 1500.50 | 1.500.250,75 → 1500250.75
      // Padrão: 1-3 dígitos seguidos de um ou mais grupos ".000", opcionalmente com ",dd" decimal.
      // Pontos com menos de 3 dígitos seguintes são decimais normais (0.1, 4999.90) — não tocados.
      .replace(/\d{1,3}(?:\.\d{3})+(?:,\d+)?/g, m =>
        m.includes(',')
          ? m.replace(/\./g, '').replace(',', '.')   // remove milhares, converte decimal
          : m.replace(/\./g, '')                     // só remove milhares
      )
      .replace(/,(?=\d)/g, '.')    // vírgula decimal restante → ponto
      .replace(/[×xX]/g, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')     // sinal de menos unicode
      .replace(/\s+/g, ' ');
    this.pos   = 0;
    this.steps = [];
  }

  ws()    { while (this.src[this.pos] === ' ') this.pos++; }
  end()   { this.ws(); return this.pos >= this.src.length; }
  cur()   { this.ws(); return this.src[this.pos] ?? ''; }
  eat(c)  { if (this.src[this.pos] !== c) throw new Error(`Expected '${c}'`); this.pos++; }

  readNum() {
    this.ws();
    let s = '';
    if (this.src[this.pos] === '-') { s = '-'; this.pos++; }
    if (!/\d/.test(this.src[this.pos] ?? '')) throw new Error('Expected digit');
    while (/[\d.]/.test(this.src[this.pos] ?? '')) s += this.src[this.pos++];
    const v = parseFloat(s);
    if (isNaN(v)) throw new Error('NaN');
    return v;
  }

  // ── Gramática (precedência crescente de baixo para cima) ─────────────────────
  // expr    → term   (('+' | '-') term)*
  // term    → power  (('*' | '/') power)*
  // power   → suffix ('^'         suffix)*
  // suffix  → unary  ('%'?)
  // unary   → '-' suffix | primary
  // primary → '(' expr ')' | number

  primary() {
    this.ws();
    if (this.cur() === '(') {
      this.pos++;
      const v = this.expr();
      this.ws(); this.eat(')');
      return { v: v.v };
    }
    return { v: this.readNum() };
  }

  unary() {
    this.ws();
    if (this.cur() === '-') { this.pos++; const n = this.primary(); return { v: -n.v }; }
    return this.primary();
  }

  suffix() {
    const n = this.unary();
    this.ws();
    if (this.src[this.pos] === '%') {
      this.pos++;
      return { v: n.v, pct: true, raw: n.v };
    }
    return n;
  }

  power() {
    let L = this.suffix();
    this.ws();
    while (!this.end() && this.src[this.pos] === '^') {
      this.pos++;
      const R = this.suffix();
      const r = Math.pow(L.v, R.v);
      this.steps.push(`${fmt(L.v)} ^ ${fmt(R.v)} = ${fmt(r)}`);
      L = { v: r };
    }
    return L;
  }

  term() {
    let L = this.power();
    this.ws();
    while (!this.end() && '*/'.includes(this.src[this.pos])) {
      const op  = this.src[this.pos++];
      this.ws();
      const R   = this.power();
      const rv  = R.pct ? R.raw / 100 : R.v;
      const r   = op === '*' ? L.v * rv : L.v / rv;
      const sym = op === '*' ? '×' : '÷';
      const rs  = R.pct ? `${fmt(R.raw)}%` : fmt(R.v);
      this.steps.push(`${fmt(L.v)} ${sym} ${rs} = ${fmt(r)}`);
      L = { v: r };
    }
    return L;
  }

  expr() {
    let L = this.term();
    this.ws();
    while (!this.end() && '+-'.includes(this.src[this.pos])) {
      const op = this.src[this.pos++];
      this.ws();
      const R  = this.term();
      let rv, xtra;

      if (R.pct) {
        // Percentual contextual: 1000 - 15% → subtrai 15% DE 1000
        rv   = L.v * R.raw / 100;
        xtra = `${fmt(R.raw)}% de ${fmt(L.v)} = ${fmt(rv)}`;
      } else {
        rv = R.v;
      }

      const r   = op === '+' ? L.v + rv : L.v - rv;
      const sym = op === '+' ? '+' : '−';
      if (xtra) this.steps.push(xtra);
      this.steps.push(`${fmt(L.v)} ${sym} ${fmt(rv)} = ${fmt(r)}`);
      L = { v: r };
    }
    return L;
  }

  run() {
    const res = this.expr();
    this.ws();
    if (this.pos < this.src.length) throw new Error(`Inesperado: '${this.src[this.pos]}'`);
    return { value: res.v, steps: this.steps };
  }
}

// ── Regex de pré-detecção ─────────────────────────────────────────────────────
// Requer: pelo menos número OPERADOR número (encadeável).
// Espaço obrigatório em algum ponto → evita capturar códigos tipo 98765-4321.
export const MATH_RE =
  /\(*-?\d+(?:[.,]\d+)*[)%]*(?:\s*(?:\*\*|[-+×÷*/^])\s*\(*-?\d+(?:[.,]\d+)*[)%]*)+/g;

// ── API pública ───────────────────────────────────────────────────────────────
export function tryParseMath(raw) {
  if (!raw || raw.trim().length < 3) return null;
  try {
    const { value, steps } = new MathParser(raw).run();
    if (!isFinite(value)) return null;
    return { raw, result: value, resultFmt: fmt(value), steps };
  } catch {
    return null;
  }
}
