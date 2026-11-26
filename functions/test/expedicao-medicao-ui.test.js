'use strict';
// Expedição — medição: o <script> REAL da página numa sandbox. Captura opcional não altera o quadro quando desligada,
// não move pedido, não bloqueia despacho. Dados sintéticos.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ler = p => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const HTML = ler('modulos/expedicao.html'), CORE = ler('js/expedicao-core.js'), MED = ler('js/expedicao-medicao-core.js'), TELA = ler('js/expedicao-medicao-tela.js');
const ini = HTML.indexOf('<script>\n// ── CONFIG'), SCRIPT = HTML.slice(ini + '<script>'.length, HTML.indexOf('</script>', ini));

function el() { return { textContent: '', innerHTML: '', value: '', disabled: false, style: {}, dataset: {}, classList: { add() { this.aberto = true; }, remove() { this.aberto = false; }, toggle() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {} }; }
function tela({ comMedicao = true, registrar = async () => 'OK', papel = 'funcionario' } = {}) {
  const elementos = {}, toasts = [], h = {}, gravacoes = [], transacoes = [], paineis = [];
  const ctx = { console: { log() {}, warn() {} }, Date, Number, String, Object, Math, JSON, Promise, Set, Array, Error, Map,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: id => (elementos[id] = elementos[id] || el()), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => el() } };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx); if (comMedicao) vm.runInContext(MED, ctx);
  ctx._expAdapter = { transacao: async fn => { transacoes.push(fn); return {}; } };
  ctx._expServerTimestamp = () => '__TS__';
  ctx._expUsuario = { uid: 'u-a', papel };
  ctx._expOuvir = (i, handlers) => { Object.assign(h, handlers); return () => {}; };
  ctx._expOuvirSync = () => {};
  ctx._expOuvirMedicao = (cfg, regs) => { h.cfg = cfg; h.regs = regs; };
  ctx._expRegistrar = async (id, dados) => { gravacoes.push({ id, dados }); return registrar(id, dados); };
  ctx._expPainelMedicao = async o => { paineis.push(o); return { mostrarCaptura() {} }; };
  vm.runInContext(SCRIPT + '\n;globalThis.__S = S; toast = (m, t) => { globalThis.__toasts.push({ m, t }); };', Object.assign(ctx, { __toasts: toasts }));
  ctx.iniciarPainel();
  const col = c => (elementos['col-' + c] ? elementos['col-' + c].innerHTML : '');
  return { ctx, h, toasts, gravacoes, transacoes, paineis, elementos, col, S: () => ctx.__S };
}
const pedido = (coluna, o = {}) => ({ numero: '1000001', coluna, versao: 2, ingresadoEm: Date.now() - 60000, movidoEm: Date.now(), cliente: 'Cliente Sintético', vendedor: 'V', itens: 1, valor: 10, cidade: '', envio: 'retirada', saidaEm: null, data: '', hora: '', ...o });

describe('captura opcional na tela', () => {
  test('DESLIGADA (sem configuração): cartão idêntico ao de antes, também se o núcleo da medição não carregar', () => {
    const sem = tela({ comMedicao: false }), com = tela();
    for (const t of [sem, com]) t.h.ativos([pedido('pr')], [], false);
    com.h.cfg(null); com.h.cfg({ ativa: false });
    expect(com.col('pr')).not.toMatch(/Conferido|Problema|card-med/);
    expect(com.col('pr')).toBe(sem.col('pr'));
    expect(com.col('pr')).toContain('abrirDespacho');
  });
  test('LIGADA: "Conferido" só em Pronto; "Problema" em Separando e Pronto; nada em Aguardando; despacho continua livre', () => {
    const t = tela(); t.h.cfg({ ativa: true });
    t.h.ativos([pedido('ag', { numero: '1' }), pedido('se', { numero: '2' }), pedido('pr', { numero: '3' })], [], false);
    expect(t.col('ag')).not.toMatch(/card-med/);
    expect(t.col('se')).toMatch(/abrirProblemaModal/); expect(t.col('se')).not.toMatch(/marcarConferido/);
    expect(t.col('pr')).toMatch(/marcarConferido\('3'\)/); expect(t.col('pr')).toMatch(/abrirDespacho\('3'\)/);
  });
  test('1 clique grava só o registro (sem transação no pedido) e o cartão confirma pelo listener', async () => {
    const t = tela(); t.h.cfg({ ativa: true }); t.h.ativos([pedido('pr')], [], false);
    await t.ctx.marcarConferido('1000001');
    expect(t.gravacoes).toEqual([{ id: '1000001_conf_v2', dados: { pedido: '1000001', tipo: 'CONFERENCIA', versao: 2, em: '__TS__', por: 'u-a' } }]);
    expect(t.transacoes).toHaveLength(0); expect(t.S().pedidos['1000001'].coluna).toBe('pr'); expect(t.S().processando.size).toBe(0);
    t.h.regs([{ pedido: '1000001', tipo: 'CONFERENCIA', versao: 2, em: Date.now() }]);
    expect(t.col('pr')).toMatch(/med-feito/); expect(t.col('pr')).not.toMatch(/marcarConferido/);
    t.h.ativos([pedido('pr', { versao: 6 })], [], false);              // novo ciclo (reaberto): conferência antiga não vale
    expect(t.col('pr')).toMatch(/marcarConferido/);
  });
  test('falha ao gravar: avisa, não trava o cartão e não finge sucesso', async () => {
    const t = tela({ registrar: async () => { throw new Error('permission-denied'); } }); t.h.cfg({ ativa: true }); t.h.ativos([pedido('pr')], [], false);
    await t.ctx.marcarConferido('1000001');
    expect(t.toasts.some(x => /não salvo/.test(x.m))).toBe(true); expect(t.toasts.some(x => x.t === 't-success')).toBe(false);
    expect(t.S().processando.size).toBe(0); expect(t.col('pr')).toContain('abrirDespacho');
  });
  test('problema: exige motivo; grava motivo e retrabalho; desligar fecha a janela e some com os botões', async () => {
    const t = tela(); t.h.cfg({ ativa: true }); t.h.ativos([pedido('se')], [], false);
    t.ctx.abrirProblemaModal('1000001');
    await t.ctx.confirmarProblema(true); expect(t.gravacoes).toHaveLength(0);
    t.ctx.selMotivo({ classList: { add() {} }, dataset: { motivo: 'NAO_LOCALIZADO' } });
    await t.ctx.confirmarProblema(true);
    expect(t.gravacoes[0]).toEqual({ id: '1000001_oc_v2_NAO_LOCALIZADO', dados: { pedido: '1000001', tipo: 'OCORRENCIA', versao: 2, em: '__TS__', por: 'u-a', motivo: 'NAO_LOCALIZADO', retrabalho: true } });
    t.h.cfg({ ativa: false });
    expect(t.col('se')).not.toMatch(/card-med/); expect(t.S().probNum).toBeNull();
  });
  test('painel: só gestor abre; nenhuma consulta de medição antes do clique', async () => {
    const f = tela(); await f.ctx.abrirMedicao(); expect(f.paineis).toHaveLength(0);
    const g = tela({ papel: 'gestor' }); expect(g.paineis).toHaveLength(0);
    await g.ctx.abrirMedicao(); await g.ctx.abrirMedicao(); expect(g.paineis).toHaveLength(1);
  });
});

describe('leituras sob demanda (estático)', () => {
  test('o painel é importado só no clique; consultas só dentro do cálculo; a página segue sem getDocs', () => {
    expect(HTML).toMatch(/await import\('\.\.\/js\/expedicao-medicao-tela\.js'\)/);
    expect(HTML).not.toMatch(/from '\.\.\/js\/expedicao-medicao-tela\.js'/);
    expect(HTML).not.toMatch(/getDocs\s*\(|setDoc\s*\(|updateDoc\s*\(|addDoc\s*\(|deleteDoc\s*\(/);
    expect(TELA).not.toMatch(/onSnapshot|setDoc\s*\(|updateDoc\s*\(|deleteDoc\s*\(|addDoc\s*\(/);
    expect(TELA.match(/getDocs\(/g)).toHaveLength(1);
    expect(TELA).toMatch(/limit\(TETO_PEDIDOS \+ 1\)/);
  });
});
