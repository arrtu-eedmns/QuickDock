// ── calc.mjs ───────────────────────────────────────────────────────────────
// A folha de cálculo. Diferente do resto da suíte, aqui não há recorte nem
// DOM de mentira: math-parser.js e calc.js são importados de verdade, porque
// foram escritos justamente pra não depender do navegador.
//
// O caso que governa o desenho está no primeiro bloco: se "15%" virasse 0,15
// na hora em que é lido, a conta do boleto daria 999,85 em vez de 850,00.

import { evaluateSheet } from '../sidepanel/modules/calc.js';
import { evalExpression, formatValue, tryParseMath } from '../sidepanel/modules/math-parser.js';
import { parseMarkdownToBlocks as PARSE, blocksToMarkdown as MD } from '../sidepanel/modules/blocks.js';

const calcular = texto => evaluateSheet(texto.split('\n'));
const resultados = texto => calcular(texto).map(r => r.fmt ?? r.erro ?? '');
const uma = expr => formatValue(evalExpression(expr).value);

export function rodarTestesDeCalculo(ok, igual) {
  // ── O exemplo que motivou tudo ─────────────────────────────────────────────
  {
    const folha = [
      'let camila = 0',
      'let boleto = R$ 1.000,00',
      'let imposto = 15%',
      'let calculo = boleto - imposto',
      'camila = calculo',
    ].join('\n');

    igual('cálculo · a folha do exemplo, linha a linha', resultados(folha),
      ['0', 'R$ 1.000,00', '15%', 'R$ 850,00', 'R$ 850,00']);

    ok('cálculo · toda linha produziu valor, nenhuma erro',
       calcular(folha).every(r => r.tipo === 'valor'));
  }

  // O detalhe que decide tudo: percentual guardado não pode virar 0,15.
  // Sem moeda na conta, o resultado sai como número puro — 850, não 850,00.
  igual('cálculo · percentual guardado só vira número quando é usado',
    resultados('imposto = 15%\ntotal = 1000 - imposto').at(-1), '850');
  igual('cálculo · e com moeda o resultado sai em moeda',
    resultados('imposto = 15%\ntotal = R$ 1.000,00 - imposto').at(-1), 'R$ 850,00');

  // ── Percentual ─────────────────────────────────────────────────────────────
  igual('percentual · subtrair é relativo à esquerda', uma('1000 - 15%'), '850');
  igual('percentual · somar também',                   uma('1000 + 15%'), '1.150');
  igual('percentual · multiplicar é fator',            uma('1000 * 15%'), '150');
  igual('percentual · entre dois percentuais soma direto', uma('15% + 5%'), '20%');
  igual('percentual · sozinho continua percentual',    uma('15%'), '15%');

  // ── Moeda ──────────────────────────────────────────────────────────────────
  igual('moeda · entra e volta formatada',        uma('R$ 1.000,00'), 'R$ 1.000,00');
  igual('moeda · número puro herda a moeda',      uma('R$ 100 + 50'), 'R$ 150,00');
  igual('moeda · e herda pela esquerda também',   uma('50 + R$ 100'), 'R$ 150,00');
  igual('moeda · multiplicar por número mantém',  uma('R$ 100 * 3'), 'R$ 300,00');
  igual('moeda · dividir por número mantém',      uma('R$ 100 / 4'), 'R$ 25,00');
  igual('moeda · dividida por moeda vira razão',  uma('R$ 100 / R$ 4'), '25');
  igual('moeda · sempre com dois decimais',       uma('R$ 10'), 'R$ 10,00');

  // ── Número pt-BR ───────────────────────────────────────────────────────────
  igual('número · milhar com ponto',        uma('1.500 + 500'), '2.000');
  igual('número · milhar e decimal',        uma('1.500,50 + 0,50'), '1.501');
  igual('número · decimal com vírgula',     uma('1,5 * 2'), '3');
  igual('número · ponto decimal também',    uma('1.5 * 2'), '3');

  // ── Variáveis ──────────────────────────────────────────────────────────────
  {
    igual('variáveis · let é opcional',
      resultados('a = 10\nlet b = 20\na + b').at(-1), '30');

    igual('variáveis · reatribuir vale da linha seguinte em diante',
      resultados('x = 10\ny = x\nx = 99\ny').at(-1), '10');

    igual('variáveis · nome com acento',
      resultados('salário = 1000\nsalário / 2').at(-1), '500');

    // "x" como sinal de multiplicação não pode comer o x dos nomes: a troca
    // era global e transformava "taxa" em "ta*a".
    igual('variáveis · nome com x dentro',
      resultados('taxa = 50\nboleto = 100\nboleto - taxa').at(-1), '50');
    igual('variáveis · nome de uma letra só',
      resultados('x = 10\nx * 2').at(-1), '20');
    igual('variáveis · e x entre números continua sendo multiplicação',
      resultados('3 x 4').at(-1), '12');

    // Uma passada de cima pra baixo: ciclo não tem como existir.
    const antes = calcular('b = a + 1\na = 10');
    igual('variáveis · usar antes de definir é erro, não travamento', antes[0].tipo, 'erro');
    ok('variáveis · e o erro diz o nome que faltou',
       antes[0].erro.includes('a'), antes[0].erro);
  }

  // ── Funções ────────────────────────────────────────────────────────────────
  igual('funções · soma',        resultados('soma(10; 20; 30)').at(-1), '60');
  igual('funções · média',       resultados('média(10; 20; 30)').at(-1), '20');
  igual('funções · sem acento',  resultados('media(10; 20)').at(-1), '15');
  igual('funções · arredondar',  resultados('arredondar(10,4)').at(-1), '10');
  igual('funções · arredondar com casas', resultados('arredondar(10,456; 2)').at(-1), '10,46');

  // Vírgula entre argumentos, quando não era decimal, também serve.
  igual('funções · vírgula separando argumentos', resultados('soma(10, 20)').at(-1), '30');

  igual('funções · soma mantém a moeda',
    resultados('soma(R$ 10; R$ 20)').at(-1), 'R$ 30,00');

  // ── "acima" ────────────────────────────────────────────────────────────────
  {
    igual('acima · soma as linhas anteriores',
      resultados('10\n20\n30\ntotal = acima').at(-1), '60');

    // Uma linha sem valor fecha o bloco de cima — é o que torna previsível
    // uma folha com vários totais.
    igual('acima · para na primeira linha sem valor',
      resultados('100\n\n10\n20\ntotal = acima').at(-1), '30');

    igual('acima · funciona dentro de função',
      resultados('10\n20\n30\nm = média(acima)').at(-1), '20');

    igual('acima · mantém a moeda',
      resultados('R$ 10\nR$ 20\ntotal = acima').at(-1), 'R$ 30,00');

    igual('acima · encostando num operador, vira a soma',
      resultados('10\n20\nacima * 2').at(-1), '60');
  }

  // ── Linha que não é conta ──────────────────────────────────────────────────
  {
    const folha = calcular([
      'Cliente ligou pela 3ª vez',
      '// conferir com a operadora',
      '# isto também é comentário',
      '',
      'boleto = 100',
    ].join('\n'));

    igual('texto · frase solta não vira erro nem resultado',
      folha.slice(0, 4).map(r => r.tipo), ['texto', 'texto', 'texto', 'texto']);
    igual('texto · e a conta depois dela funciona', folha[4].tipo, 'valor');
  }

  // Com "=" era pra ser conta: aí o erro aparece.
  {
    const r = calcular('total = 10 +')[0];
    igual('erro · linha com "=" que falha vira erro visível', r.tipo, 'erro');
    ok('erro · com uma mensagem em português', /[a-zà-ú]/i.test(r.erro), r.erro);
  }

  igual('erro · palavra reservada não vira variável', calcular('soma = 10')[0].tipo, 'erro');

  // ── Nada de eval ───────────────────────────────────────────────────────────
  // Não é preferência: o MV3 proíbe. Qualquer coisa que não seja aritmética
  // tem que morrer como erro, e nunca ser executada.
  for (const hostil of [
    'x = constructor',
    'x = alert(1)',
    'x = [].constructor',
    'x = this',
    'x = 1; alert(1)',
  ]) {
    const r = calcular(hostil)[0];
    igual(`segurança · "${hostil}" não executa nada`, r.tipo, 'erro');
  }

  // ── O bloco no markdown ────────────────────────────────────────────────────
  // A folha sai cercada com a marca "calc": fora do QuickDock é um bloco de
  // código comum, e aqui volta a ser folha de cálculo.
  {
    const md = [
      '```calc',
      'boleto = R$ 1.000,00',
      'imposto = 15%',
      'calculo = boleto - imposto',
      '```',
    ].join('\n');

    const blocos = PARSE(md);
    igual('markdown · a cerca vira uma linha de cálculo por bloco',
      blocos.map(b => b.type), ['calc', 'calc', 'calc']);
    igual('markdown · e volta exatamente como entrou', MD(blocos), md);

    // Na exportação o resultado vai junto, em comentário à direita.
    const exportado = MD(blocos, { comentarResultados: true });
    ok('markdown · exportação traz o resultado ao lado',
       exportado.includes('// R$ 850,00'), exportado);
    ok('markdown · e o autosave não traz',
       !MD(blocos).includes('//'), MD(blocos));

    // Reimportar descarta o comentário: dentro da extensão nunca há número
    // desatualizado, porque o valor é sempre recalculado.
    const volta = PARSE(exportado);
    igual('markdown · reimportar descarta o comentário',
      volta.map(b => b.type), ['calc', 'calc', 'calc']);
    igual('markdown · e o texto da linha fica limpo', MD(volta), md);
  }

  // Cerca sem marca continua sendo bloco de código — e agora dá a volta
  // inteira, o que antes não acontecia (virava parágrafo solto).
  {
    const md = ['```', 'const a = 1;', 'const b = 2;', '```'].join('\n');
    const blocos = PARSE(md);
    igual('markdown · cerca sem marca é código', blocos.map(b => b.type), ['code']);
    igual('markdown · código dá a volta inteira', MD(blocos), md);
  }

  // Duas folhas separadas por texto não viram uma só.
  {
    const md = ['```calc', '10', '```', '', 'Texto no meio.', '', '```calc', '20', '```'].join('\n');
    const blocos = PARSE(md);
    igual('markdown · folhas separadas por texto continuam separadas',
      blocos.map(b => b.type), ['calc', 'paragraph', 'paragraph', 'paragraph', 'calc']);
    igual('markdown · e cada uma com a sua cerca', MD(blocos), md);
  }

  // ── A detecção de conta solta no texto continua funcionando ────────────────
  {
    const p = tryParseMath('150 + 25 * 2 - 10%');
    ok('detecção · a conta do tutorial continua sendo reconhecida', !!p);
    igual('detecção · com o mesmo resultado de antes', p.resultFmt, '180');
    ok('detecção · e com passo a passo', p.steps.length > 0);

    ok('detecção · palavra solta não é conta', tryParseMath('boleto + imposto') === null);
  }
}
