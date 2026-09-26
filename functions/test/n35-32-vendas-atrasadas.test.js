'use strict';
// N35.32 — SOMBRA segura para vendas atrasadas: marca d'água por modificado_em, ordem comercial, revisões. EMULADOR.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT          = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const R = require('../lib/carteiraRegra');
const V1 = require('../lib/carteiraV1');

const CORTE = '2026-01-02';
const FAB = 't32-fab', ADE = 't32-ade', MUR = 't32-mur';
const GC = { [FAB]: '9400001', [ADE]: '9400002', [MUR]: '9400003' };
const criados = { vendas: new Set(), users: new Set() };
let seq = 0;

async function vendedor(uid, { pode = true, pausa = false } = {}) {
  criados.users.add(uid);
  await db.doc('users/' + uid).set({ role: 'funcionario', ativo: true });
  await db.doc('sistema_usuarios/' + uid).set({ bloqueado: false, carteiraComercial: { podePossuirCarteira: pode, ativoComercialmente: true, pausaTemporaria: pausa, desligado: false, gestaoClickVendedorId: GC[uid] } });
}
async function venda(cli, data, uid, { mod, situacao = 'Concretizada', valor = '120.00', id } = {}) {
  const vid = id || String(740000000 + (++seq));
  criados.vendas.add(vid);
  await db.doc('vendas_gc/' + vid).set({ id: vid, cliente_id: String(cli), data, nome_situacao: situacao, valor_total: valor, vendedor_id: GC[uid] || '',
    cadastrado_em: (mod || data + ' 12:00:00'), modificado_em: mod || (data + ' 12:00:00'), nome_cliente: 'Cliente Teste', produtos: [] });
  return vid;
}
const alterar = (id, campos) => db.doc('vendas_gc/' + id).update(campos);
async function carteira(cli, owner) {
  await db.doc('carteira_comercial/GC:' + cli).set(V1.montarDocCarteiraV1({ portfolioId: 'GC:' + cli, ownerUid: owner, ownerDesde: '2026-01-01T00:00:00.000Z',
    origemComercialUid: owner, origemComercialGestaoClickId: GC[owner], criadoEm: '2026-01-01T00:00:00.000Z', atualizadoEm: '2026-01-01T00:00:00.000Z', versao: 1 }));
}
const rodar = (dia, extra = {}) => R.processarVendasRecentes(db, { agoraIso: dia + 'T15:00:00.000Z', forcarSombra: true, runId: 'r' + (++seq), ...extra });
const todas = async () => (await db.collection('carteira_comercial_decisoes_sombra').get()).docs.map(d => d.data());
/** decisão vigente (maior revisão) por venda */
async function vigentes() { const m = new Map(); for (const d of await todas()) { const u = m.get(d.vendaId); if (!u || d.revisao > u.revisao) m.set(d.vendaId, d); } return m; }
async function limpar() {
  for (const c of ['carteira_comercial', 'carteira_comercial_historico', 'carteira_comercial_decisoes', 'carteira_comercial_decisoes_sombra', 'carteira_comercial_config'])
    for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  await db.doc('sync_state/perfil360').delete();
  for (const id of criados.vendas) await db.doc('vendas_gc/' + id).delete();
  for (const u of criados.users) { await db.doc('users/' + u).delete(); await db.doc('sistema_usuarios/' + u).delete(); }
  criados.vendas.clear(); criados.users.clear();
}
beforeEach(async () => {
  await limpar(); await vendedor(FAB); await vendedor(ADE); await vendedor(MUR, { pode: false });
  await db.doc('carteira_comercial_config/regra').set({ modo: 'SOMBRA', ativoDesde: CORTE });
  jest.spyOn(console, 'log').mockImplementation(() => {}); jest.spyOn(console, 'error').mockImplementation(() => {});
});
afterEach(() => jest.restoreAllMocks());
afterAll(limpar);

describe('Vendas atrasadas reais (atrasos observados em produção; IDs sintéticos)', () => {
  // atraso = modificado_em − data comercial, como nas 21 vendas reais de 180 dias (9, 16, 37 e 88 dias)
  test.each([['LA-01', 9, '2026-06-09'], ['LA-02', 16, '2026-09-02'], ['LA-03', 37, '2026-07-21'], ['LA-04', 88, '2026-04-23']])(
    '%s atraso de %i dias é capturado depois que o checkpoint já passou da data', async (_id, atraso, data) => {
      const cli = '8820' + atraso;
      await venda('8829999', data, FAB);                                                   // outra venda avança a marca d'água
      const avancado = R.tsMais(data + ' 12:00:00', 24 * (atraso - 1)).slice(0, 10);
      await venda('8829998', avancado, ADE);
      await rodar(avancado);
      const cp1 = (await db.doc('carteira_comercial_config/checkpoint_sombra_v2').get()).data().marcaDagua;
      expect(cp1 > data + ' 23:59:59').toBe(true);                                             // a marca já passou da data comercial
      const mod = R.tsMais(data + ' 12:00:00', 24 * atraso);
      const v = await venda(cli, data, ADE, { mod });                                           // só agora aparece no espelho
      await rodar(mod.slice(0, 10));
      const d = (await vigentes()).get(v);
      expect(d).toMatchObject({ dataVenda: data, decisaoSombra: 'CRIARIA_CARTEIRA', vendaTardia: true });
      expect(d.diasAteDeteccao).toBeGreaterThanOrEqual(atraso);
    });
});

describe('Ordem comercial (a data da venda manda, não a chegada)', () => {
  test('OO-01 chegada A → C → B termina igual ao processamento A → B → C', async () => {
    // cliente X: B chega por último · cliente Y (controle): tudo presente desde o início
    for (const cli of ['8821001', '8821002']) await carteira(cli, FAB);
    const vx = { A: await venda('8821001', '2026-01-10', FAB), C: await venda('8821001', '2026-09-01', ADE) };
    const vy = { A: await venda('8821002', '2026-01-10', FAB), B: await venda('8821002', '2026-06-01', ADE), C: await venda('8821002', '2026-09-01', ADE) };
    await rodar('2026-09-02');
    expect((await vigentes()).get(vx.C)).toMatchObject({ decisaoSombra: 'TRANSFERIRIA_R2', diasSemComprar: 234 });
    vx.B = await venda('8821001', '2026-06-01', ADE, { mod: '2026-09-10 09:00:00' });           // B aparece atrasada
    await rodar('2026-09-10');
    const g = await vigentes();
    const resumo = ids => ['A', 'B', 'C'].filter(k => ids[k]).map(k => g.get(ids[k]) && [g.get(ids[k]).decisaoSombra, g.get(ids[k]).motivo, g.get(ids[k]).diasSemComprar, g.get(ids[k]).ownerAntesUid]);
    expect(resumo(vx)).toEqual(resumo(vy));
    expect(g.get(vx.C)).toMatchObject({ revisao: 2, causa: 'SEQUENCIA_ALTERADA', decisaoSombra: 'SEM_ACAO' });
  });
  test('R2-L1 carteira Fabiana; B (Ademir, maio) chega depois de C (Ademir, setembro): só B é a reativação; não transfere duas vezes', async () => {
    await carteira('8821003', FAB);
    await venda('8821003', '2026-01-01', FAB);
    const C = await venda('8821003', '2026-09-20', ADE);
    await rodar('2026-09-21');
    expect((await vigentes()).get(C).decisaoSombra).toBe('TRANSFERIRIA_R2');
    const B = await venda('8821003', '2026-05-15', ADE, { mod: '2026-09-25 10:00:00' });
    await rodar('2026-09-25');
    const g = await vigentes();
    expect(g.get(B)).toMatchObject({ decisaoSombra: 'TRANSFERIRIA_R2', diasSemComprar: 134, ownerAntesUid: FAB, ownerDepoisUid: ADE });
    expect(g.get(C)).toMatchObject({ decisaoSombra: 'SEM_ACAO', ownerAntesUid: ADE, revisao: 2, causa: 'SEQUENCIA_ALTERADA' });
    expect([...g.values()].filter(d => d.portfolioId === 'GC:8821003' && d.decisaoSombra === 'TRANSFERIRIA_R2')).toHaveLength(1);
    expect((await db.doc('carteira_comercial/GC:8821003').get()).data()).toMatchObject({ ownerUid: FAB, versao: 1 });   // oficial intacta
    expect((await db.collection('carteira_comercial_historico').get()).size).toBe(0);
  });
  test('PV-01 "primeira venda" reconciliada quando aparece compra antiga (≥120 → reativação; <120 → não cria)', async () => {
    const B1 = await venda('8821004', '2026-09-10', ADE); const B2 = await venda('8821005', '2026-09-10', ADE);
    await rodar('2026-09-11');
    expect((await vigentes()).get(B1).decisaoSombra).toBe('CRIARIA_CARTEIRA');
    await venda('8821004', '2025-12-01', FAB, { mod: '2026-09-15 10:00:00' });                // compra antiga (antes do corte)
    await venda('8821005', '2026-06-20', FAB, { mod: '2026-09-15 10:00:00' });                // compra recente (depois do corte)
    await rodar('2026-09-15');
    const g = await vigentes();
    expect(g.get(B1)).toMatchObject({ decisaoSombra: 'CRIARIA_CARTEIRA_REATIVACAO', revisao: 2, causa: 'SEQUENCIA_ALTERADA' });
    // a antiga (jun, Fabiana) é que faria nascer a carteira; setembro (Ademir, 82 dias depois) fica protegida
    expect(g.get(B2)).toMatchObject({ decisaoSombra: 'NAO_TRANSFERIR', motivo: 'CARTEIRA_PROTEGIDA_MENOS_120D', ownerAntesUid: FAB, diasSemComprar: 82, revisao: 2 });
    const antiga = [...g.values()].find(d => d.portfolioId === 'GC:8821005' && d.dataVenda === '2026-06-20');
    expect(antiga).toMatchObject({ decisaoSombra: 'CRIARIA_CARTEIRA', ownerDepoisUid: FAB });
  });
});

describe('Alterações tardias', () => {
  test('ST-01 orçamento em D0 que vira Concretizada em D+15: capturada com a data comercial D0', async () => {
    const v = await venda('8822001', '2026-08-01', ADE, { situacao: 'Em aberto' });
    await rodar('2026-08-02');
    expect(await todas()).toHaveLength(0);
    await alterar(v, { nome_situacao: 'Concretizada', modificado_em: '2026-08-16 10:00:00' });
    await rodar('2026-08-16');
    expect((await vigentes()).get(v)).toMatchObject({ dataVenda: '2026-08-01', decisaoSombra: 'CRIARIA_CARTEIRA', vendaTardia: true, diasAteDeteccao: 15 });
  });
  test('CN-01 cancelamento tardio: revisão INVALIDADA; a decisão anterior continua auditável', async () => {
    const v = await venda('8822002', '2026-08-01', ADE);
    await rodar('2026-08-02');
    await alterar(v, { nome_situacao: 'Cancelada', modificado_em: '2026-08-20 10:00:00' });
    await rodar('2026-08-20');
    const revs = (await todas()).filter(d => d.vendaId === v).sort((a, b) => a.revisao - b.revisao);
    expect(revs.map(d => d.decisaoSombra)).toEqual(['CRIARIA_CARTEIRA', 'INVALIDADA']);
    expect(revs[1]).toMatchObject({ substitui: revs[0].decisionId, causa: 'VENDA_ALTERADA' });
  });
  test('ED-01 edição sem efeito comercial (valor 120→300, produtos) não gera revisão', async () => {
    const v = await venda('8822003', '2026-08-01', ADE);
    await rodar('2026-08-02');
    await alterar(v, { valor_total: '300.00', produtos: [{ produto_id: '1' }], modificado_em: '2026-08-05 10:00:00' });
    const r = await rodar('2026-08-05');
    expect(r).toMatchObject({ processadas: 0, reavaliacoes: 0, inalteradas: 1 });
    expect((await todas()).filter(d => d.vendaId === v)).toHaveLength(1);
  });
  test('ED-02 mudança de vendedor reavalia (VENDA_ALTERADA)', async () => {
    const v = await venda('8822004', '2026-08-01', ADE);
    await rodar('2026-08-02');
    await alterar(v, { vendedor_id: GC[MUR], modificado_em: '2026-08-06 10:00:00' });
    await rodar('2026-08-06');
    expect((await vigentes()).get(v)).toMatchObject({ revisao: 2, causa: 'VENDA_ALTERADA', decisaoSombra: 'REVISAO_GESTAO' });
  });
  test('MV-01 venda que muda de cliente: cliente antigo INVALIDADA (movida); novo cliente recebe a revisão seguinte', async () => {
    const v = await venda('8822005', '2026-08-01', ADE);
    await rodar('2026-08-02');
    await alterar(v, { cliente_id: '8822006', modificado_em: '2026-08-07 10:00:00' });
    await rodar('2026-08-07');
    const revs = (await todas()).filter(d => d.vendaId === v).sort((a, b) => a.revisao - b.revisao);
    expect(revs.map(d => [d.revisao, d.portfolioId, d.decisaoSombra])).toEqual(expect.arrayContaining([[1, 'GC:8822005', 'CRIARIA_CARTEIRA']]));
    expect(revs.some(d => d.portfolioId === 'GC:8822005' && d.motivo === 'VENDA_MOVIDA_OU_REMOVIDA')).toBe(true);
    expect(revs.some(d => d.portfolioId === 'GC:8822006' && d.decisaoSombra === 'CRIARIA_CARTEIRA')).toBe(true);
    expect(new Set(revs.map(d => d.decisionId)).size).toBe(revs.length);
  });
});

describe('Checkpoint V2', () => {
  test('TS-01 mesmo modificado_em: A, B, C com timestamp X — B e C chegam depois da marca e não se perdem', async () => {
    const X = '2026-08-10 10:00:00';
    const A = await venda('8823001', '2026-08-10', ADE, { mod: X });
    await rodar('2026-08-10');
    expect((await db.doc('carteira_comercial_config/checkpoint_sombra_v2').get()).data().marcaDagua).toBe(X);
    const B = await venda('8823002', '2026-08-10', FAB, { mod: X }); const C = await venda('8823003', '2026-08-10', ADE, { mod: X });
    await rodar('2026-08-11');
    const g = await vigentes();
    for (const v of [A, B, C]) expect(g.get(v)).toBeDefined();
    await rodar('2026-08-12');
    expect(await todas()).toHaveLength(3);
  });
  test('SC-01 marca d\'água nunca passa do cursor confirmado pelo sync', async () => {
    await db.doc('sync_state/perfil360').set({ modifiedSinceCursor: '2026-08-10 09:00:00', status: 'READY' });
    await venda('8823004', '2026-08-10', ADE, { mod: '2026-08-10 11:00:00' });                // escrita em andamento (acima do cursor)
    const r = await rodar('2026-08-11');
    expect(r).toMatchObject({ processadas: 1, checkpointDepois: '2026-08-10 09:00:00', cursorSync: '2026-08-10 09:00:00' });
  });
  test('FD-01 venda pré-datada (data futura) é avaliada quando a data chega, sem nova modificação', async () => {
    const v = await venda('8823005', '2026-08-20', ADE, { mod: '2026-08-05 10:00:00' });
    const r1 = await rodar('2026-08-05');
    expect(r1.ignoradasPorMotivo).toMatchObject({ DATA_FUTURA: 1 });
    await rodar('2026-08-12');                                                                  // marca avança; venda ainda futura
    await rodar('2026-08-21');
    expect((await vigentes()).get(v)).toMatchObject({ dataVenda: '2026-08-20', decisaoSombra: 'CRIARIA_CARTEIRA' });
  });
  test('HR-01 primeira execução: histórico não é reprocessado e o checkpoint V1 é preservado', async () => {
    const v1 = { corte: CORTE, maiorDataAvaliada: null, runId: 'antigo', modo: 'SOMBRA', regraVersao: 'N35.30' };
    await db.doc('carteira_comercial_config/checkpoint_sombra').set(v1);
    for (let i = 0; i < 40; i++) await venda('88240' + (i % 5), '2025-' + String(1 + (i % 12)).padStart(2, '0') + '-10', ADE);   // antes do corte
    const nova = await venda('8824009', '2026-08-10', FAB);
    const r = await rodar('2026-08-11');
    expect(r).toMatchObject({ processadas: 1, clientesReavaliados: 1 });
    expect((await todas()).map(d => d.vendaId)).toEqual([nova]);
    expect((await db.doc('carteira_comercial_config/checkpoint_sombra').get()).data()).toEqual(v1);
  });
});

describe('Idempotência, concorrência, pausa e dados', () => {
  test('ID-01 mesma venda, 10 execuções: 1 estado efetivo, 0 escrita oficial', async () => {
    await carteira('8825001', FAB); await venda('8825001', '2026-01-05', FAB);
    const v = await venda('8825001', '2026-08-01', ADE);
    for (let i = 0; i < 10; i++) await rodar('2026-08-02');
    expect((await todas()).filter(d => d.vendaId === v)).toHaveLength(1);
    expect((await db.collection('carteira_comercial_decisoes').get()).size).toBe(0);
    expect((await db.doc('carteira_comercial/GC:8825001').get()).data().versao).toBe(1);
  });
  test('ID-02 6 reavaliações concorrentes do mesmo cliente: 1 decisão por venda', async () => {
    await venda('8825002', '2026-08-01', ADE); await venda('8825002', '2026-08-03', ADE);
    const regra = R.lerRegra({ modo: 'SOMBRA', ativoDesde: CORTE });
    await Promise.all(Array.from({ length: 6 }, () => R.reavaliarClienteSombra(db, { gcCliente: '8825002', agoraIso: '2026-08-04T12:00:00.000Z', regra, runId: 'c' })));
    const ds = await todas();
    expect(ds).toHaveLength(2);
    expect(new Set(ds.map(d => d.decisionId)).size).toBe(2);
  });
  test('PA-H1 pausa em venda atrasada: usa o estado ATUAL (histórico de pausa não existe) e marca vendaTardia', async () => {
    await vendedor(FAB, { pausa: true });
    await carteira('8825003', FAB); await venda('8825003', '2026-01-05', FAB);
    const v = await venda('8825003', '2026-06-01', ADE, { mod: '2026-08-20 10:00:00' });
    await rodar('2026-08-20');
    expect((await vigentes()).get(v)).toMatchObject({ motivo: 'COBERTURA_PAUSA_TEMPORARIA', vendaTardia: true });
  });
  test('SEG-01 whitelist estrita nas revisões (sem nome, valor ou texto livre)', async () => {
    await carteira('8825004', FAB); await venda('8825004', '2026-01-05', FAB);
    const v = await venda('8825004', '2026-08-01', ADE);
    await rodar('2026-08-02');
    await alterar(v, { nome_situacao: 'Cancelada', modificado_em: '2026-08-09 10:00:00' });
    await rodar('2026-08-09');
    for (const d of await todas()) {
      expect(R.validarDecisao(d)).toBeNull();
      expect(JSON.stringify(d)).not.toMatch(/Cliente Teste|120\.00|300\.00/);
    }
  });
});
