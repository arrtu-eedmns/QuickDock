// ── math-parser.js ────────────────────────────────────────────────────────────
// Parser aritmético seguro — sem eval(), sem Function().
//
// Não é preferência de estilo: o MV3 proíbe avaliar código montado em texto, e
// a política de conteúdo da extensão não abre exceção. Então a gramática é
// escrita à mão, com descida recursiva.
//
// ── Valor, não número ────────────────────────────────────────────────────────
// A conta não trabalha com `number` e sim com `{ n, moeda, pct }`. Isso existe
// por causa de um caso só, que é o que faz a folha de cálculo funcionar:
//
//     imposto = 15%
//     calculo = boleto - imposto     → R$ 850,00
//
// Se `15%` virasse 0,15 na hora em que é lido, a segunda linha daria 999,85.
// O percentual precisa continuar sendo "quinze por cento" até ser usado, e só
// então descobrir de quem. O mesmo vale pra moeda: ela acompanha a conta e
// volta formatada no fim.

// ── Valor ─────────────────────────────────────────────────────────────────────
export const numero = n => ({ n, moeda: null, pct: false });

// Uma lista só nasce de "acima" (as linhas anteriores da folha) e só é
// entendida pelas funções. Se encostar num operador, vira a soma dela.
export const lista = itens => ({ n: 0, moeda: null, pct: false, lista: itens });

export function collapse(v) {
  if (!v?.lista) return v;
  return v.lista.reduce((acc, x) => add(acc, x, 1), numero(0));
}

function fmtNum(n) {
  if (!isFinite(n)) return '∞';
  const clean = parseFloat(n.toPrecision(10)); // remove lixo de ponto flutuante
  return clean.toLocaleString('pt-BR', { minimumFractionDigits: 0, maximumFractionDigits: 2 });
}

export function formatValue(v) {
  const alvo = collapse(v);
  if (!alvo || !isFinite(alvo.n)) return '∞';
  if (alvo.pct) return `${fmtNum(alvo.n)}%`;
  if (alvo.moeda === 'BRL') {
    const clean = parseFloat(alvo.n.toPrecision(12));
    return `R$ ${clean.toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
  }
  return fmtNum(alvo.n);
}

// ── Aritmética com unidade ────────────────────────────────────────────────────
function add(L, R, sinal) {
  // Percentual à direita é relativo ao valor da esquerda: "1000 - 15%" tira 15%
  // DE 1000. Entre dois percentuais não vale a regra — "15% + 5%" é 20%, e não
  // 15,75%.
  if (R.pct && !L.pct) {
    return { n: L.n + sinal * (L.n * R.n / 100), moeda: L.moeda, pct: false };
  }
  return { n: L.n + sinal * R.n, moeda: L.moeda ?? R.moeda, pct: L.pct && R.pct };
}

function mul(L, R) {
  if (R.pct && !L.pct) return { n: L.n * R.n / 100, moeda: L.moeda, pct: false };
  if (L.pct && !R.pct) return { n: R.n * L.n / 100, moeda: R.moeda, pct: false };
  return { n: L.n * R.n, moeda: L.moeda ?? R.moeda, pct: L.pct && R.pct };
}

function div(L, R) {
  const divisor = R.pct ? R.n / 100 : R.n;
  // Moeda dividida por moeda é uma razão — o resultado perde a unidade.
  const moeda = (L.moeda && R.moeda) ? null : (L.moeda ?? null);
  return { n: L.n / divisor, moeda, pct: false };
}

// ── Funções ───────────────────────────────────────────────────────────────────
// Com e sem acento: quem digita rápido não acentua, e recusar seria implicância.
function somaDe(args) {
  return args.flatMap(a => a.lista ?? [a]).reduce((acc, x) => add(acc, x, 1), numero(0));
}

const FUNCOES = {
  soma: somaDe,
  média: args => {
    const itens = args.flatMap(a => a.lista ?? [a]);
    if (itens.length === 0) return numero(0);
    return div(somaDe(itens), numero(itens.length));
  },
  arredondar: args => {
    const v = collapse(args[0] ?? numero(0));
    const casas = args[1] ? collapse(args[1]).n : 0;
    const f = 10 ** casas;
    return { ...v, n: Math.round(v.n * f) / f };
  },
};
FUNCOES.media = FUNCOES.média;

export const NOMES_RESERVADOS = new Set([...Object.keys(FUNCOES), 'acima']);

const IDENT_RE = /^[A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_]*/;

// ── Parser recursivo descendente ──────────────────────────────────────────────
class MathParser {
  /** @param resolve (nome) => Valor — de onde saem as variáveis; ausente = sem variáveis */
  constructor(raw, resolve = null) {
    this.src = raw.trim()
      .replace(/\*\*/g, '^')       // potenciação Python/JS (**) → ^, antes de tudo
      // Separador de milhar BR: 1.500 → 1500 | 1.500,50 → 1500.50
      // Ponto com menos de 3 dígitos depois é decimal normal (0.1, 4999.90).
      .replace(/\d{1,3}(?:\.\d{3})+(?:,\d+)?/g, m =>
        m.includes(',')
          ? m.replace(/\./g, '').replace(',', '.')
          : m.replace(/\./g, '')
      )
      // Vírgula decimal só entre dígitos. Sem essa exigência, "soma(10, 20)"
      // viraria "soma(10.20)" — um argumento só, com o valor errado e em
      // silêncio.
      .replace(/(?<=\d),(?=\d)/g, '.')
      // "x" só é multiplicação entre números — "3 x 4". Trocar todo x do
      // texto quebraria qualquer variável com x no nome: "taxa" virava "ta*a".
      .replace(/×/g, '*')
      .replace(/(?<=[\d)\s])[xX](?=[\s(\d])/g, '*')
      .replace(/÷/g, '/')
      .replace(/−/g, '-')          // sinal de menos unicode
      .replace(/\s+/g, ' ');
    this.pos     = 0;
    this.steps   = [];
    this.resolve = resolve;
  }

  ws()    { while (this.src[this.pos] === ' ') this.pos++; }
  end()   { this.ws(); return this.pos >= this.src.length; }
  cur()   { this.ws(); return this.src[this.pos] ?? ''; }
  eat(c)  { if (this.src[this.pos] !== c) throw new Error(`Esperava '${c}'`); this.pos++; }

  readValue() {
    this.ws();
    let moeda = null;
    if (/^r\$/i.test(this.src.slice(this.pos, this.pos + 2))) {
      this.pos += 2;
      moeda = 'BRL';
      this.ws();
    }
    let s = '';
    if (this.src[this.pos] === '-') { s = '-'; this.pos++; }
    if (!/\d/.test(this.src[this.pos] ?? '')) throw new Error('Esperava um número');
    while (/[\d.]/.test(this.src[this.pos] ?? '')) s += this.src[this.pos++];
    const v = parseFloat(s);
    if (isNaN(v)) throw new Error('Número inválido');
    return { n: v, moeda, pct: false };
  }

  readIdent() {
    this.ws();
    const m = IDENT_RE.exec(this.src.slice(this.pos));
    if (!m) return null;
    this.pos += m[0].length;
    return m[0];
  }

  // ── Gramática (precedência crescente de baixo para cima) ────────────────────
  // expr    → term   (('+' | '-') term)*
  // term    → power  (('*' | '/') power)*
  // power   → suffix ('^'         suffix)*
  // suffix  → unary  ('%'?)
  // unary   → '-' suffix | primary
  // primary → '(' expr ')' | função '(' args ')' | nome | número

  primary() {
    this.ws();
    if (this.cur() === '(') {
      this.pos++;
      const v = this.expr();
      this.ws(); this.eat(')');
      return v;
    }

    // "R$" começa com letra e seria confundido com um nome de variável — a
    // moeda precisa ser reconhecida antes do identificador.
    if (/^r\$/i.test(this.src.slice(this.pos, this.pos + 2))) return this.readValue();

    if (IDENT_RE.test(this.src.slice(this.pos))) {
      const nome = this.readIdent();
      this.ws();

      if (this.src[this.pos] === '(') {
        const fn = FUNCOES[nome] ?? FUNCOES[nome.toLowerCase()];
        if (!fn) throw new Error(`Não conheço a função ${nome}()`);
        this.pos++;
        const args = [];
        this.ws();
        if (this.src[this.pos] !== ')') {
          // ";" é o separador (a vírgula é decimal em pt-BR), mas uma vírgula
          // que sobreviveu à normalização não era decimal e também serve.
          do {
            args.push(this.expr());
            this.ws();
          } while ((this.src[this.pos] === ';' || this.src[this.pos] === ',') && ++this.pos);
        }
        this.ws(); this.eat(')');
        return fn(args);
      }

      if (!this.resolve) throw new Error(`Não esperava "${nome}" aqui`);
      return this.resolve(nome);
    }

    return this.readValue();
  }

  unary() {
    this.ws();
    if (this.cur() === '-') {
      this.pos++;
      const n = collapse(this.suffix());
      return { ...n, n: -n.n };
    }
    return this.primary();
  }

  suffix() {
    const n = this.unary();
    this.ws();
    if (this.src[this.pos] === '%') {
      this.pos++;
      return { ...collapse(n), pct: true };
    }
    return n;
  }

  // O colapso da lista é preguiçoso: só acontece quando um operador de fato
  // precisa de um número. É o que faz "média(acima)" receber os itens em vez
  // da soma deles.
  power() {
    let L = this.suffix();
    this.ws();
    while (!this.end() && this.src[this.pos] === '^') {
      L = collapse(L);
      this.pos++;
      const R = collapse(this.suffix());
      const r = { ...L, n: Math.pow(L.n, R.n) };
      this.steps.push(`${formatValue(L)} ^ ${formatValue(R)} = ${formatValue(r)}`);
      L = r;
    }
    return L;
  }

  term() {
    let L = this.power();
    this.ws();
    while (!this.end() && '*/'.includes(this.src[this.pos])) {
      L = collapse(L);
      const op = this.src[this.pos++];
      this.ws();
      const R = collapse(this.power());
      const r = op === '*' ? mul(L, R) : div(L, R);
      this.steps.push(`${formatValue(L)} ${op === '*' ? '×' : '÷'} ${formatValue(R)} = ${formatValue(r)}`);
      L = r;
    }
    return L;
  }

  expr() {
    let L = this.term();
    this.ws();
    while (!this.end() && '+-'.includes(this.src[this.pos])) {
      L = collapse(L);
      const op = this.src[this.pos++];
      this.ws();
      const R = collapse(this.term());

      if (R.pct && !L.pct) {
        const parte = { n: L.n * R.n / 100, moeda: L.moeda, pct: false };
        this.steps.push(`${formatValue(R)} de ${formatValue(L)} = ${formatValue(parte)}`);
      }

      const r = add(L, R, op === '+' ? 1 : -1);
      this.steps.push(`${formatValue(L)} ${op === '+' ? '+' : '−'} ${formatValue(R)} = ${formatValue(r)}`);
      L = r;
    }
    return L;
  }

  run() {
    const res = collapse(this.expr());
    this.ws();
    if (this.pos < this.src.length) throw new Error(`Não entendi "${this.src[this.pos]}"`);
    return { value: res, steps: this.steps };
  }
}

// ── Regex de pré-detecção ─────────────────────────────────────────────────────
// Requer: pelo menos número OPERADOR número (encadeável).
// Espaço obrigatório em algum ponto → evita capturar códigos tipo 98765-4321.
export const MATH_RE =
  /\(*-?\d+(?:[.,]\d+)*[)%]*(?:\s*(?:\*\*|[-+×÷*/^])\s*\(*-?\d+(?:[.,]\d+)*[)%]*)+/g;

// ── API pública ───────────────────────────────────────────────────────────────

/** Avalia uma expressão. `resolve` traz as variáveis; sem ele, nome vira erro. */
export function evalExpression(raw, resolve = null) {
  return new MathParser(raw, resolve).run();
}

// Detecção de conta solta no meio do texto (Ctrl+clique). Sem variáveis de
// propósito: aqui uma palavra é palavra, não nome de variável.
export function tryParseMath(raw) {
  if (!raw || raw.trim().length < 3) return null;
  try {
    const { value, steps } = evalExpression(raw);
    if (!isFinite(value.n)) return null;
    return { raw, result: value.n, valor: value, resultFmt: formatValue(value), steps };
  } catch {
    return null;
  }
}
