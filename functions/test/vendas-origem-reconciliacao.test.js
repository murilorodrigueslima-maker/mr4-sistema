'use strict';
// Reconciliação de vendas excluídas/canceladas — integridade ponta a ponta (GestãoClick falso só-GET).
// Padrão: Firestore em memória. VEXC_EMULADOR=host:porta roda os MESMOS cenários no emulador (transações reais).
const EMU = process.env.VEXC_EMULADOR || null;
if (EMU) process.env.FIRESTORE_EMULATOR_HOST = EMU;
const F = require('./fixtures/vendas-origem');
const X = require('../lib/vendasOrigem/execucao');
const P = require('../lib/vendasOrigem/persistencia');
const PV = require('../lib/reativacaoVendas');
const { calcularPerfil360 } = require('../lib/perfil360');
jest.setTimeout(240000);

let admin, seq = 0;
async function novoDb() {
  if (!EMU) return undefined;
  admin = admin || require('firebase-admin');
  const projectId = `demo-vexc-${process.pid}-${++seq}`, app = admin.initializeApp({ projectId }, projectId);
  return app.firestore();
}
const mundo = async o => F.criarMundo({ db: await novoDb(), ...o });
afterAll(async () => { if (admin) await Promise.all(admin.apps.map(a => a.delete())); });

// cenário real: duas vendas do mesmo cliente; a de 25/11 some da lista e por id responde "Cancelada" sem mudar modificado_em
const ALVO = '415281034';
const alvo = () => F.gcVenda(ALVO, '2026-11-25');
const antiga = () => F.gcVenda('400000001', '2026-11-10');
const cancelarNaOrigem = m => { const v = m.gc.vendas.get(ALVO); m.gc.vendas.set(ALVO, { ...v, nome_situacao: 'Cancelada', situacao_id: '3952594', situacao_estoque: '0' }); m.gc.foraDaLista.add(ALVO); };
const excluirNaOrigem = m => m.gc.vendas.delete(ALVO);
const NEGOCIO = ['vendas_gc', 'perfis_360', 'clientes', 'carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacao_decisoes', 'carteira_comercial_revisoes', 'financeiro_cache', 'fin_n1', 'painel_cache', 'display_metrics', 'compras_n0', 'compras_n0_base', 'expedicao_pedidos', 'sync_state', 'audit_log'];
const retrato = async m => Object.fromEntries(await Promise.all(NEGOCIO.map(async c => [c, await m.col(c)])));

async function comPerfil(m) {
  await m.db.collection('clientes').doc('cli-300').set({ gestaoClickId: '300' });
  const vendas = Object.values(await m.col('vendas_gc')).filter(v => v.cliente_id === '300');
  const perfil = calcularPerfil360({ clienteMr4Id: 'cli-300', gestaoClickId: '300', vendas, produtosPorId: { P1: { id: 'P1', nome_grupo: 'LAMPADAS' } }, dataReferencia: F.HOJE, calculadoEm: 'ANTES' });
  await m.db.collection('perfis_360').doc('cli-300').set({ ...perfil, campoProprio: 'preservar' });
  await m.db.collection('financeiro_cache').doc('latest').set({ total: 1 });
  await m.db.collection('painel_cache').doc('vendas').set({ mes: 1 });
  await m.db.collection('display_metrics').doc('latest').set({ x: 1 });
  await m.db.collection('carteira_comercial').doc('GC:300').set({ ownerUid: 'u1', versao: 1 });
}

describe('modo e custo', () => {
  test('DESLIGADO (sem configuração): nenhuma requisição ao GestãoClick e nada gravado', async () => {
    const m = await mundo({ extras: [alvo()] }); cancelarNaOrigem(m);
    expect(await m.rodar()).toEqual({ status: 'DESLIGADO', modo: 'DESLIGADO' });
    expect(m.gc.chamadas).toHaveLength(0);
    for (const c of ['vendas_origem_candidatos', 'vendas_origem_trilha', 'vendas_origem_estado']) expect(await m.col(c)).toEqual({});
  });
  test('sem ausências: custo = só as páginas da lista (sem consulta por id)', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('SOMBRA');
    const r = await m.rodar();
    expect(r).toMatchObject({ status: 'OK', profunda: true, requisicoesGc: 1, leiturasEspelho: 31 });
    expect(await m.col('vendas_origem_candidatos')).toEqual({});
  });
  test('intervalo mínimo entre detecções; execução profunda 1×/24 h', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('SOMBRA');
    await m.rodar();
    expect((await m.rodar({ avancar: 2 })).status).toBe('AGUARDANDO_INTERVALO');
    expect((await m.rodar({ avancar: 3 }))).toMatchObject({ status: 'OK', profunda: false });
    expect((await m.rodar({ avancar: 20 }))).toMatchObject({ status: 'OK', profunda: true });
  });
  test('toda chamada é GET com loja_id=262759', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR'); excluirNaOrigem(m); await m.vezes(6);
    expect(m.gc.chamadas.length).toBeGreaterThan(5);
    expect(m.gc.chamadas.every(c => c.method === 'GET' && c.loja === '262759')).toBe(true);
  });
});

describe('FASE 1 — sombra', () => {
  test('cancelada que some da lista: confirma em 3 leituras e NÃO muda nenhum dado de negócio', async () => {
    const m = await mundo({ extras: [alvo(), antiga()] }); await comPerfil(m); await m.modo('SOMBRA'); cancelarNaOrigem(m);
    const antes = await retrato(m);
    await m.rodar(); expect(await m.cand(ALVO)).toMatchObject({ estado: 'OBSERVANDO', classe: 'CANCELADA', invalidacaoAtiva: false });
    await m.rodar(); expect((await m.cand(ALVO)).estado).toBe('OBSERVANDO');
    const r = await m.rodar();
    expect(r).toMatchObject({ status: 'OK', modo: 'SOMBRA', confirmadas: 1, aplicadas: 0 });
    const c = await m.cand(ALVO);
    expect(c).toMatchObject({ estado: 'CONFIRMADA', invalidacaoAtiva: false, sequencia: { n: 3 }, evidencia: { fonte: 'CONSULTA_POR_ID', detalhe: { situacao: 'Cancelada', loja: 'ATIVA' }, espelho: { situacao: 'Concretizada' } } });
    expect(c.impacto).toMatchObject({ vinculosCarteira: { total: 0 }, expedicao: { pedido: '9' + ALVO, existe: false } });
    await m.vezes(4);
    expect(await retrato(m)).toEqual(antes);
    expect(JSON.stringify(await m.col('vendas_origem_candidatos')) + JSON.stringify(await m.col('vendas_origem_trilha'))).not.toMatch(/SECRETO/);
  });
  test('excluída (404): exige 4 leituras e 24 h', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('SOMBRA'); excluirNaOrigem(m);
    await m.vezes(4); expect(await m.cand(ALVO)).toMatchObject({ estado: 'OBSERVANDO', classe: 'NAO_ENCONTRADA' });   // 4 leituras, 18 h
    await m.rodar(); expect((await m.cand(ALVO)).estado).toBe('CONFIRMADA');
  });
  test('trilha é append-only: um documento por versão, nunca reescrito', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('SOMBRA'); cancelarNaOrigem(m);
    await m.rodar(); const um = await m.col('vendas_origem_trilha');
    await m.vezes(3); const tudo = await m.col('vendas_origem_trilha');
    for (const [id, d] of Object.entries(um)) expect(tudo[id]).toEqual(d);
    expect(Object.keys(tudo).length).toBe((await m.cand(ALVO)).versao);
  });
});

describe('falsos positivos', () => {
  test('404 isolado seguido de reaparecimento: nada é confirmado', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR');
    const v = m.gc.vendas.get(ALVO); excluirNaOrigem(m); await m.rodar();
    m.gc.vendas.set(ALVO, v); await m.rodar();
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'DESCARTADA', aberta: false });
    await m.vezes(5); expect((await m.doc('vendas_gc', ALVO)).nome_situacao).toBe('Concretizada');
  });
  test('consulta por id fora do ar (404 para TUDO): o controle positivo derruba a execução', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR'); excluirNaOrigem(m);
    m.gc.falha = u => (/^\/vendas\/\d+$/.test(u.pathname) ? 404 : null);
    const r = await m.vezes(8);
    expect(r).toMatchObject({ status: 'ANOMALIA', anomalia: 'CONTROLE_POR_ID_FALHOU' });
    expect(await m.col('vendas_origem_candidatos')).toEqual({});
  });
  test.each([500, 429])('consulta por id com HTTP %s: erro temporário, nada contado', async status => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR'); excluirNaOrigem(m); m.gc.detalhe.set(ALVO, status);
    const r = await m.vezes(6);
    expect(r.observacoes).toEqual({ ERRO_TEMPORARIO: 1 }); expect(await m.cand(ALVO)).toBe(null);
  });
  test('paginação incompleta: execução falha sem efeito e é repetida no próximo ciclo', async () => {
    const m = await mundo({ extras: [alvo()], fundo: 150 }); await m.modo('APLICAR'); excluirNaOrigem(m);
    m.gc.falha = u => (u.pathname === '/vendas' && u.searchParams.get('pagina') === '2' ? 'incompleta' : null);
    for (let i = 0; i < 6; i++) expect(await m.rodar()).toMatchObject({ status: 'FALHA', codigo: 'GC_PAGINACAO_INCOMPLETA' });
    expect(await m.col('vendas_origem_candidatos')).toEqual({});
    expect((await m.doc('vendas_origem_estado', 'reconciliacao')).ultimaDeteccaoEm).toBeUndefined();
    m.gc.falha = null; expect(await m.rodar({ avancar: 1 })).toMatchObject({ status: 'OK' });
  });
  test('erro 500 numa página da lista: sem efeito', async () => {
    const m = await mundo({ extras: [alvo()], fundo: 150 }); await m.modo('APLICAR'); excluirNaOrigem(m);
    m.gc.falha = u => (u.searchParams.get('pagina') === '2' ? 500 : null);
    expect((await m.rodar()).status).toBe('FALHA'); expect(await m.col('vendas_origem_candidatos')).toEqual({});
  });
  test('lista vazia ou encolhida (metadados coerentes): anomalia, nada contado', async () => {
    const m = await mundo({ extras: [alvo()], fundo: 100 }); await m.modo('APLICAR');
    for (let i = 0; i < 40; i++) m.gc.foraDaLista.add(String(1000 + i));
    expect(await m.vezes(5)).toMatchObject({ status: 'ANOMALIA', anomalia: 'LISTA_MUITO_MENOR_QUE_O_ESPELHO' });
    m.gc.vendas.clear(); expect((await m.rodar())).toMatchObject({ status: 'FALHA', codigo: 'GC_VAZIO_INESPERADO' });
    expect(await m.col('vendas_origem_candidatos')).toEqual({});
  });
  test('muitas ausências de uma vez: limite de volume', async () => {
    const m = await mundo({ extras: [alvo()], fundo: 100 }); await m.modo('APLICAR');
    for (let i = 0; i < 20; i++) m.gc.vendas.delete(String(1000 + i));
    expect(await m.rodar()).toMatchObject({ status: 'ANOMALIA', anomalia: 'AUSENCIAS_ACIMA_DO_LIMITE' });
    expect(await m.col('vendas_origem_candidatos')).toEqual({});
  });
  test('ausente só na 1ª leitura (lista instável): a conferência do dia descarta', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR');
    m.gc.foraDaLista.add(ALVO); let n = 0;
    const original = m.gc.transporte;
    m.gc.transporte = async (u, o) => { const r = await original(u, o); if (++n === 1) m.gc.foraDaLista.delete(ALVO); return r; };
    await m.rodar();
    expect(await m.cand(ALVO)).toBe(null);
    expect(m.gc.chamadas.some(c => /\/vendas\/415281034/.test(c.url))).toBe(false);
  });
  test('data editada para fora do período: não é exclusão', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR');
    m.gc.vendas.set(ALVO, { ...alvo(), data: '2024-01-15' });
    await m.vezes(8);
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'DESCARTADA', classe: 'DATA_ALTERADA', aberta: false, invalidacaoAtiva: false });
    expect((await m.doc('vendas_gc', ALVO)).nome_situacao).toBe('Concretizada');
  });
  test('data editada dentro do período: venda presente, nada acontece', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR'); m.gc.vendas.set(ALVO, { ...alvo(), data: '2026-11-02' });
    await m.vezes(5); expect(await m.col('vendas_origem_candidatos')).toEqual({});
  });
  test('filtro de loja: registro de outra loja por id nunca invalida', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR');
    m.gc.foraDaLista.add(ALVO); m.gc.detalhe.set(ALVO, { ...alvo(), loja_id: '424483', nome_loja: 'OUTRA', nome_situacao: 'Cancelada' });
    await m.vezes(8);
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'INCONCLUSIVA', classe: 'OUTRA_LOJA', invalidacaoAtiva: false });
    expect((await m.doc('vendas_gc', ALVO)).nome_situacao).toBe('Concretizada');
  });
  test('lista contendo registro de outra loja aborta a leitura inteira', async () => {
    const m = await mundo({ extras: [alvo(), F.gcVenda('777', '2026-11-20', { loja_id: '424483' })] }); await m.modo('APLICAR'); excluirNaOrigem(m);
    expect(await m.rodar()).toMatchObject({ status: 'FALHA', codigo: 'GC_LOJA_DIVERGENTE' });
    expect(await m.col('vendas_origem_candidatos')).toEqual({});
  });
  test('404 de venda anterior ao isolamento de loja, sem outra prova: inconclusiva para sempre', async () => {
    const velha = F.gcVenda('300000001', '2026-11-12');
    const m = await mundo({ extras: [velha] }); await m.modo('APLICAR'); m.gc.vendas.delete(velha.id);
    await m.vezes(10);
    expect(await m.cand(velha.id)).toMatchObject({ estado: 'INCONCLUSIVA', classe: 'SEM_PROVA_DE_LOJA', invalidacaoAtiva: false });
  });
  test('ativa por id mas fora da lista (filtro desconhecido): inconclusiva', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR'); m.gc.foraDaLista.add(ALVO);
    await m.vezes(10);
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'INCONCLUSIVA', classe: 'ATIVA_FORA_DA_LISTA' });
  });
  test('cancelamento visível NA LISTA com espelho desatualizado também é detectado, sem consulta por id', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('SOMBRA');
    m.gc.vendas.set(ALVO, { ...alvo(), nome_situacao: 'Cancelada', situacao_id: '3952594' });
    await m.vezes(3);
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'CONFIRMADA', classe: 'CANCELADA', evidencia: { fonte: 'LISTA_PERIODO' } });
    expect(m.gc.chamadas.some(c => /\/vendas\/\d+/.test(c.url))).toBe(false);
  });
  test('o sync normal já corrigiu o espelho: candidata encerrada sem aplicar', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR'); cancelarNaOrigem(m); await m.rodar();
    await m.db.collection('vendas_gc').doc(ALVO).update({ nome_situacao: 'Cancelada' });
    expect((await m.rodar()).encerradas).toBe(1);
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'RESOLVIDA_PELO_SYNC', aberta: false, invalidacaoAtiva: false });
  });
});

describe('FASE 2 — aplicar', () => {
  async function aplicado(extra = {}) {
    const m = await mundo({ extras: [alvo(), antiga()] }); await comPerfil(m); await m.modo('APLICAR', extra); cancelarNaOrigem(m);
    const original = await m.doc('vendas_gc', ALVO), antes = await retrato(m);
    const r = await m.vezes(3);
    return { m, r, original, antes };
  }
  test('marca sem excluir, preserva a situação anterior, recalcula o perfil e não toca em mais nada', async () => {
    const { m, r, original, antes } = await aplicado();
    expect(r).toMatchObject({ confirmadas: 1, aplicadas: 1, retidasCarteira: 0, recalculo: { perfis: 1, falhas: 0 } });
    const v = await m.doc('vendas_gc', ALVO);
    expect(v).toMatchObject({ ...original, nome_situacao: 'Cancelada', invalidacao_origem: { classe: 'CANCELADA', situacaoAnterior: 'Concretizada' } });
    const perfil = await m.doc('perfis_360', 'cli-300');
    expect(perfil).toMatchObject({ pedidosTotal: 1, faturamentoTotal: 100, ultimaCompraEm: '2026-11-10', campoProprio: 'preservar' });
    expect(perfil.categoriasMaisCompradas[0].categoria).toBe('LAMPADAS');
    const depois = await retrato(m);
    for (const c of NEGOCIO.filter(c => !['vendas_gc', 'perfis_360'].includes(c))) expect({ c, d: depois[c] }).toEqual({ c, d: antes[c] });
    expect(Object.keys(depois.vendas_gc).sort()).toEqual(Object.keys(antes.vendas_gc).sort());
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'APLICADA', invalidacaoAtiva: true, crm: 'APLICADA', recalculoPendente: false });
  });
  test('excluída vira "Excluída na origem" e deixa de contar para a carteira', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('APLICAR'); excluirNaOrigem(m); await m.vezes(5);
    const v = await m.doc('vendas_gc', ALVO);
    expect(v.nome_situacao).toBe('Excluída na origem');
    expect(require('../lib/carteiraRegra').validarVenda(v, F.HOJE)).toBe('SITUACAO_NAO_CONCRETIZADA');
  });
  test('reaparecimento: espelho volta idêntico ao original, perfil recalculado de volta', async () => {
    const { m, original } = await aplicado(); const perfilAplicado = await m.doc('perfis_360', 'cli-300');
    m.gc.vendas.set(ALVO, alvo()); m.gc.foraDaLista.clear();
    const r = await m.rodar();
    expect(r.revertidas).toBe(1);
    expect(await m.doc('vendas_gc', ALVO)).toEqual(original);
    expect(await m.doc('perfis_360', 'cli-300')).toMatchObject({ pedidosTotal: 2, ultimaCompraEm: '2026-11-25' });
    expect(perfilAplicado.pedidosTotal).toBe(1);
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'REAPARECIDA', invalidacaoAtiva: false, aberta: false, crm: 'REVERTIDA' });
    const tipos = Object.values(await m.col('vendas_origem_trilha')).map(x => x.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['OBSERVACAO', 'IMPACTO', 'APLICACAO', 'REVERSAO', 'RECALCULO_PERFIL']));
  });
  test('reaparecimento via sync (espelho regravado): a invalidação cai sem reescrever o registro novo', async () => {
    const { m } = await aplicado();
    const novo = F.espelho({ ...alvo(), valor_total: '120.00', modificado_em: '2026-12-02 09:00:00' });
    await m.db.collection('vendas_gc').doc(ALVO).set(novo);
    m.gc.vendas.set(ALVO, { ...alvo(), valor_total: '120.00' }); m.gc.foraDaLista.clear();
    expect((await m.rodar()).revertidas).toBe(1);
    expect(await m.doc('vendas_gc', ALVO)).toEqual(novo);
    expect((await m.cand(ALVO)).invalidacaoAtiva).toBe(false);
  });
  test('voltar para SOMBRA (desligar) não aplica nada novo; reversão por reaparecimento continua funcionando', async () => {
    const { m, original } = await aplicado(); await m.modo('SOMBRA'); m.gc.vendas.set(ALVO, alvo()); m.gc.foraDaLista.clear();
    expect((await m.rodar()).revertidas).toBe(1); expect(await m.doc('vendas_gc', ALVO)).toEqual(original);
  });
  test('falha ao recalcular o perfil: pendência fica registrada e é refeita depois', async () => {
    const m = await mundo({ extras: [alvo(), antiga()] }); await comPerfil(m); await m.modo('APLICAR'); cancelarNaOrigem(m);
    m.gc.falha = u => (u.pathname === '/produtos' ? 500 : null);
    expect((await m.vezes(3)).recalculo).toMatchObject({ falhas: 1 });
    expect(await m.cand(ALVO)).toMatchObject({ recalculoPendente: true });
    expect((await m.doc('perfis_360', 'cli-300')).pedidosTotal).toBe(2);
    m.gc.falha = null; await m.rodar();
    expect((await m.doc('perfis_360', 'cli-300')).pedidosTotal).toBe(1);
    expect((await m.cand(ALVO)).recalculoPendente).toBe(false);
  });
});

describe('carteira / reativação B3', () => {
  test('mesmas chaves de evento do processador B3', () => expect(P.TIPOS_EVENTO_B3).toEqual(PV.TIPOS_EVENTO_B3));
  test.each([
    ['transferência por reativação', 'carteira_comercial_historico', { schemaVersion: 'historico-v2', chaveIdempotencia: `B3:TRANSFERIR_REATIVACAO:${ALVO}`, portfolioId: 'GC:300' }],
    ['renovação', 'carteira_comercial_historico', { schemaVersion: 'historico-v2', chaveIdempotencia: `B3:RENOVAR_OWNER:${ALVO}`, portfolioId: 'GC:300' }],
    ['evento que referencia a venda', 'carteira_comercial_historico', { referencias: { vendaGcId: ALVO }, portfolioId: 'GC:300' }],
    ['crédito de reserva', 'carteira_reativacao_decisoes', { vendaId: ALVO, reservaChave: 'k' }],
  ])('%s: o CRM é retido (nenhuma reversão disparada) até liberação explícita', async (_n, colecao, doc) => {
    const m = await mundo({ extras: [alvo(), antiga()] }); await comPerfil(m); await m.db.collection(colecao).doc('ev1').set(doc); await m.modo('APLICAR'); cancelarNaOrigem(m);
    const antes = await retrato(m);
    expect(await m.vezes(3)).toMatchObject({ aplicadas: 1, retidasCarteira: 1 });
    expect(await retrato(m)).toEqual(antes);
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'APLICADA', invalidacaoAtiva: true, crm: 'RETIDA_CARTEIRA' });
    // a regra B3 existente continua vendo a venda como válida: nada a reverter
    const inv = await PV.varrerInvalidacoes(m.db, {}, { hoje: F.HOJE, agoraIso: F.HOJE + 'T12:00:00Z', executar: false });
    expect(inv).toMatchObject({ candidatas: 0, renovacoesInvalidadas: 0 });
    await m.vezes(6); expect(await m.doc('vendas_gc', ALVO)).toMatchObject({ nome_situacao: 'Concretizada' });
    await m.modo('APLICAR', { liberadasCarteira: [ALVO] });
    await m.vezes(5);
    expect(await m.doc('vendas_gc', ALVO)).toMatchObject({ nome_situacao: 'Cancelada' });
    expect(await m.cand(ALVO)).toMatchObject({ crm: 'APLICADA' });
    expect((await m.col('carteira_comercial'))['GC:300']).toEqual({ ownerUid: 'u1', versao: 1 });       // a reconciliação nunca escreve carteira
  });
});

describe('concorrência', () => {
  async function confirmada(modo = 'SOMBRA') { const m = await mundo({ extras: [alvo(), antiga()] }); await m.modo(modo === 'APLICAR' ? 'SOMBRA' : modo); cancelarNaOrigem(m); await m.vezes(3); return m; }
  test('duas execuções simultâneas: só uma roda', async () => {
    const m = await mundo({ extras: [alvo()] }); await m.modo('SOMBRA'); cancelarNaOrigem(m);
    const rodar = runId => X.executar({ db: m.db, criarLeitor: F.leitorDe(m.gc), agoraMs: m.agora, runId });
    const r = await Promise.all([rodar('a'), rodar('b')]);
    // a segunda é barrada pela trava ou, se só a obteve depois, pelo intervalo relido dentro dela
    expect(r.filter(x => x.status === 'OK')).toHaveLength(1);
    expect(['OUTRA_EXECUCAO', 'AGUARDANDO_INTERVALO']).toContain(r.find(x => x.status !== 'OK').status);
    expect(m.gc.chamadas.filter(c => /\/vendas\/415281034/.test(c.url))).toHaveLength(1);
    expect((await m.cand(ALVO)).sequencia.n).toBe(1);
  });
  test('mesma observação gravada em paralelo conta uma vez', async () => {
    const m = await mundo({ extras: [alvo()] });
    const o = { vendaId: ALVO, classe: 'CANCELADA', fonte: 'T', evidencia: {} };
    await Promise.all(['a', 'b', 'c'].map(runId => P.registrarObservacao(m.db, o, { agoraMs: F.T0, runId, modo: 'SOMBRA' })));
    expect(await m.cand(ALVO)).toMatchObject({ versao: 1, sequencia: { n: 1 } });
  });
  test('aplicação em paralelo: uma só', async () => {
    const m = await confirmada(); await m.modo('APLICAR');
    const r = await Promise.all([1, 2, 3].map(i => P.aplicar(m.db, ALVO, { agoraMs: m.agora, runId: 'p' + i })));
    expect(r.filter(x => x.status === 'APLICADA')).toHaveLength(1);
    expect(Object.values(await m.col('vendas_origem_trilha')).filter(x => x.tipo === 'APLICACAO')).toHaveLength(1);
    expect((await m.doc('vendas_gc', ALVO)).invalidacao_origem.situacaoAnterior).toBe('Concretizada');
  });
  test('modo desligado entre a confirmação e a aplicação: não aplica', async () => {
    const m = await confirmada(); await m.modo('SOMBRA');
    expect(await P.aplicar(m.db, ALVO, { agoraMs: m.agora, runId: 'x' })).toEqual({ status: 'MODO_NAO_APLICA' });
  });
  test('o sync alterou a venda depois da observação: não aplica e recomeça', async () => {
    const m = await confirmada(); await m.modo('APLICAR');
    await m.db.collection('vendas_gc').doc(ALVO).update({ modificado_em: '2026-12-05 08:00:00' });
    expect(await P.aplicar(m.db, ALVO, { agoraMs: m.agora, runId: 'x' })).toEqual({ status: 'ESPELHO_MUDOU' });
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'OBSERVANDO', sequencia: null, invalidacaoAtiva: false });
    expect((await m.doc('vendas_gc', ALVO)).nome_situacao).toBe('Concretizada');
  });
  test('reversão manual bloqueia reaplicação', async () => {
    const m = await confirmada(); await m.modo('APLICAR'); await m.rodar();
    expect((await P.reverter(m.db, ALVO, { agoraMs: m.agora, runId: 'man', motivo: 'MANUAL', manual: true })).restaurado).toBe(true);
    await m.vezes(10);
    expect(await m.cand(ALVO)).toMatchObject({ estado: 'REVERTIDA_MANUAL', bloqueada: true, invalidacaoAtiva: false });
    expect((await m.doc('vendas_gc', ALVO)).nome_situacao).toBe('Concretizada');
  });
  test('confirmada em sombra é aplicada na primeira execução após ativar', async () => {
    const m = await confirmada(); await m.modo('APLICAR');
    expect(await m.rodar()).toMatchObject({ aplicadas: 1 });
  });
});
