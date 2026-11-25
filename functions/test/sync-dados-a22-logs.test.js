'use strict';
/**
 * Etapa A2.2 — LOGS PÚBLICOS SANITIZADOS. O repositório é público: o log do workflow só pode conter informação operacional
 * (bloco, status, códigos de erro, duração, resultado das verificações). Nada de valores em R$, contagens de negócio, nomes,
 * identificadores, respostas da API, mensagens de exceção ou stack traces. Estes testes impedem a reintrodução.
 */
const { spawnSync } = require('child_process');
const fs = require('fs'), os = require('os'), path = require('path');
jest.setTimeout(240000);
const ROOT = path.resolve(__dirname, '../..');
const HARNESS = path.join(__dirname, 'fixtures', 'sync-harness.js');
const SRC = fs.readFileSync(path.join(ROOT, 'scripts/sync-dados.js'), 'utf8');

const PREVIO = () => ({
  painel_cache: {
    vendas: { atualizado_em: 'ANTERIOR', hoje: 999, mes: 90000, vendedores: [{ nome: 'Vendedor SECRETO', faturamento: 123456.78 }], _meta: { vendasTotal: 4, janelaDias: 30, escopo: 'loja_262759', sincronizadoEm: 'ANTERIOR' } },
    caixa: { atualizado_em: 'ANTERIOR', hoje: 999 }, estoque: { atualizado_em: 'ANTERIOR', total_produtos: 3 }, estoque_custos: { atualizado_em: 'ANTERIOR' }, produtos_catalogo: { atualizado_em: 'ANTERIOR', total: 3 },
  },
  display_metrics: { latest: { atualizado_em: 'ANTERIOR' } },
  pedidos_cache: { latest: { atualizado_em: 'ANTERIOR', total: 10, pedidos: [], _meta: { pedidosTotal: 10 } } },
  financeiro_cache: { latest: { atualizado_em: 'ANTERIOR', _meta: { lancamentosTotal: 10 } } },
});
function rodar(modo, extraEnv = {}) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'a22-')); const st = path.join(dir, 's.json'), out = path.join(dir, 'o.json');
  fs.writeFileSync(st, JSON.stringify(PREVIO()));
  const r = spawnSync(process.execPath, ['-r', HARNESS, path.join(ROOT, 'scripts/sync-dados.js')], { cwd: ROOT, timeout: 90000, encoding: 'utf8',
    env: { ...process.env, GC_ACCESS_TOKEN: 'tok-a-FAKE', GC_SECRET_ACCESS_TOKEN: 'tok-s-FAKE', HARNESS_MODE: modo, HARNESS_STATE: st, HARNESS_OUT: out, GOOGLE_APPLICATION_CREDENTIALS: '', FIREBASE_SERVICE_ACCOUNT: '', ...extraEnv } });
  return { log: String(r.stdout || '') + '\n' + String(r.stderr || ''), exitCode: r.status };
}
const MODOS = ['ok', 'falha', 'vendas_pag2_500', 'vendas_pag2_429', 'vendas_estrutura_invalida', 'vendas_pag_incompleta', 'vendas_vazio', 'vendas_queda', 'pagamentos_queda', 'pagamentos_erro500', 'pedidos_vazio_feriado', 'pedidos_vazio_inconsistente', 'pedidos_estrutura_invalida'];

// Valores que existem nas fixtures e NUNCA podem aparecer no log
const PROIBIDOS = [/R\$/, /\bnovo=|\banterior=/, /Vendedor [AB]\b|Vendedor SECRETO/, /Produto [ABC]\b|Fab [XYZ]\b|Fornecedor/, /\b1000\.00\b|\b123456|\b2150\b|\b8032/, /tok-[as]-FAKE/, /\bat\s+\S+\s+\(.*:\d+:\d+\)/ /* stack trace */, /Error:/, /GestãoClick.*[Tt]oken/,
  /\b\d+\s+(vendas|pedidos|produtos|lançamentos|vendedores|registros|perfis|clientes|itens)\b/i, /\babaixo do mínimo\b/, /\bvendas delta\b/, /\bhoje\b.*\bmês\b/i];
// Remove o que é permitido (hora do sync, JSON do RESUMO, códigos com dígitos) e exige que não restem números soltos
function semPermitido(log) {
  return log.split('\n').filter(l => !l.startsWith('RESUMO_SYNC '))
    .map(l => l.replace(/ASSINATURA8=[0-9a-f]{8}/, 'ASSINATURA8=HASH').replace(/ID_APROVACAO=[a-z]+-\d+/, 'ID_APROVACAO=ID').replace(/Iniciando sync — [\d/, :]+/, 'Iniciando sync').replace(/[A-Z][A-Z0-9_]*\d[A-Z0-9_]*/g, 'CODIGO').replace(/COM \d+ falha\(s\)/, 'COM N falha(s)').replace(/Perfil360/g, 'Perfil')).join('\n');
}

describe.each(MODOS)('A2.2 — log do modo %s', modo => {
  let r; beforeAll(() => { r = rodar(modo); });
  test('nenhum valor proibido (R$, contagens, nomes, credenciais, stack trace, respostas)', () => { for (const re of PROIBIDOS) expect({ re: String(re), achou: re.test(r.log) }).toEqual({ re: String(re), achou: false }); });
  test('nenhum número solto no log (fora hora do sync, códigos e RESUMO_SYNC)', () => { const sobra = semPermitido(r.log).split('\n').filter(l => /\d/.test(l)); expect(sobra).toEqual([]); });
  test('RESUMO_SYNC só com bloco/código/motivo/duração', () => {
    const l = r.log.split('\n').find(x => x.startsWith('RESUMO_SYNC ')); expect(l).toBeTruthy(); const j = JSON.parse(l.slice(12));
    expect(Object.keys(j).sort()).toEqual(['avisos', 'duracaoMs', 'duracoesMs', 'falhas', 'ok']);
    for (const f of j.falhas) { expect(Object.keys(f).every(k => ['bloco', 'codigo', 'motivo'].includes(k))).toBe(true); expect(f.codigo).toMatch(/^[A-Z0-9_]+$/); if (f.motivo) expect(f.motivo).toMatch(/^[A-Z0-9_]+$/); }
    expect(Number.isFinite(j.duracaoMs)).toBe(true); expect(Object.keys(j.duracoesMs).sort()).toEqual(['catalogo', 'estoque', 'financeiro', 'pedidos', 'perfil360', 'vendas']);
    for (const v of Object.values(j.duracoesMs)) expect(Number.isFinite(v)).toBe(true);
  });
});

describe('A2.2 — mensagens de exceção não vazam', () => {
  test('falha de ESCRITA no Firestore: a mensagem do erro ("escrita simulada") não aparece; só o código', () => {
    const r = rodar('ok', { HARNESS_FALHA_ESCRITA: 'pedidos_cache/latest,painel_cache/produtos_catalogo' });
    expect(r.log).not.toMatch(/escrita simulada|UNAVAILABLE/); expect(r.log).toMatch(/Firestore\.set\(pedidos_cache\/latest\) falhou \(codigo=ERRO_INESPERADO\)/);
  });
  test('falha de LEITURA e de LOTE: mensagens não aparecem', () => {
    const a = rodar('ok', { HARNESS_FALHA_LEITURA: 'painel_cache/vendas' }); expect(a.log).not.toMatch(/leitura simulada|UNAVAILABLE/);
    const b = rodar('ok', { HARNESS_FALHA_ESCRITA: 'painel_cache/caixa' }); expect(b.log).not.toMatch(/lote simulado|UNAVAILABLE/);
  });
});

describe('A2.2 — verificações estáticas do código', () => {
  const linhasLog = SRC.split('\n').map((l, i) => ({ l, n: i + 1 })).filter(x => /\blog\.(info|aviso|erro)\(/.test(x.l));
  test('nenhum console.* direto fora da definição do logger', () => {
    const fora = SRC.split('\n').map((l, i) => ({ l, n: i + 1 })).filter(x => /console\.(log|warn|error|info|debug|trace)\b|process\.std(out|err)\.write/.test(x.l) && !/^\s*(info|aviso|erro): m => console\./.test(x.l));
    expect(fora).toEqual([]);
  });
  test('toda interpolação em log.* usa só expressões permitidas (bloco, código, motivo, nome de documento, booleano de status)', () => {
    const PERMITIDAS = [/^bloco$/, /^estQ$/, /^estavelQ$/, /^sig8$/, /^pendQ$/, /^codAceite$/, /^codAceiteB$/, /^idAprovTxt$/, /^codigo$/, /^detalhe$/, /^nome$/, /^av\.motivo$/, /^colecao$/, /^docId$/, /^ops\.map\(o => o\.col \+ '\/' \+ o\.id\)\.join\(', '\)$/, /^codigoSeguro\((e|err)\)$/, /^result\.cursorAdvanced === true$/, /^agora\(\)$/, /^falhas\.length$/, /^falhas\.map\(f => f\.bloco \+ ':' \+ f\.codigo\)\.join\(', '\)$/, /^detalhe \? ' motivo=' \+ detalhe : ''$/,
      /^eOk \? '[^']*' : '[^']*'$/, /^pOk \? '[^']*' : '[^']*'$/];
    const ruins = [];
    for (const { l, n } of linhasLog) for (const m of l.matchAll(/\$\{((?:[^{}]|\{[^{}]*\})*)\}/g)) if (!PERMITIDAS.some(re => re.test(m[1].trim()))) ruins.push({ n, expr: m[1] });
    expect(ruins).toEqual([]);
  });
  test('nenhuma chamada de log usa .length, toFixed, brl(, .message, .stack, valores ou nomes', () => {
    const ruins = linhasLog.filter(x => /(?<!falhas)\.length|toFixed|\bbrl\(|\.message|\.stack|\bfat[A-Z]\w*|total(Vencido|Pagar|Receber)|\bR\$/.test(x.l)).map(x => x.n);
    expect(ruins).toEqual([]);
  });
  test('o RESUMO_SYNC é o único log.* com JSON.stringify e não recebe dados do negócio', () => {
    const js = linhasLog.filter(x => /JSON\.stringify/.test(x.l)); expect(js.length).toBe(1);
    expect(js[0].l).toMatch(/RESUMO_SYNC/); expect(js[0].l.replace(/falhas\.length/g, '')).not.toMatch(/\.length|vendas\b|total/);
  });
  test('registrarFalha: o detalhe nunca recebe contagens (somente enum de motivo)', () => {
    const chamadas = SRC.split('\n').filter(l => /registrarFalha\(/.test(l) && !/^function /.test(l));
    for (const l of chamadas) expect(l).not.toMatch(/\.length|novo=|anterior=|\$\{/);
  });
  test('handlers de exceção não tratada logam só código (sem stack)', () => {
    expect(SRC).toMatch(/process\.on\('unhandledRejection'/); expect(SRC).toMatch(/process\.on\('uncaughtException'/);
    expect(SRC.slice(SRC.indexOf("process.on('unhandledRejection'"), SRC.indexOf('function registrarFalha'))).not.toMatch(/\.stack|\.message/);
  });
  test('sync360 (usado pelo workflow) não registra e.message', () => { expect(fs.readFileSync(path.join(ROOT, 'functions/lib/sync360.js'), 'utf8')).not.toMatch(/console\.(warn|log|error)\([^)]*\.message/); });
  test('a lógica comercial/financeira não mudou: continuam os 5 documentos e os limites 70%/80%', () => {
    expect(SRC).toMatch(/detectarAnomalia\('financeiro', lancamentos\.length, totalAnterior, 0\.70\)/); expect(SRC).toMatch(/detectarAnomalia\('pedidos', pedidos\.length, totalAnterior, 0\.80\)/);
  });
});
