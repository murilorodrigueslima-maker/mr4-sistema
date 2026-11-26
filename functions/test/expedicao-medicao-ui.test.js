'use strict';
// Expedição — medição: o <script> REAL da página numa sandbox. Captura opcional não altera o quadro quando desligada,
// não move pedido, não bloqueia despacho. Dados sintéticos.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ler = p => fs.readFileSync(path.join(__dirname, '../..', p), 'utf8');
const HTML = ler('modulos/expedicao.html'), CORE = ler('js/expedicao-core.js'), MED = ler('js/expedicao-medicao-core.js'), TELA = ler('js/expedicao-medicao-tela.js');
const ini = HTML.indexOf('<script>\n// ── CONFIG'), SCRIPT = HTML.slice(ini + '<script>'.length, HTML.indexOf('</script>', ini));

function el() { return { textContent: '', innerHTML: '', value: '', disabled: false, style: {}, dataset: {}, classList: { add() { this.aberto = true; }, remove() { this.aberto = false; }, toggle() {}, contains: () => false }, addEventListener() {}, appendChild() {}, remove() {} }; }
function tela({ comMedicao = true, registrar = async () => 'OK', papel = 'funcionario', nucleo = null } = {}) {
  const elementos = {}, toasts = [], h = {}, gravacoes = [], transacoes = [], paineis = [];
  const ctx = { console: { log() {}, warn() {} }, Date, Number, String, Object, Math, JSON, Promise, Set, Array, Error, Map,
    setInterval: () => 0, setTimeout: () => 0, clearTimeout() {},
    document: { getElementById: id => (elementos[id] = elementos[id] || el()), querySelectorAll: () => [], querySelector: () => null, addEventListener() {}, createElement: () => el() } };
  ctx.window = ctx; ctx.globalThis = ctx;
  vm.createContext(ctx);
  vm.runInContext(CORE, ctx); if (nucleo) vm.runInContext(nucleo, ctx); else if (comMedicao) vm.runInContext(MED, ctx);
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

const MARCAS = t => t.gravacoes.filter(g => g.dados.tipo === 'MARCA');
const espera = () => new Promise(r => setImmediate(r));

describe('lote', () => {
  const tres = coluna => ['1', '2', '3'].map((numero, i) => pedido(coluna, { numero, ingresadoEm: Date.now() - (10 - i) * 60000, versao: 2, envio: coluna === 'ag' ? null : 'rota-manha' }));
  test('desligada: sem faixa, sem botão de lote; modo lote não abre', () => {
    const t = tela(); t.h.cfg({ ativa: false }); t.h.ativos(tres('ag'), [], false);
    t.ctx.alternarLote('ag');
    expect(t.S().sel).toBeNull();
    expect(t.elementos['medBanner'].style.display).toBe('none'); expect(t.elementos['lote-ag'].style.display).toBe('none'); expect(t.elementos['loteBar'].style.display).toBe('none');
    expect(t.col('ag')).toContain('iniciarSeparacao'); expect(t.col('ag')).not.toContain('selecionar(');
  });
  test('ligada: no modo lote o cartão só seleciona; as outras colunas seguem iguais; desligar sai do modo', () => {
    const t = tela(); t.h.cfg({ ativa: true }); t.h.ativos([...tres('ag'), pedido('se', { numero: '9' })], [], false);
    t.ctx.alternarLote('ag'); t.ctx.selecionar('1');
    expect(t.col('ag')).toContain('No lote'); expect(t.col('ag')).not.toContain('iniciarSeparacao'); expect(t.col('ag')).not.toContain('abrirCancelModal');
    expect(t.col('se')).toContain('marcarSeparado'); expect(t.elementos['loteBar'].innerHTML).toContain('1 selecionado');
    t.ctx.selecionarTodos(); expect(t.S().sel.nums.size).toBe(3);
    t.h.cfg({ ativa: false }); expect(t.S().sel).toBeNull(); expect(t.col('ag')).toContain('iniciarSeparacao');
  });
});

describe('lote — execução (transações individuais do núcleo, lote só anotado)', () => {
  const rodar = () => {
    const t = tela(); const acoes = [];
    // adaptador de verdade sobre um "banco" em memória: o núcleo real planeja cada transição
    const banco = new Map();
    t.ctx._expAdapter = { transacao: fn => fn({ ler: async n => banco.get(n), atualizar: (n, c) => { banco.set(n, { ...banco.get(n), ...c }); acoes.push({ n, ...c }); }, criarEvento: () => {} }) };
    const mostrar = lista => { lista.forEach(p => banco.set(p.numero, p)); t.h.ativos([...banco.values()], [], false); };
    return { ...t, acoes, banco, mostrar };
  };
  const ag = n => pedido('ag', { numero: n, versao: 0, envio: null });

  test('iniciar em lote: um envio para todos, uma transação por pedido, mesma marca de lote; concluir o lote em 1 clique herda o lote', async () => {
    const t = rodar(); t.h.cfg({ ativa: true }); t.mostrar([ag('1'), ag('2'), ag('3')]);
    t.ctx.alternarLote('ag'); t.ctx.selecionarTodos(); await t.ctx.loteAcao('separar');
    expect(t.acoes).toHaveLength(0);                                      // primeiro escolhe o envio
    t.ctx.selEnvio({ classList: { add() {} }, dataset: { envio: 'rota-tarde' } }); await t.ctx.confirmarModal(); await espera();
    expect(t.acoes.map(a => [a.n, a.coluna, a.envio]).sort()).toEqual([['1', 'se', 'rota-tarde'], ['2', 'se', 'rota-tarde'], ['3', 'se', 'rota-tarde']]);
    const m = MARCAS(t); expect(m.map(x => x.id).sort()).toEqual(['1_marca_v1', '2_marca_v1', '3_marca_v1']);
    const lote = m[0].dados.lote; expect(m.every(x => x.dados.lote === lote && x.dados.loteTam === 3 && x.dados.etapa === 'INICIAR_SEPARACAO' && !x.dados.depois)).toBe(true);
    expect(t.S().sel).toBeNull();
    t.mostrar([...t.banco.values()]); t.h.regs(m.map(x => ({ ...x.dados, em: Date.now() })));
    expect(t.col('se')).toContain(`concluirLote('${lote}')`); expect(t.col('se')).toContain('Concluir lote (3)');
    await t.ctx.concluirLote(lote); await espera();
    const fim = MARCAS(t).filter(x => x.dados.etapa === 'MARCAR_SEPARADO');
    expect(fim).toHaveLength(3); expect(fim.every(x => x.dados.lote === lote && x.id.endsWith('_marca_v2'))).toBe(true);
    expect([...t.banco.values()].every(p => p.coluna === 'pr')).toBe(true);
  });
  test('um pedido só no "lote" é individual: nenhuma anotação; clique individual também não anota', async () => {
    const t = rodar(); t.h.cfg({ ativa: true }); t.mostrar([pedido('se', { numero: '1' }), pedido('se', { numero: '2' })]);
    t.ctx.alternarLote('se'); t.ctx.selecionar('1'); await t.ctx.loteAcao('separado'); await t.ctx.marcarSeparado('2'); await espera();
    expect(t.acoes).toHaveLength(2); expect(t.gravacoes).toHaveLength(0);
  });
  test('despacho em lote mantém o envio de cada pedido; quem mudou em outra tela fica de fora', async () => {
    const t = rodar(); t.h.cfg({ ativa: true }); t.mostrar([pedido('pr', { numero: '1', envio: 'rota-manha' }), pedido('pr', { numero: '2', envio: 'uber-mr4' }), pedido('pr', { numero: '3' })]);
    t.ctx.alternarLote('pr'); t.ctx.selecionarTodos(); await t.ctx.loteAcao('despachar');
    expect(t.S().envioSel).toBe('manter');
    t.mostrar([pedido('de', { numero: '3', saidaEm: Date.now() })]);       // outra tela despachou o 3
    await t.ctx.confirmarModal(); await espera();
    expect(t.acoes.map(a => [a.n, a.envio]).sort()).toEqual([['1', 'rota-manha'], ['2', 'uber-mr4']]);
    expect(MARCAS(t).map(x => x.dados.loteTam)).toEqual([2, 2]);
  });
  test('conferência em lote: registros (não transações), início e fim com o mesmo lote; já conferido não repete', async () => {
    const t = rodar(); t.h.cfg({ ativa: true }); t.mostrar([pedido('pr', { numero: '1' }), pedido('pr', { numero: '2' })]);
    t.ctx.alternarLote('pr'); t.ctx.selecionarTodos(); await t.ctx.loteAcao('conf-inicio');
    const ini = t.gravacoes.map(g => g.dados); expect(ini.map(d => d.tipo)).toEqual(['CONFERENCIA_INICIO', 'CONFERENCIA_INICIO']);
    t.h.regs(ini.map(d => ({ ...d, em: Date.now() }))); expect(t.col('pr')).toContain('Conferindo desde');
    t.ctx.alternarLote('pr'); t.ctx.selecionarTodos(); await t.ctx.loteAcao('conferido');
    const fim = t.gravacoes.slice(2).map(g => g.dados); expect(fim.map(d => [d.tipo, d.lote])).toEqual([['CONFERENCIA', ini[0].lote], ['CONFERENCIA', ini[0].lote]]);
    t.h.regs([...ini, ...fim].map(d => ({ ...d, em: Date.now() })));
    t.ctx.alternarLote('pr'); t.ctx.selecionarTodos(); await t.ctx.loteAcao('conferido');
    expect(t.gravacoes).toHaveLength(4); expect(t.acoes).toHaveLength(0);
  });
  test('falha parcial: avisa quantos foram e só anota os que mudaram', async () => {
    const t = rodar(); t.h.cfg({ ativa: true }); t.mostrar([pedido('se', { numero: '1' }), pedido('se', { numero: '2' })]);
    t.banco.set('2', pedido('pr', { numero: '2' }));                       // o servidor já está à frente
    t.ctx.alternarLote('se'); t.ctx.selecionarTodos(); await t.ctx.loteAcao('separado'); await espera();
    expect(MARCAS(t).map(x => x.dados.pedido)).toEqual(['1']);
    expect(t.toasts.some(x => /1 de 2 separados/.test(x.m))).toBe(true);
  });
  test('"estou registrando depois": marca transições e registros até desligar; com a medição desligada não faz nada', async () => {
    const t = rodar(); t.mostrar([pedido('se', { numero: '1' }), pedido('pr', { numero: '2' })]);
    t.ctx.alternarDepois(); expect(t.S().depoisAte).toBe(0);
    t.h.cfg({ ativa: true }); t.ctx.alternarDepois(); expect(t.elementos['medBannerTexto'].innerHTML).toContain('Registrando depois');
    await t.ctx.marcarSeparado('1'); await t.ctx.marcarConferido('2'); await espera();
    expect(t.gravacoes.map(g => [g.id, g.dados.depois]).sort()).toEqual([['1_marca_v3', true], ['2_conf_v2', true]]);
    t.ctx.alternarDepois(); await t.ctx.iniciarConferencia('2'); expect(t.gravacoes[2].dados).not.toHaveProperty('depois');
  });
  test('anotação recusada não desfaz nem esconde a mudança do pedido', async () => {
    const t = rodar(); t.h.cfg({ ativa: true }); t.mostrar([pedido('se', { numero: '1' })]); t.ctx._expRegistrar = async () => { throw new Error('permission-denied'); };
    t.ctx.alternarDepois(); await t.ctx.marcarSeparado('1'); await espera(); await espera();
    expect(t.banco.get('1').coluna).toBe('pr'); expect(t.toasts.some(x => /mudança foi salva/.test(x.m))).toBe(true);
  });
});

describe('entrega, banner e arquivo antigo em cache', () => {
  test('"Entregue" só em Despachados de Uber MR4/rota; retirada não pede clique; "Problema" na saída', async () => {
    const t = tela(); t.h.cfg({ ativa: true });
    t.h.hoje([pedido('de', { numero: '1', envio: 'rota-manha', saidaEm: Date.now() }), pedido('de', { numero: '2', envio: 'retirada', saidaEm: Date.now() })]);
    expect(t.col('de')).toContain("marcarEntregue('1')"); expect(t.col('de')).not.toContain("marcarEntregue('2')"); expect(t.col('de')).toContain("abrirProblemaModal('2')");
    await t.ctx.marcarEntregue('1'); expect(t.gravacoes[0].id).toBe('1_entrega_v2');
    t.h.regs([{ ...t.gravacoes[0].dados, em: Date.now() }]); expect(t.col('de')).toMatch(/Entregue \d\d:\d\d/);
    t.ctx.alternarLote('de'); t.ctx.selecionarTodos(); expect(t.S().sel.nums.size).toBe(0);
  });
  test('faixa para toda a equipe diz o dia e o aviso de uso', () => {
    const t = tela(); const hoje = new Date().toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
    t.h.cfg({ ativa: true, inicio: hoje }); t.h.ativos([pedido('ag')], [], false);
    const texto = t.elementos['medBannerTexto'].innerHTML;
    expect(texto).toContain('dia 1 de 7'); expect(texto).toContain('não é usada para punir, descontar ou avaliar ninguém');
  });
  test('núcleo de versão antiga (cache) = medição desligada, quadro normal', async () => {
    const t = tela({ nucleo: "window.ExpedicaoMedicao={configAtiva:()=>true}" });
    t.h.ativos([pedido('pr')], [], false); expect(t.col('pr')).toContain('abrirDespacho'); expect(t.col('pr')).not.toContain('card-med');
  });
});

describe('o painel e o aviso (estático)', () => {
  test('aviso de uso no painel; sem coluna ou ranking por operador', () => {
    expect(HTML).toContain('Não serve para punição, desconto ou avaliação de funcionários');
    expect(HTML + MED + TELA).not.toMatch(/Cliques por operador|codigosDeOperador/);
    expect(HTML).toMatch(/id="medInicio"/); expect(TELA).toMatch(/definirConfig/);
  });
});

describe('leituras sob demanda (estático)', () => {
  test('o painel é importado só no clique; consultas só dentro do cálculo; a página segue sem getDocs', () => {
    expect(HTML).toMatch(/await import\('\.\.\/js\/expedicao-medicao-tela\.js\?v=2'\)/);
    expect(HTML).not.toMatch(/from '\.\.\/js\/expedicao-medicao-tela\.js'/);
    expect(HTML).not.toMatch(/getDocs\s*\(|setDoc\s*\(|updateDoc\s*\(|addDoc\s*\(|deleteDoc\s*\(/);
    expect(TELA).not.toMatch(/onSnapshot|setDoc\s*\(|updateDoc\s*\(|deleteDoc\s*\(|addDoc\s*\(/);
    expect(TELA.match(/getDocs\(/g)).toHaveLength(1);
    expect(TELA).toMatch(/limit\(TETO_PEDIDOS \+ 1\)/);
  });
});
