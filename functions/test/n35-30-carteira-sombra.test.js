'use strict';
// N35.30 — Regra da carteira em MODO SOMBRA: isolamento, corte de ativação, checkpoint, idempotência, kill switch. EMULADOR.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT          = 'mr4-ponto';

const path = require('path');
const fs = require('fs');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const R = require('../lib/carteiraRegra');
const V1 = require('../lib/carteiraV1');
const JOB = require('../lib/carteiraRegraJob');

const CORTE = '2026-09-28';
const AGORA = '2026-10-05T12:00:00.000Z';
const SOMBRA = { modo: 'SOMBRA', ativoDesde: CORTE };
const FAB = 't30-fab', ADE = 't30-ade', MUR = 't30-mur';
const GC = { [FAB]: '9200001', [ADE]: '9200002', [MUR]: '9200003' };
const OFICIAIS = ['carteira_comercial', 'carteira_comercial_historico', 'carteira_comercial_decisoes'];
const criados = { vendas: new Set(), users: new Set() };

async function vendedor(uid, { pode = true, pausa = false, pausaMotivo, gc = GC[uid], ativoCom = true } = {}) {
  criados.users.add(uid);
  await db.doc('users/' + uid).set({ role: 'funcionario', ativo: true });
  await db.doc('sistema_usuarios/' + uid).set({ bloqueado: false, modulos: ['fila-comercial', 'fila-comercial-operar'],
    carteiraComercial: { podePossuirCarteira: pode, ativoComercialmente: ativoCom, pausaTemporaria: pausa, desligado: false, gestaoClickVendedorId: gc, ...(pausaMotivo ? { pausaMotivo } : {}) } });
}
let seq = 0;
async function venda(cli, data, uid, { situacao = 'Concretizada', valor = '150.00', vendGc, id, mod } = {}) {
  const vid = id || String(710000000 + (++seq));
  criados.vendas.add(vid);
  await db.doc('vendas_gc/' + vid).set({ id: vid, cliente_id: String(cli), data, nome_situacao: situacao, valor_total: valor,
    vendedor_id: vendGc !== undefined ? vendGc : (GC[uid] || ''), nome_vendedor: 'Pessoa Teste', nome_cliente: 'Cliente Teste', cpf: '00000000000', produtos: [],
    cadastrado_em: data + ' 12:00:00', modificado_em: mod || (data + ' 12:00:00') });
  return vid;
}
async function carteira(cli, owner) {
  await db.doc('carteira_comercial/GC:' + cli).set(V1.montarDocCarteiraV1({ portfolioId: 'GC:' + cli, ownerUid: owner, ownerDesde: '2026-09-26T00:00:00.000Z',
    origemComercialUid: owner, origemComercialGestaoClickId: GC[owner] || null, criadoEm: '2026-09-26T00:00:00.000Z', atualizadoEm: '2026-09-26T00:00:00.000Z', versao: 1 }));
}
const regra = doc => db.doc('carteira_comercial_config/regra').set(doc);
const job = () => JOB.carteiraRegraJobHandler(null, { db, now: () => new Date(AGORA) });
const tamanho = async c => (await db.collection(c).get()).size;
const sombras = async () => (await db.collection('carteira_comercial_decisoes_sombra').get()).docs.map(d => ({ id: d.id, ...d.data() }));
async function oficiaisSnapshot() {
  const out = {};
  for (const c of OFICIAIS) out[c] = JSON.stringify((await db.collection(c).get()).docs.map(d => [d.id, d.data()]).sort());
  return out;
}
async function limpar() {
  for (const c of [...OFICIAIS, 'carteira_comercial_decisoes_sombra', 'carteira_comercial_config']) for (const d of (await db.collection(c).get()).docs) await d.ref.delete();
  for (const id of criados.vendas) await db.doc('vendas_gc/' + id).delete();
  for (const u of criados.users) { await db.doc('users/' + u).delete(); await db.doc('sistema_usuarios/' + u).delete(); }
  criados.vendas.clear(); criados.users.clear();
}
let logs;
beforeEach(async () => {
  await limpar(); await vendedor(FAB); await vendedor(ADE); await vendedor(MUR, { pode: false });
  logs = []; jest.spyOn(console, 'log').mockImplementation((...a) => logs.push(a.join(' '))); jest.spyOn(console, 'error').mockImplementation((...a) => logs.push(a.join(' ')));
});
afterEach(() => jest.restoreAllMocks());
afterAll(limpar);

describe('Modos e isolamento', () => {
  test('SH-01 DESLIGADO (ausente, inválido ou explícito): nenhuma escrita, nem sombra', async () => {
    await carteira('8810001', FAB); await venda('8810001', '2026-03-01', FAB); await venda('8810001', '2026-09-30', ADE);
    for (const cfg of [null, { modo: 'SOMBRA' }, { modo: 'DESLIGADO', ativoDesde: CORTE }, { modo: 'LIGADO', ativoDesde: CORTE }]) {
      if (cfg) await regra(cfg); else await db.doc('carteira_comercial_config/regra').delete();
      const r = await job();
      expect(r.status).toBe('DESLIGADO');
    }
    expect(await tamanho('carteira_comercial_decisoes_sombra')).toBe(0);
    expect(await tamanho('carteira_comercial_decisoes')).toBe(0);
    expect(await tamanho('carteira_comercial_historico')).toBe(0);
    expect((await db.collection('carteira_comercial_config').get()).docs.map(d => d.id)).toEqual(['regra']);   // nem checkpoint
  });
  test('SH-02 SOMBRA: venda que causaria R2 grava SÓ a decisão sombra; oficiais byte a byte iguais', async () => {
    await carteira('8810002', FAB); await venda('8810002', '2026-04-01', FAB); await venda('8810002', '2026-09-30', ADE);
    await regra(SOMBRA);
    const antes = await oficiaisSnapshot();
    const r = await job();
    expect(r).toMatchObject({ status: 'OK', modo: 'SOMBRA', processadas: 1, porDecisaoSombra: { TRANSFERIRIA_R2: 1 } });
    expect(await oficiaisSnapshot()).toEqual(antes);
    expect(await sombras()).toHaveLength(1);
  });
  test('SH-03 trava de código: config ATIVO + job publicado continua SOMBRA (OFFICIAL_WRITES=0)', async () => {
    expect(JOB.FORCAR_SOMBRA).toBe(true);
    await carteira('8810003', FAB); await venda('8810003', '2026-04-01', FAB); await venda('8810003', '2026-09-30', ADE);
    await venda('8810004', '2026-09-30', ADE);                                                  // primeira venda
    await regra({ modo: 'ATIVO', ativoDesde: CORTE });
    const antes = await oficiaisSnapshot();
    const r = await job();
    expect(r.modo).toBe('SOMBRA');
    expect(await oficiaisSnapshot()).toEqual(antes);
    expect((await sombras()).map(s => s.modo)).toEqual(['SOMBRA', 'SOMBRA']);
    expect(R.modoEfetivo(R.lerRegra({ modo: 'ATIVO', ativoDesde: CORTE }), true)).toBe('SOMBRA');
    expect(R.lerRegra(null).modo).toBe('DESLIGADO');                                            // padrão fail-safe
  });
  test('SH-04 index.js publica o job pelo wrapper com trava de sombra', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    expect(idx).toMatch(/exports\.processarCarteiraComercial = onSchedule\(/);
    expect(idx).toMatch(/carteiraRegraJobHandler\(event\)/);
    const job = fs.readFileSync(path.join(__dirname, '../lib/carteiraRegraJob.js'), 'utf8');
    expect(job).toMatch(/const FORCAR_SOMBRA = true;/);
    expect(job).toMatch(/forcarSombra: FORCAR_SOMBRA/);
  });
});

describe('Payload e logs', () => {
  test('SH-05 whitelist: cada decisão sombra só com IDs/contagens; campos pessoais da venda nunca são copiados', async () => {
    await carteira('8810005', FAB); await venda('8810005', '2026-04-01', FAB); await venda('8810005', '2026-09-30', ADE);
    await venda('8810006', '2026-09-30', FAB); await venda('8810007', '2026-09-30', MUR);
    await regra(SOMBRA); await job();
    const docs = await sombras();
    expect(docs).toHaveLength(3);
    for (const d of docs) {
      const { id, ...campos } = d;
      expect(R.validarDecisao(campos)).toBeNull();
      expect(Object.keys(campos).every(k => R.CAMPOS_DECISAO.includes(k))).toBe(true);
      expect(JSON.stringify(campos)).not.toMatch(/Cliente Teste|Pessoa Teste|00000000000|150\.00/);
    }
    expect(R.validarDecisao({ vendaId: '1', nomeCliente: 'x' })).toMatch(/CAMPOS_NAO_PERMITIDOS/);
    expect(R.validarDecisao({ vendaId: '1', valor_total: '1' })).toMatch(/CAMPOS_NAO_PERMITIDOS/);
  });
  test('SH-06 log estruturado sem PII (runId, modo, versão, corte, checkpoints, contagens, duração)', async () => {
    await venda('8810008', '2026-09-30', FAB);
    await regra(SOMBRA); await job();
    const linha = logs.find(l => l.includes('"job":"processarCarteiraComercial"'));
    const j = JSON.parse(linha);
    expect(j).toMatchObject({ status: 'OK', mode: 'SOMBRA', ruleVersion: 'N35.32', lateArrivalMechanism: 'MARCA_DAGUA_MODIFICADO_EM+JANELA_DATA', cutoff: CORTE, checkpointBefore: null,
      checkpointAfter: '2026-09-30 12:00:00', processed: 1, errors: 0 });
    expect(j.runId).toMatch(/^\d{14}-[0-9a-f]{6}$/);
    expect(typeof j.durationMs).toBe('number');
    expect(logs.join('\n')).not.toMatch(/Cliente Teste|Pessoa Teste|00000000000|cpf|cnpj|telefone|email|token|secret/i);
  });
});

describe('Idempotência e concorrência', () => {
  test('SH-07 1 venda = 1 decisão sombra (job 3x + 6 execuções simultâneas)', async () => {
    await carteira('8810009', FAB); await venda('8810009', '2026-04-01', FAB);
    const v = await venda('8810009', '2026-09-30', ADE);
    await regra(SOMBRA);
    await Promise.all(Array.from({ length: 6 }, () => R.reavaliarClienteSombra(db, { gcCliente: '8810009', agoraIso: AGORA, regra: R.lerRegra(SOMBRA), runId: 'c' })));
    await job(); await job(); await job();
    expect((await sombras()).filter(s => s.vendaId === v)).toHaveLength(1);
    expect((await db.doc('carteira_comercial/GC:8810009').get()).data()).toMatchObject({ ownerUid: FAB, versao: 1 });
  });
});

describe('Corte de ativação e checkpoint', () => {
  test('SH-08 primeira execução: histórico anterior ao corte nunca é lido como novo (sem replay)', async () => {
    const b = db.batch();
    for (let i = 0; i < 60; i++) { const id = String(720000000 + i); criados.vendas.add(id);
      const data = '2026-0' + (1 + (i % 8)) + '-15';
      b.set(db.doc('vendas_gc/' + id), { id, cliente_id: String(8811000 + (i % 7)), data, nome_situacao: 'Concretizada', valor_total: '10', vendedor_id: GC[ADE], cadastrado_em: data + ' 10:00:00', modificado_em: data + ' 10:00:00' }); }
    await b.commit();
    await venda('8811000', '2026-09-27', ADE);                                                   // véspera do corte
    const nova = await venda('8811001', '2026-09-28', FAB);                                     // dia do corte
    await regra(SOMBRA);
    const r = await job();
    expect(r).toMatchObject({ corte: CORTE, checkpointAntes: null, clientesReavaliados: 1, processadas: 1, checkpointDepois: '2026-09-28 12:00:00' });
    expect((await sombras()).map(s => s.vendaId)).toEqual([nova]);
    const cp = (await db.doc('carteira_comercial_config/checkpoint_sombra_v2').get()).data();
    expect(cp).toMatchObject({ versao: 2, corte: CORTE, marcaDagua: '2026-09-28 12:00:00' });
    expect((await db.doc('carteira_comercial_config/checkpoint_sombra').get()).exists).toBe(false);   // V1 não é mais escrito
  });
  test('SH-09 checkpoint só avança com sucesso; falha no meio não perde venda', async () => {
    await regra(SOMBRA);
    await venda('8811101', '2026-09-29', FAB); const v2 = await venda('8811102', '2026-10-02', ADE);
    let falhar = true;
    const store = { collection: n => db.collection(n), runTransaction: (f, o) => { if (falhar) throw new Error('falha simulada'); return db.runTransaction(f, o); } };
    const r1 = await R.processarVendasRecentes(store, { agoraIso: AGORA, forcarSombra: true, runId: 'x' });
    expect(r1).toMatchObject({ status: 'ERRO_PARCIAL', erros: 2, checkpointDepois: null });
    expect((await db.doc('carteira_comercial_config/checkpoint_sombra_v2').get()).exists).toBe(false);
    falhar = false;
    const r2 = await R.processarVendasRecentes(store, { agoraIso: AGORA, forcarSombra: true, runId: 'y' });
    expect(r2).toMatchObject({ status: 'OK', processadas: 2, checkpointDepois: '2026-10-02 12:00:00' });
    expect((await sombras()).map(s => s.vendaId)).toContain(v2);
  });
  test('SH-10 venda atrasada dentro da janela ainda é avaliada; corte alterado descarta checkpoint', async () => {
    await regra(SOMBRA);
    await venda('8811201', '2026-10-04', FAB); await job();
    const atrasada = await venda('8811202', '2026-09-29', ADE, { mod: '2026-10-05 08:00:00' });  // lançada depois, data comercial antiga (>= corte)
    const r = await job();
    expect(r).toMatchObject({ checkpointAntes: '2026-10-04 12:00:00', processadas: 1, checkpointDepois: '2026-10-05 08:00:00' });
    expect((await sombras()).map(s => s.vendaId)).toContain(atrasada);
    await regra({ ...SOMBRA, ativoDesde: '2026-10-01' });
    expect((await job()).checkpointAntes).toBeNull();
  });
});

describe('Cenários críticos em SOMBRA (bloqueantes)', () => {
  const um = async () => (await sombras())[0];
  test('SH-11 cobertura: Fabiana em pausa, 150 dias, venda do Ademir → NAO_TRANSFERIR / COBERTURA_PAUSA_TEMPORARIA', async () => {
    await vendedor(FAB, { pausa: true, pausaMotivo: 'FERIAS' });
    await carteira('8812001', FAB); await venda('8812001', '2026-05-03', FAB); await venda('8812001', '2026-09-30', ADE);
    await regra(SOMBRA); await job();
    expect(await um()).toMatchObject({ decisaoSombra: 'NAO_TRANSFERIR', motivo: 'COBERTURA_PAUSA_TEMPORARIA', diasSemComprar: 150, ownerAntesUid: FAB, ownerDepoisUid: FAB });
    expect((await db.doc('carteira_comercial/GC:8812001').get()).data().ownerUid).toBe(FAB);
  });
  test('SH-12 R2: Fabiana ativa, 150 dias, venda do Ademir → TRANSFERIRIA_R2 F→A; dono oficial continua Fabiana', async () => {
    await carteira('8812002', FAB); await venda('8812002', '2026-05-03', FAB); await venda('8812002', '2026-09-30', ADE);
    await regra(SOMBRA); await job();
    expect(await um()).toMatchObject({ decisaoSombra: 'TRANSFERIRIA_R2', decisao: 'TRANSFERIR_R2', ownerAntesUid: FAB, ownerDepoisUid: ADE, diasSemComprar: 150, modo: 'SOMBRA' });
    expect((await db.doc('carteira_comercial/GC:8812002').get()).data()).toMatchObject({ ownerUid: FAB, versao: 1 });
    expect(await tamanho('carteira_comercial_historico')).toBe(0);
  });
  test('SH-12b bordas em SOMBRA: 119 não, 120 sim', async () => {
    await carteira('8812003', FAB); await venda('8812003', '2026-06-02', FAB); await venda('8812003', '2026-09-29', ADE);   // 119
    await carteira('8812004', FAB); await venda('8812004', '2026-06-01', FAB); await venda('8812004', '2026-09-29', ADE);   // 120
    await regra(SOMBRA); await job();
    const s = await sombras();
    expect(s.find(x => x.portfolioId === 'GC:8812003')).toMatchObject({ diasSemComprar: 119, decisaoSombra: 'NAO_TRANSFERIR' });
    expect(s.find(x => x.portfolioId === 'GC:8812004')).toMatchObject({ diasSemComprar: 120, decisaoSombra: 'TRANSFERIRIA_R2' });
  });
  test('SH-13 primeira venda: nunca comprou, venda do Ademir → CRIARIA_CARTEIRA; nada criado', async () => {
    await venda('8812005', '2026-09-30', ADE);
    await regra(SOMBRA); await job();
    expect(await um()).toMatchObject({ decisaoSombra: 'CRIARIA_CARTEIRA', ownerDepoisUid: ADE, ownerAntesUid: null });
    expect((await db.doc('carteira_comercial/GC:8812005').get()).exists).toBe(false);
  });
  test('SH-14 histórico sem carteira: 80 dias → NAO_CRIAR; 150 dias → CRIARIA_CARTEIRA_REATIVACAO; nada criado', async () => {
    await venda('8812006', '2026-07-12', MUR); await venda('8812006', '2026-09-30', ADE);        // 80
    await venda('8812007', '2026-05-03', MUR); await venda('8812007', '2026-09-30', ADE);        // 150
    await regra(SOMBRA); await job();
    const s = await sombras();
    expect(s.find(x => x.portfolioId === 'GC:8812006')).toMatchObject({ diasSemComprar: 80, decisaoSombra: 'NAO_CRIAR' });
    expect(s.find(x => x.portfolioId === 'GC:8812007')).toMatchObject({ diasSemComprar: 150, decisaoSombra: 'CRIARIA_CARTEIRA_REATIVACAO', ownerDepoisUid: ADE });
    expect(await tamanho('carteira_comercial')).toBe(0);
  });
  test('SH-15 vendedor não habilitado (Murilo) e não configurado → REVISAO_GESTAO; nada criado/transferido', async () => {
    await venda('8812008', '2026-09-30', MUR);
    await venda('8812009', '2026-09-30', null, { vendGc: '9299999' });
    await carteira('8812010', FAB); await venda('8812010', '2026-04-01', FAB); await venda('8812010', '2026-09-30', MUR);
    await regra(SOMBRA); await job();
    const s = await sombras();
    expect(s.find(x => x.portfolioId === 'GC:8812008')).toMatchObject({ decisaoSombra: 'REVISAO_GESTAO', motivo: 'VENDEDOR_NAO_HABILITADO' });
    expect(s.find(x => x.portfolioId === 'GC:8812009')).toMatchObject({ decisaoSombra: 'REVISAO_GESTAO', motivo: 'VENDEDOR_NAO_RESOLVIDO' });
    expect(s.find(x => x.portfolioId === 'GC:8812010')).toMatchObject({ decisaoSombra: 'REVISAO_GESTAO', ownerDepoisUid: FAB });
    expect((await db.doc('carteira_comercial/GC:8812010').get()).data().ownerUid).toBe(FAB);
    expect(await tamanho('carteira_comercial')).toBe(1);
  });
  test('SH-16 vendas inválidas (cancelada, orçamento, em aberto, valor zero, sem cliente) não geram decisão', async () => {
    await venda('8812011', '2026-09-30', ADE, { situacao: 'Cancelada' });
    await venda('8812011', '2026-09-30', ADE, { situacao: 'Orçamento' });
    await venda('8812011', '2026-09-30', ADE, { situacao: 'Em aberto' });
    await venda('8812011', '2026-09-30', ADE, { valor: '0.00' });
    await venda('', '2026-09-30', ADE);
    await regra(SOMBRA);
    const r = await job();
    expect(r.processadas).toBe(0);
    expect(r.ignoradasPorMotivo).toMatchObject({ SITUACAO_NAO_CONCRETIZADA: 3, VALOR_ZERADO: 1, SEM_CLIENTE: 1 });
    expect(await sombras()).toHaveLength(0);
  });
  test('SH-17 venda cancelada após decisão sombra: nova revisão INVALIDADA na SOMBRA, nunca na coleção oficial', async () => {
    await carteira('8812012', FAB); await venda('8812012', '2026-04-01', FAB);
    const v = await venda('8812012', '2026-09-30', ADE);
    await regra(SOMBRA); await job();
    await db.doc('vendas_gc/' + v).update({ nome_situacao: 'Cancelada', modificado_em: '2026-10-05 08:00:00' });
    const r = await job();
    expect(r.invalidadas).toBe(1);
    const revs = (await sombras()).filter(x => x.vendaId === v).sort((a, b) => a.revisao - b.revisao);
    expect(revs.map(x => [x.revisao, x.decisaoSombra])).toEqual([[1, 'TRANSFERIRIA_R2'], [2, 'INVALIDADA']]);
    expect(revs[1]).toMatchObject({ motivo: 'VENDA_INVALIDADA_SITUACAO_NAO_CONCRETIZADA', substitui: revs[0].decisionId, causa: 'VENDA_ALTERADA' });
    expect(await tamanho('carteira_comercial_decisoes')).toBe(0);
  });
});

describe('Kill switch', () => {
  test('SH-18 SOMBRA → DESLIGADO: próxima execução 0 decisões novas e 0 escritas; volta a SOMBRA e processa', async () => {
    await regra(SOMBRA);
    await venda('8813001', '2026-09-29', FAB); await job();
    expect(await sombras()).toHaveLength(1);
    await regra({ ...SOMBRA, modo: 'DESLIGADO' });
    const nova = await venda('8813002', '2026-09-30', ADE);
    const cpAntes = (await db.doc('carteira_comercial_config/checkpoint_sombra_v2').get()).data();
    const antes = await oficiaisSnapshot();
    expect((await job()).status).toBe('DESLIGADO');
    expect(await sombras()).toHaveLength(1);
    expect(await oficiaisSnapshot()).toEqual(antes);
    expect((await db.doc('carteira_comercial_config/checkpoint_sombra_v2').get()).data()).toEqual(cpAntes);
    await regra(SOMBRA);
    await job();
    expect((await sombras()).map(s => s.vendaId)).toContain(nova);
  });
});
