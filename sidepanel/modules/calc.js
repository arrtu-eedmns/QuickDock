// ── calc.js ────────────────────────────────────────────────────────────────
// A folha de cálculo: um punhado de linhas avaliadas de cima pra baixo,
// carregando as variáveis de uma pra outra.
//
// Sem DOM e sem banco — entra texto, sai resultado. É o que permite testar a
// parte difícil inteira fora do navegador.
//
// Duas regras governam o comportamento:
//
// 1. **Avaliação em uma passada, de cima pra baixo.** Ciclo não existe: usar
//    antes de definir é "ainda não definido", não travamento. Reatribuir é
//    natural, porque cada linha só enxerga o que já passou.
//
// 2. **Linha que não é conta é só texto.** "Cliente ligou 3ª vez" fica lá, sem
//    resultado e sem erro vermelho. Erro só aparece quando a linha É uma conta
//    e falha. O critério: linha com "=" é atribuição e erra alto; linha sem
//    "=" que não avalia é texto e fica quieta.

import {
  evalExpression, formatValue, collapse, numero, lista, NOMES_RESERVADOS,
} from './math-parser.js';

const ATRIBUICAO_RE = /^\s*(?:let|const|var)?\s*([A-Za-zÀ-ÿ_][A-Za-zÀ-ÿ0-9_]*)\s*=\s*(.+)$/;
const COMENTARIO_RE = /^\s*(\/\/|#)/;

/**
 * Avalia uma folha inteira.
 * @param linhas string[] — o texto de cada linha, na ordem
 * @returns [{ tipo, nome, valor, fmt, erro }] — um por linha, na mesma ordem
 *          tipo: 'valor' | 'texto' | 'erro'
 */
export function evaluateSheet(linhas) {
  const vars = new Map();
  const saida = [];

  // "acima" são os valores das linhas anteriores, parando na primeira que não
  // produziu valor. É o que torna previsível uma folha com vários blocos de
  // soma: uma linha em branco ou um comentário fecha o bloco de cima.
  const acima = () => {
    const itens = [];
    for (let i = saida.length - 1; i >= 0; i--) {
      if (saida[i].tipo !== 'valor') break;
      itens.unshift(saida[i].valor);
    }
    return lista(itens);
  };

  const resolve = nome => {
    if (nome === 'acima') return acima();
    const chave = nome.toLowerCase();
    if (!vars.has(chave)) throw new Error(`"${nome}" ainda não foi definido`);
    return vars.get(chave);
  };

  for (const bruta of linhas) {
    const texto = (bruta ?? '').trim();

    if (texto === '' || COMENTARIO_RE.test(texto)) {
      saida.push({ tipo: 'texto' });
      continue;
    }

    const atribuicao = ATRIBUICAO_RE.exec(texto);

    if (atribuicao) {
      const [, nome, expressao] = atribuicao;
      if (NOMES_RESERVADOS.has(nome.toLowerCase())) {
        saida.push({ tipo: 'erro', erro: `"${nome}" é uma palavra reservada` });
        continue;
      }
      try {
        const valor = collapse(evalExpression(expressao, resolve).value);
        vars.set(nome.toLowerCase(), valor);
        saida.push({ tipo: 'valor', nome, valor, fmt: formatValue(valor) });
      } catch (e) {
        // Tem "=", então era pra ser uma conta: o erro aparece.
        saida.push({ tipo: 'erro', nome, erro: mensagem(e) });
      }
      continue;
    }

    try {
      const valor = collapse(evalExpression(texto, resolve).value);
      if (!isFinite(valor.n)) { saida.push({ tipo: 'texto' }); continue; }
      saida.push({ tipo: 'valor', valor, fmt: formatValue(valor) });
    } catch {
      // Sem "=" e não avaliou: é uma linha de texto, e texto não erra.
      saida.push({ tipo: 'texto' });
    }
  }

  return saida;
}

function mensagem(e) {
  const txt = (e?.message ?? '').trim();
  return txt || 'não consegui calcular';
}

/** As variáveis no fim da folha — pra quem quiser mostrar um resumo. */
export function sheetVariables(linhas) {
  const vistas = new Map();
  const resultado = evaluateSheet(linhas);
  resultado.forEach(r => { if (r.tipo === 'valor' && r.nome) vistas.set(r.nome, r.fmt); });
  return vistas;
}

export { numero };
