'use strict';
// N35.29 — Regra definitiva da carteira (R2 + pausa + primeira venda + desligamento). EMULADOR. PROD_WRITES=0.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT          = 'mr4-ponto';

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const R = require('../lib/carteiraRegra');
const V1 = require('../lib/carteiraV1');

const AGORA = '2026-09-27T10:00:00.000Z';
const REGRA = { modo: 'ATIVO', ativoDesde: '2026-01-01' };
const FAB = 't29-fab', ADE = 't29-ade', MUR = 't29-mur', C = 'uid-vendedor-c', OFF = 't29-off', GES = 't29-gestor';
const GC = { [FAB]: '9100001', [ADE]: '9100002', [MUR]: '9100003', [C]: '9100007', [OFF]: '9100009' };
const criados = { vendas: new Set(), users: new Set(), clientes: new Set() };

const dMenos = (base, n) => new Date(Date.parse(base + 'T12:00:00Z') - n * 86400000).toISOString().slice(0, 10);
async function vendedor(uid, { habilitado = true, situacao = 'ATIVO', pausaMotivo, ativo = true, bloqueado = false, fila, role = 'funcionario', gc = GC[uid], mods } = {}) {
  criados.users.add(uid);
  await db.doc('users/' + uid).set({ role, ativo });
  await db.doc('sistema_usuarios/' + uid).set({ bloqueado, modulos: mods || ['fila-comercial', 'fila-comercial-operar'],
    ...(gc !== null ? { carteiraComercial: { podePossuirCarteira: habilitado, ativoComercialmente: true, pausaTemporaria: situacao === 'PAUSA_TEMPORARIA',
      desligado: situacao === 'DESLIGADO', gestaoClickVendedorId: gc, ...(pausaMotivo ? { pausaMotivo } : {}) } } : {}),
    ...(fila ? { filaComercial: fila } : {}) });
}
let seqV = 0;
async function venda(cliente, data, vendUid, { situacao = 'Concretizada', valor = '100.00', vendGc } = {}) {
  const id = String(700000000 + (++seqV));
  criados.vendas.add(id);
  await db.doc('vendas_gc/' + id).set({ id, cliente_id: String(cliente), data, nome_situacao: situacao, valor_total: valor,
    vendedor_id: vendGc !== undefined ? vendGc : (GC[vendUid] || ''), produtos: [] });
  return id;
}
async function carteira(cliente, owner, versao = 1) {
  await db.doc('carteira_comercial/GC:' + cliente).set(V1.montarDocCarteiraV1({ portfolioId: 'GC:' + cliente, ownerUid: owner, ownerDesde: '2026-09-26T00:00:00.000Z',
    origemComercialUid: owner, origemComercialGestaoClickId: GC[owner] || null, criadoEm: '2026-09-26T00:00:00.000Z', atualizadoEm: '2026-09-26T00:00:00.000Z', versao }));
}
const proc = (vendaId, extra = {}) => R.processarVendaCarteira(db, { vendaId, agoraIso: AGORA, regraDoc: REGRA, ...extra });
const cart = async cli => { const s = await db.doc('carteira_comercial/GC:' + cli).get(); return s.exists ? s.data() : null; };
const hist = async cli => (await db.collection('carteira_comercial_historico').where('portfolioId', '==', 'GC:' + cli).get()).docs.map(d => d.data());
const decs = async cli => (await db.collection('carteira_comercial_decisoes').where('portfolioId', '==', 'GC:' + cli).get()).docs.map(d => d.data());

async function limpar() {
  for (const c of ['carteira_comercial', 'carteira_comercial_historico', 'carteira_comercial_decisoes', 'carteira_comercial_decisoes_sombra'])
    for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  for (const id of criados.vendas) await db.doc('vendas_gc/' + id).delete();
  for (const u of criados.users) { await db.doc('users/' + u).delete(); await db.doc('sistema_usuarios/' + u).delete(); }
  for (const c of criados.clientes) await db.doc('clientes/' + c).delete();
  for (const k of Object.values(criados)) k.clear();
  await db.doc('interacoes_fila/t29-claim').delete();
  for (const d of ['regra', 'checkpoint_sombra', 'checkpoint_ativo']) await db.doc('carteira_comercial_config/' + d).delete();
}
beforeEach(async () => { await limpar(); await vendedor(FAB); await vendedor(ADE); await vendedor(MUR, { habilitado: false, role: 'gestor' }); });
afterAll(limpar);

describe('Venda válida e vendedor elegível (puro)', () => {
  test('VV-01 só Concretizada, com cliente, data válida não futura e valor > 0', () => {
    const ok = { id: '1', cliente_id: '5', data: '2026-09-01', nome_situacao: 'Concretizada', valor_total: '10' };
    expect(R.validarVenda(ok, '2026-09-27')).toBeNull();
    expect(R.validarVenda({ ...ok, nome_situacao: 'Em aberto' })).toBe('SITUACAO_NAO_CONCRETIZADA');
    expect(R.validarVenda({ ...ok, nome_situacao: 'Orçamento' })).toBe('SITUACAO_NAO_CONCRETIZADA');
    expect(R.validarVenda({ ...ok, nome_situacao: 'Cancelada' })).toBe('SITUACAO_NAO_CONCRETIZADA');
    expect(R.validarVenda({ ...ok, cliente_id: '' })).toBe('SEM_CLIENTE');
    expect(R.validarVenda({ ...ok, valor_total: '0.00' })).toBe('VALOR_ZERADO');
    expect(R.validarVenda({ ...ok, data: '2026-10-01' }, '2026-09-27')).toBe('DATA_FUTURA');
    expect(R.validarVenda({ ...ok, id: '' })).toBe('SEM_ID');
  });
  test('VV-02 elegibilidade vem só da configuração (sem UID fixo)', () => {
    const u = { ativo: true }, s = cc => ({ bloqueado: false, carteiraComercial: cc });
    const ok = { podePossuirCarteira: true, ativoComercialmente: true };
    expect(R.isPortfolioEligibleSeller(u, s(ok))).toBe(true);
    expect(R.isPortfolioEligibleSeller(u, s({ ...ok, pausaTemporaria: true }))).toBe(true);   // pausa não tira a carteira
    expect(R.situacaoVendedor(u, s({ ...ok, desligado: true })).situacao).toBe('DESLIGADO');
    expect(R.isPortfolioEligibleSeller(u, s({ ...ok, podePossuirCarteira: false }))).toBe(false);
    expect(R.isPortfolioEligibleSeller(u, s({ ...ok, ativoComercialmente: false }))).toBe(false);
    expect(R.isPortfolioEligibleSeller(u, s(undefined))).toBe(false);
    expect(R.isPortfolioEligibleSeller({ ativo: false }, s(ok))).toBe(false);
    expect(R.isPortfolioEligibleSeller(u, { bloqueado: true, carteiraComercial: ok })).toBe(false);
    expect(R.isPortfolioEligibleSeller(null, null)).toBe(false);
    expect(R.situacaoVendedor(u, { carteiraComercial: ok, filaComercial: { ativo: true, recebeNovasOportunidades: false } }).pausaProtegida).toBe(true);
    // podeOperarFila (módulo) NÃO implica podePossuirCarteira
    expect(R.isPortfolioEligibleSeller(u, { modulos: ['fila-comercial-operar'], filaComercial: { ativo: true, recebeNovasOportunidades: true } })).toBe(false);
  });
  test('VV-03 regra: ausente/inválida = DESLIGADO (kill switch)', () => {
    expect(R.lerRegra(null).modo).toBe('DESLIGADO');
    expect(R.lerRegra({ modo: 'ATIVO' }).modo).toBe('DESLIGADO');
    expect(R.lerRegra({ modo: 'XPTO', ativoDesde: '2026-01-01' }).modo).toBe('DESLIGADO');
    expect(R.lerRegra({ modo: 'ATIVO', ativoDesde: '2026-01-01' })).toMatchObject({ modo: 'ATIVO', politicaSemCarteiraComHistorico: 'SOMENTE_APOS_120D' });
  });
  test('VV-04 módulo sem UID/ID de vendedor fixo e isolado da Worklist', () => {
    const src = fs.readFileSync(path.join(__dirname, '../lib/carteiraRegra.js'), 'utf8')
      .replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '').replace(/\s\/\/ .*$/gm, '');   // só código
    expect(src).not.toMatch(/\b(?=[A-Za-z0-9]*\d)(?=[A-Za-z0-9]*[A-Z])[A-Za-z0-9]{28}\b/);   // UID Firebase (28 chars, com dígito)
    expect(src).not.toMatch(/1080453|948278|559684|791775|1392140|1249840/);  // vendedores GC reais
    const reqs = [...src.matchAll(/require\('([^']+)'\)/g)].map(m => m[1]).sort();
    expect(reqs).toEqual(['./carteiraMigracao', './carteiraV1', './commercialIdentity', 'crypto']);
    expect(src).not.toMatch(/fila_comercial|interacoes_fila|perfis_360/);
  });
});

describe('Primeira venda (PF)', () => {
  test('PF-01 primeira venda válida de vendedor elegível cria carteira + histórico + decisão', async () => {
    const v = await venda('8800001', '2026-09-20', FAB);
    const r = await proc(v);
    expect(r).toMatchObject({ status: 'PROCESSADA', decisao: 'CRIAR_PRIMEIRA_VENDA', ownerAntesUid: null, ownerDepoisUid: FAB });
    const c = await cart('8800001');
    expect(c).toMatchObject({ ownerUid: FAB, versao: 1, origemComercialUid: FAB, origemComercialGestaoClickId: GC[FAB] });
    expect(V1.validarDocCarteiraV1(c)).toBeNull();
    const h = await hist('8800001');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ tipoEvento: 'CARTEIRA_CRIADA_PRIMEIRA_VENDA', ownerAnteriorUid: null, ownerNovoUid: FAB, operadorUid: R.OPERADOR_SISTEMA, chaveIdempotencia: 'PRIMEIRA_VENDA:' + v });
    expect(await decs('8800001')).toHaveLength(1);
  });
  test('PF-02 primeira venda não duplica (retry, varredura e concorrência)', async () => {
    const v = await venda('8800002', '2026-09-20', FAB);
    await Promise.all([proc(v), proc(v), proc(v), proc(v)]);
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect((await cart('8800002')).versao).toBe(1);
    expect(await hist('8800002')).toHaveLength(1);
    expect(await decs('8800002')).toHaveLength(1);
  });
  test('PF-03 vendedor inativo / desligado / não habilitado não recebe: pendência de gestão, sem substituto', async () => {
    await vendedor('t29-ina', { ativo: false, gc: '9100011' });
    await vendedor('t29-des', { situacao: 'DESLIGADO', gc: '9100012' });
    const casos = [['8800031', '9100011', 'VENDEDOR_INATIVO'], ['8800032', '9100012', 'VENDEDOR_DESLIGADO'], ['8800033', GC[MUR], 'VENDEDOR_NAO_HABILITADO']];
    for (const [cli, gc, mot] of casos) {
      const r = await proc(await venda(cli, '2026-09-20', null, { vendGc: gc }));
      expect(r).toMatchObject({ decisao: 'PENDENCIA_GESTAO', motivo: mot, gestaoReview: true, ownerDepoisUid: null });
      expect(await cart(cli)).toBeNull();
      expect(await hist(cli)).toHaveLength(0);
    }
  });
  test('PF-04 vendedor desconhecido / vazio / ambíguo não recebe', async () => {
    await vendedor('t29-dup1', { gc: '9100020' }); await vendedor('t29-dup2', { gc: '9100020' });
    const casos = [['8800041', '9199999', 'VENDEDOR_NAO_RESOLVIDO'], ['8800042', '', 'VENDEDOR_SEM_VENDEDOR'], ['8800043', '9100020', 'VENDEDOR_AMBIGUO']];
    for (const [cli, gc, mot] of casos) {
      const r = await proc(await venda(cli, '2026-09-20', null, { vendGc: gc }));
      expect(r).toMatchObject({ decisao: 'PENDENCIA_GESTAO', motivo: mot });
      expect(await cart(cli)).toBeNull();
    }
  });
  test('PF-05 nunca comprou = sem carteira (cadastro/orçamento não criam)', async () => {
    await venda('8800051', '2026-09-20', FAB, { situacao: 'Em aberto' });
    await venda('8800051', '2026-09-21', FAB, { situacao: 'Orçamento' });
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect(await cart('8800051')).toBeNull();
    expect(await decs('8800051')).toHaveLength(0);
  });
});

describe('R2 — reativação >= 120 dias', () => {
  async function cenario(cli, dias, { vendedorNovo = ADE, dono = FAB, situacao } = {}) {
    await carteira(cli, dono);
    await venda(cli, dMenos('2026-09-20', dias), dono);
    return venda(cli, '2026-09-20', vendedorNovo, situacao ? { situacao } : {});
  }
  test('R2-01 119 dias não transfere', async () => {
    const r = await proc(await cenario('8800101', 119));
    expect(r).toMatchObject({ decisao: 'MANTER', motivo: 'CARTEIRA_PROTEGIDA_MENOS_120D', diasSemComprar: 119 });
    expect((await cart('8800101')).ownerUid).toBe(FAB);
  });
  test('R2-02 exatamente 120 transfere', async () => {
    const v = await cenario('8800102', 120);
    const r = await proc(v);
    expect(r).toMatchObject({ decisao: 'TRANSFERIR_R2', ownerAntesUid: FAB, ownerDepoisUid: ADE, diasSemComprar: 120 });
    const c = await cart('8800102');
    expect(c).toMatchObject({ ownerUid: ADE, versao: 2, origemComercialUid: FAB, origemComercialGestaoClickId: GC[FAB] });   // origem preservada
    const h = await hist('8800102');
    expect(h).toHaveLength(1);
    expect(h[0]).toMatchObject({ tipoEvento: 'REATIVACAO_120D_PRIMEIRA_VENDA', ownerAnteriorUid: FAB, ownerNovoUid: ADE, chaveIdempotencia: 'R2:' + v, versao: 2 });
  });
  test('R2-03 121 e 400 dias transferem', async () => {
    for (const [cli, d] of [['8800103', 121], ['8800104', 400]]) {
      expect((await proc(await cenario(cli, d))).decisao).toBe('TRANSFERIR_R2');
      expect((await cart(cli)).ownerUid).toBe(ADE);
    }
  });
  test('R2-04/WL-02 claim do outro vendedor (sem venda) não transfere', async () => {
    await carteira('8800105', FAB); await venda('8800105', '2026-04-01', FAB);
    await db.doc('interacoes_fila/t29-claim').set({ eventos: [{ tipo: 'CLAIMED', operadorId: ADE, timestamp: AGORA }] });
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    const res = await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect(res.porDecisao).toEqual({ MANTER: 1 });                       // só a venda da própria dona
    expect((await cart('8800105')).ownerUid).toBe(FAB);
  });
  test('R2-05 follow-up / ligação / WhatsApp / tentativa não transferem (não são vendas)', async () => {
    await carteira('8800106', FAB); await venda('8800106', '2026-03-01', FAB);
    for (const s of ['Follow-up', 'Ligação', 'WhatsApp', 'Tentativa']) await venda('8800106', '2026-09-20', ADE, { situacao: s });
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect((await cart('8800106')).ownerUid).toBe(FAB);
    expect(await hist('8800106')).toHaveLength(0);
  });
  test('R2-06 orçamento / em aberto / valor zerado não transferem', async () => {
    for (const [cli, extra] of [['8800107', { situacao: 'Orçamento' }], ['8800108', { situacao: 'Em aberto' }], ['8800109', { valor: '0.00' }]]) {
      await carteira(cli, FAB); await venda(cli, '2026-03-01', FAB);
      const r = await proc(await venda(cli, '2026-09-20', ADE, extra));
      expect(r.status).toBe('IGNORADA');
      expect((await cart(cli)).ownerUid).toBe(FAB);
    }
  });
  test('R2-07 venda válida do reativador transfere; próximas vendas não transferem de novo', async () => {
    const v = await cenario('8800110', 150);
    expect((await proc(v)).decisao).toBe('TRANSFERIR_R2');
    expect((await proc(await venda('8800110', '2026-09-25', ADE))).motivo).toBe('VENDA_DO_DONO');
    expect((await proc(await venda('8800110', '2026-09-26', FAB))).motivo).toBe('CARTEIRA_PROTEGIDA_MENOS_120D');   // não volta
    expect((await cart('8800110'))).toMatchObject({ ownerUid: ADE, versao: 2 });
  });
  test('R2-08 retry não duplica (mesma venda 3x + varredura 2x)', async () => {
    const v = await cenario('8800111', 200);
    for (let i = 0; i < 3; i++) await proc(v);
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    await R.processarVendasRecentes(db, { agoraIso: AGORA }); await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect(await cart('8800111')).toMatchObject({ ownerUid: ADE, versao: 2 });
    expect((await hist('8800111')).filter(h => h.tipoEvento === 'REATIVACAO_120D_PRIMEIRA_VENDA')).toHaveLength(1);
    expect((await decs('8800111')).filter(d => d.vendaId === v)).toHaveLength(1);
  });
  test('R2-09 concorrência: 6 execuções simultâneas da mesma venda = 1 transferência', async () => {
    const v = await cenario('8800112', 180);
    const rs = await Promise.all(Array.from({ length: 6 }, () => proc(v)));
    expect(rs.filter(r => r.status === 'PROCESSADA').length).toBe(1);
    expect(rs.filter(r => r.status === 'JA_PROCESSADA').length).toBe(5);
    expect(await cart('8800112')).toMatchObject({ ownerUid: ADE, versao: 2 });
    expect(await hist('8800112')).toHaveLength(1);
    expect((await decs('8800112')).filter(d => d.vendaId === v)).toHaveLength(1);
  });
  test('R2-10 primeira venda pós-gap é de vendedor não elegível: R2 consumida, bloqueada e sinalizada', async () => {
    const v = await cenario('8800113', 150, { vendedorNovo: MUR });
    expect(await proc(v)).toMatchObject({ decisao: 'MANTER', motivo: 'R2_BLOQUEADA_VENDEDOR_NAO_HABILITADO', gestaoReview: true });
    expect((await proc(await venda('8800113', '2026-09-25', ADE))).motivo).toBe('CARTEIRA_PROTEGIDA_MENOS_120D');
    expect((await cart('8800113')).ownerUid).toBe(FAB);
  });
  test('R2-11 venda anterior à ativação nunca é processada (sem retroatividade)', async () => {
    await carteira('8800114', FAB); await venda('8800114', '2025-01-01', FAB);
    const v = await venda('8800114', '2025-12-20', ADE);
    expect(await proc(v)).toMatchObject({ status: 'IGNORADA', motivo: 'ANTES_DO_CORTE' });
    expect((await cart('8800114')).ownerUid).toBe(FAB);
  });
  test('R2-12 venda fora de ordem (anterior a uma já decidida) vira pendência, não muda carteira', async () => {
    await carteira('8800115', FAB); await venda('8800115', '2026-01-10', FAB);
    await proc(await venda('8800115', '2026-09-20', FAB));
    const atrasada = await venda('8800115', '2026-09-10', ADE);
    expect(await proc(atrasada)).toMatchObject({ decisao: 'PENDENCIA_GESTAO', motivo: 'VENDA_FORA_DE_ORDEM' });
    expect((await cart('8800115')).ownerUid).toBe(FAB);
  });
  test('R2-13 venda invalidada depois de transferir: sinaliza gestão, não reverte sozinha', async () => {
    const v = await cenario('8800116', 150);
    await proc(v);
    await db.doc('vendas_gc/' + v).update({ nome_situacao: 'Cancelada' });
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    const res = await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect(res.invalidadasAposDecisao).toBe(1);
    expect((await cart('8800116')).ownerUid).toBe(ADE);
    expect((await db.doc('carteira_comercial_decisoes/' + R.idDecisao(v) + '_INVALIDADA').get()).data()).toMatchObject({ motivo: 'VENDA_INVALIDADA_APOS_DECISAO', gestaoReview: true });
  });
  test('R2-14 identidade ambígua (dois clientes MR4 com o mesmo GC) vira pendência', async () => {
    criados.clientes.add('t29m1'); criados.clientes.add('t29m2');
    await db.doc('clientes/t29m1').set({ gestaoClickId: '8800117' }); await db.doc('clientes/t29m2').set({ gestaoClickId: 8800117 });
    const r = await proc(await venda('8800117', '2026-09-20', FAB));
    expect(r).toMatchObject({ decisao: 'PENDENCIA_GESTAO', motivo: 'IDENTIDADE_IDENTIDADE_AMBIGUA' });
    expect(await cart('8800117')).toBeNull();
  });
});

describe('Pausa temporária (PA)', () => {
  test('PA-01 férias protegem a carteira (>=120 dias)', async () => {
    await vendedor(FAB, { situacao: 'PAUSA_TEMPORARIA', pausaMotivo: 'FERIAS' });
    await carteira('8800201', FAB); await venda('8800201', '2026-03-01', FAB);
    const r = await proc(await venda('8800201', '2026-09-20', ADE));
    expect(r).toMatchObject({ decisao: 'MANTER', motivo: 'COBERTURA_PAUSA_TEMPORARIA', ownerDepoisUid: FAB });
    expect((await cart('8800201')).ownerUid).toBe(FAB);
    expect(await hist('8800201')).toHaveLength(0);
  });
  test('PA-02 venda de cobertura durante pausa de distribuição não transfere', async () => {
    await vendedor(FAB, { fila: { ativo: true, recebeNovasOportunidades: false, limiteNovasPorDia: 10 } });
    await carteira('8800202', FAB); await venda('8800202', '2026-02-01', FAB);
    expect((await proc(await venda('8800202', '2026-09-20', ADE))).motivo).toBe('COBERTURA_PAUSA_TEMPORARIA');
    for (const pm of ['LICENCA', 'AFASTAMENTO']) {
      await vendedor(FAB, { situacao: 'PAUSA_TEMPORARIA', pausaMotivo: pm });
      const cli = pm === 'LICENCA' ? '8800203' : '8800204';
      await carteira(cli, FAB); await venda(cli, '2026-02-01', FAB);
      expect((await proc(await venda(cli, '2026-09-20', ADE))).motivo).toBe('COBERTURA_PAUSA_TEMPORARIA');
    }
  });
  test('PA-03 retorno da pausa preserva o dono (a venda de cobertura não é reprocessada)', async () => {
    await vendedor(FAB, { situacao: 'PAUSA_TEMPORARIA', pausaMotivo: 'FERIAS' });
    await carteira('8800205', FAB); await venda('8800205', '2026-03-01', FAB);
    const v = await venda('8800205', '2026-09-20', ADE);
    await proc(v);
    await vendedor(FAB, { situacao: 'ATIVO' });
    expect((await proc(v)).status).toBe('JA_PROCESSADA');
    expect((await proc(await venda('8800205', '2026-09-24', ADE))).motivo).toBe('CARTEIRA_PROTEGIDA_MENOS_120D');
    expect((await cart('8800205')).ownerUid).toBe(FAB);
  });
});

describe('Desligamento (OFF)', () => {
  test('OFF-01 vendedor desligado com 100 carteiras: nada é redistribuído', async () => {
    await vendedor(OFF, { situacao: 'DESLIGADO' });
    const clis = Array.from({ length: 100 }, (_, i) => String(8803000 + i));
    const b = db.batch();
    for (const c of clis) b.set(db.doc('carteira_comercial/GC:' + c), V1.montarDocCarteiraV1({ portfolioId: 'GC:' + c, ownerUid: OFF, ownerDesde: AGORA, origemComercialUid: OFF,
      origemComercialGestaoClickId: GC[OFF], criadoEm: AGORA, atualizadoEm: AGORA, versao: 1 }));
    await b.commit();
    await venda(clis[0], '2026-09-10', OFF); await venda(clis[0], '2026-09-20', ADE);     // outro vendedor < 120d
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    const res = await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect(res.porDecisao.TRANSFERIR_R2 || 0).toBe(0);
    const donos = (await db.collection('carteira_comercial').where('ownerUid', '==', OFF).get()).size;
    expect(donos).toBe(100);
    expect(R.avaliarDesligamento({ carteiras: clis.map(c => ({ ownerUid: OFF })), uid: OFF }))
      .toMatchObject({ AUTO_REDISTRIBUTION: 0, AUTO_TRANSFER: 0, MANAGEMENT_ACTION_REQUIRED: true, carteirasAfetadas: 100 });
  });
  test('OFF-02 desligamento exige gestão: o motor não tem caminho de redistribuição; venda do desligado vai para revisão', async () => {
    await vendedor(OFF, { situacao: 'DESLIGADO' });
    await carteira('8800301', OFF); await venda('8800301', '2026-09-01', OFF);
    const r = await proc(await venda('8800302', '2026-09-20', OFF));                       // 1ª venda feita pelo desligado
    expect(r).toMatchObject({ decisao: 'PENDENCIA_GESTAO', motivo: 'VENDEDOR_DESLIGADO', gestaoReview: true });
    expect((await proc(await venda('8800301', '2026-09-20', FAB))).motivo).toBe('CARTEIRA_PROTEGIDA_MENOS_120D');
    expect((await cart('8800301')).ownerUid).toBe(OFF);
    expect(Object.keys(R).filter(k => /redistrib|transferir(?!R2)|roundrobin/i.test(k))).toEqual([]);
    // A transferência administrativa (carteiraCallable) é provada em n35-29-transferencia-admin.local.test.js (módulo ainda não publicado).
  });
});

describe('Legado e conflitos (LEG) — nada retroativo', () => {
  test('LEG-01 cliente legado Murilo/Swyanne: histórico antigo não migra; só um evento futuro válido decide', async () => {
    for (const d of ['2024-01-10', '2024-05-10', '2025-06-10']) await venda('8800401', d, null, { vendGc: GC[MUR] });
    await venda('8800401', '2025-11-10', ADE);                                               // antes da ativação
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect(await cart('8800401')).toBeNull();
    const v1 = await venda('8800401', '2026-02-01', ADE);                                    // 83 dias depois: aguarda
    expect(await proc(v1)).toMatchObject({ decisao: 'MANTER', motivo: 'SEM_CARTEIRA_AGUARDANDO_REATIVACAO_120D' });
    await venda('8800402', '2025-01-10', null, { vendGc: GC[MUR] });
    const v2 = await venda('8800402', '2026-09-20', ADE);                                    // >= 120: nasce a carteira
    expect(await proc(v2)).toMatchObject({ decisao: 'CRIAR_REATIVACAO', ownerDepoisUid: ADE });
    expect((await hist('8800402'))[0]).toMatchObject({ tipoEvento: 'CARTEIRA_CRIADA_REATIVACAO', ownerAnteriorUid: null });
  });
  test('LEG-02 conflito Fabiana × Ademir existente não é corrigido retroativamente', async () => {
    await carteira('8800403', FAB);
    for (const d of ['2025-02-01', '2025-04-01', '2025-11-01']) await venda('8800403', d, ADE);     // vendas do outro, antes da ativação
    await venda('8800404', '2025-03-01', FAB); await venda('8800404', '2025-10-01', ADE);            // sem carteira, antes da ativação
    await db.doc('carteira_comercial_config/regra').set(REGRA);
    const res = await R.processarVendasRecentes(db, { agoraIso: AGORA });
    expect(res.lidas).toBe(0);
    expect((await cart('8800403')).ownerUid).toBe(FAB);
    expect(await cart('8800404')).toBeNull();
  });
});

describe('Worklist independente (WL)', () => {
  function espiao() {
    const colecoes = new Set();
    const wrap = { collection: n => { colecoes.add(n); return db.collection(n); }, runTransaction: (f, o) => db.runTransaction(f, o) };
    return { wrap, colecoes };
  }
  test('WL-01 atribuição da Worklist/claim não altera carteira e o motor nunca toca coleções da fila', async () => {
    await carteira('8800501', FAB); await venda('8800501', '2026-04-01', FAB);
    await db.doc('interacoes_fila/t29-claim').set({ eventos: [{ tipo: 'CLAIMED', operadorId: ADE }] });
    const { wrap, colecoes } = espiao();
    const v = await venda('8800501', '2026-09-20', ADE, { situacao: 'Em andamento' });
    await R.processarVendaCarteira(wrap, { vendaId: v, agoraIso: AGORA, regraDoc: REGRA });
    expect((await cart('8800501')).ownerUid).toBe(FAB);
    const v2 = await venda('8800501', '2026-09-21', ADE);
    await R.processarVendaCarteira(wrap, { vendaId: v2, agoraIso: AGORA, regraDoc: REGRA });
    for (const c of colecoes) expect(['vendas_gc', 'carteira_comercial', 'carteira_comercial_historico', 'carteira_comercial_decisoes', 'clientes', 'sistema_usuarios', 'users']).toContain(c);
  });
  test('WL-02 dono Fabiana, 150 dias, Worklist/claim Ademir, sem venda → dono Fabiana', async () => {
    await carteira('8800502', FAB); await venda('8800502', dMenos('2026-09-27', 150), FAB);
    await db.doc('interacoes_fila/t29-claim').set({ eventos: [{ tipo: 'CLAIMED', operadorId: ADE }] });
    expect((await cart('8800502')).ownerUid).toBe(FAB);
  });
  test('WL-03 mesmo cenário + venda válida do Ademir → dono Ademir; Fabiana de férias → dono Fabiana', async () => {
    await carteira('8800503', FAB); await venda('8800503', '2026-04-01', FAB);
    expect((await proc(await venda('8800503', '2026-09-20', ADE))).decisao).toBe('TRANSFERIR_R2');
    expect((await cart('8800503')).ownerUid).toBe(ADE);
    await vendedor(FAB, { situacao: 'PAUSA_TEMPORARIA', pausaMotivo: 'FERIAS' });
    await carteira('8800504', FAB); await venda('8800504', '2026-04-01', FAB);
    expect((await proc(await venda('8800504', '2026-09-20', ADE))).motivo).toBe('COBERTURA_PAUSA_TEMPORARIA');
    expect((await cart('8800504')).ownerUid).toBe(FAB);
  });
});

describe('Terceiro vendedor por configuração (MV)', () => {
  beforeEach(() => vendedor(C));
  test('MV-01 primeira venda do vendedor C cria carteira dele', async () => {
    expect((await proc(await venda('8800601', '2026-09-20', C))).ownerDepoisUid).toBe(C);
  });
  test('MV-02 vendedor C reativa cliente da Fabiana (>=120) → R2 para C', async () => {
    await carteira('8800602', FAB); await venda('8800602', '2026-05-01', FAB);
    expect(await proc(await venda('8800602', '2026-09-20', C))).toMatchObject({ decisao: 'TRANSFERIR_R2', ownerDepoisUid: C });
  });
  test('MV-03 vendedor C em pausa tem a carteira protegida', async () => {
    await vendedor(C, { situacao: 'PAUSA_TEMPORARIA', pausaMotivo: 'LICENCA' });
    await carteira('8800603', C); await venda('8800603', '2026-03-01', C);
    expect((await proc(await venda('8800603', '2026-09-20', ADE))).motivo).toBe('COBERTURA_PAUSA_TEMPORARIA');
  });
  test('MV-04 vendedor C desligado: não recebe novas e nada é redistribuído (a gestão decide)', async () => {
    await vendedor(C, { situacao: 'DESLIGADO' });
    expect((await proc(await venda('8800604', '2026-09-20', C))).motivo).toBe('VENDEDOR_DESLIGADO');
    await carteira('8800605', C); await venda('8800605', '2026-09-01', C);
    expect((await proc(await venda('8800605', '2026-09-20', ADE))).motivo).toBe('CARTEIRA_PROTEGIDA_MENOS_120D');
    expect((await cart('8800605')).ownerUid).toBe(C);
    expect(R.avaliarDesligamento({ carteiras: [{ ownerUid: C }], uid: C })).toMatchObject({ AUTO_REDISTRIBUTION: 0, MANAGEMENT_ACTION_REQUIRED: true });
  });
});

describe('Modos, segurança e dados', () => {
  test('MO-01 modo DESLIGADO e SOMBRA não gravam carteira nem histórico', async () => {
    await carteira('8800701', FAB); await venda('8800701', '2026-03-01', FAB);
    const v = await venda('8800701', '2026-09-20', ADE);
    expect((await R.processarVendaCarteira(db, { vendaId: v, agoraIso: AGORA, regraDoc: { modo: 'DESLIGADO', ativoDesde: '2026-01-01' } })).status).toBe('DESLIGADO');
    const s = await R.processarVendaCarteira(db, { vendaId: v, agoraIso: AGORA, regraDoc: { modo: 'SOMBRA', ativoDesde: '2026-01-01' } });
    expect(s).toMatchObject({ decisao: 'TRANSFERIR_R2' });
    expect((await cart('8800701'))).toMatchObject({ ownerUid: FAB, versao: 1 });
    expect(await hist('8800701')).toHaveLength(0);
    expect((await db.collection('carteira_comercial_decisoes_sombra').where('vendaId', '==', v).get()).size).toBe(1);
    expect((await db.collection('carteira_comercial_decisoes').where('vendaId', '==', v).get()).size).toBe(0);
  });
  test('SEG-01 carteira, histórico e decisões sem PII/financeiro/segredo', async () => {
    await proc(await venda('8800801', '2026-09-20', FAB));
    await carteira('8800802', FAB); await venda('8800802', '2026-03-01', FAB); await proc(await venda('8800802', '2026-09-20', ADE));
    const docs = [];
    for (const c of ['carteira_comercial', 'carteira_comercial_historico', 'carteira_comercial_decisoes']) docs.push(...(await db.collection(c).get()).docs.map(d => d.data()));
    const chaves = JSON.stringify(docs.map(d => Object.keys(d)));
    expect(chaves).not.toMatch(/nome|cpf|cnpj|telefone|email|endereco|ticket|valor|faturamento|margem|lucro|custo|senha|token|segredo|secret/i);
    for (const d of docs.filter(x => x.schemaVersion)) expect(V1.validarDocCarteiraV1(d)).toBeNull();
  });
  test('SEG-02 decisão pura: bordas 119/120/121 e ordem das proteções', () => {
    const regra = R.lerRegra(REGRA), sit = { elegivel: true, pausaProtegida: false };
    const vend = { status: 'RESOLVIDO', uid: 'B', situacao: sit };
    const venda = { id: '9', data: '2026-09-20' };
    const ant = n => [{ id: '1', data: dMenos('2026-09-20', n) }];
    const d = (n, extra = {}) => R.decidirVendaCarteira({ carteira: { ownerUid: 'A' }, anteriores: ant(n), venda, vendedor: vend, dono: null, regra, ...extra });
    expect(d(119).decisao).toBe('MANTER'); expect(d(120).decisao).toBe('TRANSFERIR_R2'); expect(d(121).decisao).toBe('TRANSFERIR_R2');
    expect(d(200, { dono: { pausaProtegida: true } }).motivo).toBe('COBERTURA_PAUSA_TEMPORARIA');
    expect(d(200, { dono: { situacao: 'DESLIGADO', pausaProtegida: false } }).decisao).toBe('TRANSFERIR_R2');   // regra geral vale para dono desligado
    expect(R.decidirVendaCarteira({ carteira: null, anteriores: ant(30), venda, vendedor: vend, dono: null, regra: R.lerRegra({ ...REGRA, politicaSemCarteiraComHistorico: 'PROXIMA_VENDA' }) }).decisao).toBe('CRIAR_REATIVACAO');
  });
});
