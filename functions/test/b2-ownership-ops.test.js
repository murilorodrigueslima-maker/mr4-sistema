'use strict';
// B2 — operações de ownership (PREPARADAS, INATIVAS): transação, versão, idempotência, concorrência, conflito, revisor, auditoria. (EMULADOR)
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const OWN = require('../lib/carteiraOwnership'); const C2 = require('../lib/carteiraV2'); const H2 = require('../lib/carteiraHistoricoV2');
jest.setTimeout(120000);
const ADE = 'b2o-ade', FAB = 'b2o-fab', CAM = 'b2o-cam', GES = 'b2o-ges', VEND = 'b2o-vend', BLOQ = 'b2o-bloq';
const erro = p => p.then(() => 'OK', e => e.code || e.message);
const limpar = async cols => { for (const c of cols) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const T0 = '2026-09-26T13:59:45.769Z';
const v2 = (gc, owner, ex = {}) => ({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: '111', criadoEm: T0, atualizadoEm: T0, versao: 2,
  status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: null, conflito: null, ultimoEventoId: 'MIGRACAO_N3526_ONDA1_GC_' + gc, schemaMigradoDe: 'carteira-v1', v2MigradoEm: T0, v2LoteId: 'L', ...ex });
const conflito = rel => ({ grupoId: 'CG-0123456789ab', tipos: ['DOC_IGUAL'], forca: 'FORTE', relacionados: rel, donosDiferentes: false, revisao: 'PENDENTE', revisores: ['PROPRIETARIO', 'CAMILA'], detectadoEm: T0, origemDeteccao: 'B2_BACKFILL' });
const base = (gc, extra) => ({ portfolioId: 'GC:' + gc, motivo: 'teste', operadorUid: GES, atorTipo: 'USER', origemOperacao: 'CALLABLE', ...extra });
const lerC = async gc => (await db.doc('carteira_comercial/GC:' + gc).get()).data();
const nEv = async gc => (await db.collection('carteira_comercial_historico').where('portfolioId', '==', 'GC:' + gc).get()).size;

beforeAll(async () => {
  await limpar(['carteira_comercial', 'carteira_comercial_historico', 'users', 'sistema_usuarios', 'audit_log']);
  for (const [uid, role, mods] of [[ADE, 'funcionario', ['fila-comercial-operar']], [FAB, 'funcionario', ['fila-comercial-operar']], [CAM, 'funcionario', ['fila-comercial-gestao']], [GES, 'gestor', []], [VEND, 'funcionario', ['clientes']], [BLOQ, 'funcionario', ['fila-comercial-operar']]]) {
    await db.doc('users/' + uid).set({ role, ativo: true }); await db.doc('sistema_usuarios/' + uid).set({ nome: uid, modulos: mods, admin: false, ...(uid === BLOQ ? { bloqueado: true } : {}) });
  }
});
afterAll(async () => { await limpar(['carteira_comercial', 'carteira_comercial_historico', 'users', 'sistema_usuarios', 'audit_log']); });

describe('B2 ops — INATIVAS por construção', () => {
  test('nenhum callable/job/gatilho/export de index.js usa carteiraOwnership; regra 120d segue forçada em SOMBRA', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
    expect(idx).not.toMatch(/carteiraOwnership|carteiraV2|b2_carteira/);
    expect(require('../lib/carteiraRegraJob').FORCAR_SOMBRA).toBe(true);
    for (const f of fs.readdirSync(path.join(__dirname, '../lib')).filter(x => x.endsWith('.js'))) if (!['carteiraOwnership.js', 'reativacaoOps.js', 'restricoes.js', 'devolucoes.js', 'reativacaoReversao.js'].includes(f)) expect(fs.readFileSync(path.join(__dirname, '../lib', f), 'utf8')).not.toMatch(/require\(['"]\.\/carteiraOwnership['"]\)/);
  });
  test('Rules: carteira e histórico seguem sem escrita do cliente (nenhum perfil)', () => {
    const r = fs.readFileSync(path.join(__dirname, '../../modulos/firestore.rules'), 'utf8');
    expect(r).toMatch(/match \/carteira_comercial\/\{entidadeId\}[\s\S]*?allow write: if false;/); expect(r).toMatch(/match \/carteira_comercial_historico\/\{eventoId\}[\s\S]*?allow write: if false;/);
  });
});

describe('B2 ops — criação', () => {
  test('cria carteira para âncora sem carteira: v2 válida, evento v2, auditoria S7 pós-commit; retry com a mesma chave não duplica', async () => {
    const p = base('7001', { ownerUid: ADE, origem: 'PRIMEIRA_VENDA', chaveIdempotencia: 'PRIMEIRA_VENDA:v1', referencias: { vendaGcId: 'v1' }, origemComercialGestaoClickId: '111' });
    const r1 = await OWN.criarCarteira(db, FieldValue, p); expect(r1.repetido).toBe(false);
    const d = await lerC('7001'); expect(C2.validarDocCarteiraV2(d)).toBeNull(); expect(d).toMatchObject({ ownerUid: ADE, versao: 1, status: 'ATIVA', origem: 'PRIMEIRA_VENDA' });
    const r2 = await OWN.criarCarteira(db, FieldValue, p); expect(r2.repetido).toBe(true); expect(await nEv('7001')).toBe(1);
    const ev = (await db.collection('carteira_comercial_historico').doc(r1.eventoId).get()).data(); expect(ev).toMatchObject({ schemaVersion: 'historico-v2', tipoEvento: 'CARTEIRA_CRIADA_PRIMEIRA_VENDA', ownerAnteriorUid: null, ownerNovoUid: ADE, versaoCarteiraAntes: null, versaoCarteiraDepois: 1, seq: 1 });
    const aud = await db.collection('audit_log').where('entityId', '==', 'GC:7001').get(); expect(aud.size).toBe(1); expect(aud.docs[0].data()).toMatchObject({ category: 'COMMERCIAL', actorUid: GES, action: 'PORTFOLIO_CARTEIRA_CRIADA_PRIMEIRA_VENDA' });
  });
  test('recusa: carteira já existente, owner bloqueado/sem módulo, origem de migração, chave reutilizada em outra operação', async () => {
    expect(await erro(OWN.criarCarteira(db, FieldValue, base('7001', { ownerUid: FAB, origem: 'PRIMEIRA_VENDA', chaveIdempotencia: 'PV:outra' })))).toBe('already-exists');
    expect(await erro(OWN.criarCarteira(db, FieldValue, base('7002', { ownerUid: BLOQ, origem: 'PRIMEIRA_VENDA', chaveIdempotencia: 'PV:b' })))).toBe('failed-precondition');
    expect(await erro(OWN.criarCarteira(db, FieldValue, base('7002', { ownerUid: VEND, origem: 'PRIMEIRA_VENDA', chaveIdempotencia: 'PV:c' })))).toBe('failed-precondition');
    expect(await erro(OWN.criarCarteira(db, FieldValue, base('7002', { ownerUid: ADE, origem: 'MIGRACAO_ONDA1_N3526', chaveIdempotencia: 'PV:d' })))).toBe('invalid-argument');
    expect((await db.doc('carteira_comercial/GC:7002').get()).exists).toBe(false);
  });
  test('cliente relacionado a conflito aberto NÃO ganha carteira (irmão sem carteira)', async () => {
    await db.doc('carteira_comercial/GC:7100').set(v2('7100', FAB, { status: 'EM_REVISAO', conflito: conflito(['GC:7101']) }));
    expect(await erro(OWN.criarCarteira(db, FieldValue, base('7101', { ownerUid: ADE, origem: 'PRIMEIRA_VENDA', chaveIdempotencia: 'PV:irmao' })))).toBe('failed-precondition');
    expect((await db.doc('carteira_comercial/GC:7101').get()).exists).toBe(false);
  });
  test('concorrência: dois vendedores criando a MESMA carteira → um único owner e um único evento', async () => {
    const r = await Promise.allSettled([OWN.criarCarteira(db, FieldValue, base('7200', { ownerUid: ADE, origem: 'PRIMEIRA_VENDA', chaveIdempotencia: 'PV:A' })), OWN.criarCarteira(db, FieldValue, base('7200', { ownerUid: FAB, origem: 'PRIMEIRA_VENDA', chaveIdempotencia: 'PV:F' }))]);
    expect(r.filter(x => x.status === 'fulfilled')).toHaveLength(1); expect(r.find(x => x.status === 'rejected').reason.code).toBe('already-exists'); expect(await nEv('7200')).toBe(1);
    expect([ADE, FAB]).toContain((await lerC('7200')).ownerUid);
  });
});

describe('B2 ops — transferência / reativação / renovação / liberação', () => {
  beforeAll(async () => { await db.doc('carteira_comercial/GC:7300').set(v2('7300', ADE)); });
  test('transferência exige versão esperada; sucesso gera 1 evento, bump de versão, NÃO mexe no ciclo; retry idempotente', async () => {
    expect(await erro(OWN.transferir(db, FieldValue, base('7300', { novoOwnerUid: FAB, versaoEsperada: 1, chaveIdempotencia: 'T:x' })))).toBe('aborted');
    const p = base('7300', { novoOwnerUid: FAB, versaoEsperada: 2, chaveIdempotencia: 'T:1', motivo: 'transferência administrativa' });
    const r = await OWN.transferir(db, FieldValue, p); expect(r.depois).toMatchObject({ ownerUid: FAB, versao: 3, cicloAncoraEm: null, status: 'ATIVA' });
    const rr = await OWN.transferir(db, FieldValue, p); expect(rr.repetido).toBe(true); expect(await nEv('7300')).toBe(1);
    expect((await db.collection('carteira_comercial_historico').doc(r.eventoId).get()).data()).toMatchObject({ tipoEvento: 'TRANSFERENCIA', ownerAnteriorUid: ADE, ownerNovoUid: FAB, versaoCarteiraAntes: 2, versaoCarteiraDepois: 3 });
  });
  test('transferências concorrentes com a mesma versão: só uma vence; nunca dois owners', async () => {
    const r = await Promise.allSettled([OWN.transferir(db, FieldValue, base('7300', { novoOwnerUid: ADE, versaoEsperada: 3, chaveIdempotencia: 'T:A' })), OWN.transferir(db, FieldValue, base('7300', { novoOwnerUid: CAM, versaoEsperada: 3, chaveIdempotencia: 'T:C' }))]);
    expect(r.filter(x => x.status === 'fulfilled').length).toBeLessThanOrEqual(1);
    const d = await lerC('7300'); expect(d.versao).toBeLessThanOrEqual(4); expect([ADE, FAB]).toContain(d.ownerUid);                 // CAM (sem módulo operar) nunca pode ser owner
  });
  test('renovação mantém o owner e avança o ciclo; ciclo não retrocede', async () => {
    await db.doc('carteira_comercial/GC:7400').set(v2('7400', ADE));
    const r = await OWN.renovarCiclo(db, FieldValue, base('7400', { versaoEsperada: 2, cicloAncoraEm: '2026-10-01', chaveIdempotencia: 'R:1' })); expect(r.depois).toMatchObject({ ownerUid: ADE, cicloAncoraEm: '2026-10-01', versao: 3 });
    expect(await erro(OWN.renovarCiclo(db, FieldValue, base('7400', { versaoEsperada: 3, cicloAncoraEm: '2026-09-01', chaveIdempotencia: 'R:2' })))).toBe('failed-precondition');
  });
  test('reativação troca owner e reinicia a âncora do ciclo; liberação remove o owner (LIBERADA)', async () => {
    await db.doc('carteira_comercial/GC:7500').set(v2('7500', ADE));
    const r = await OWN.reativar(db, FieldValue, base('7500', { novoOwnerUid: FAB, versaoEsperada: 2, cicloAncoraEm: '2026-10-07', chaveIdempotencia: 'RE:1' })); expect(r.depois).toMatchObject({ ownerUid: FAB, cicloAncoraEm: '2026-10-07', origem: 'REATIVACAO_120D' });
    const l = await OWN.liberar(db, FieldValue, base('7500', { versaoEsperada: 3, chaveIdempotencia: 'L:1' })); expect(l.depois).toMatchObject({ ownerUid: null, status: 'LIBERADA' }); expect(C2.validarDocCarteiraV2(l.depois)).toBeNull();
  });
  test('carteira v1 (não migrada) e carteira EM_REVISAO não aceitam transferência', async () => {
    await db.doc('carteira_comercial/GC:7600').set({ ...v2('7600', ADE), schemaVersion: 'carteira-v1' });
    expect(await erro(OWN.transferir(db, FieldValue, base('7600', { novoOwnerUid: FAB, versaoEsperada: 2, chaveIdempotencia: 'T:v1' })))).toBe('failed-precondition');
    await db.doc('carteira_comercial/GC:7601').set(v2('7601', ADE, { status: 'EM_REVISAO', conflito: conflito(['GC:7602']) }));
    expect(await erro(OWN.transferir(db, FieldValue, base('7601', { novoOwnerUid: FAB, versaoEsperada: 2, chaveIdempotencia: 'T:conf' })))).toBe('failed-precondition');
    expect((await lerC('7601')).ownerUid).toBe(ADE);
  });
});

describe('B2 ops — conflito de identidade', () => {
  beforeAll(async () => { await db.doc('carteira_comercial/GC:7700').set(v2('7700', ADE, { status: 'EM_REVISAO', conflito: { ...conflito(['GC:7701']), donosDiferentes: true } })); await db.doc('carteira_comercial/GC:7701').set(v2('7701', FAB, { status: 'EM_REVISAO', conflito: { ...conflito(['GC:7700']), donosDiferentes: true } })); });
  test('só proprietário (role gestor) ou Camila (módulo gestão, sem admin) resolvem; vendedor/bloqueado/inexistente não', async () => {
    for (const u of [ADE, FAB, VEND, BLOQ, 'nao-existe']) expect(await erro(OWN.resolverConflito(db, FieldValue, base('7700', { operadorUid: u, versaoEsperada: 2, resolucao: 'MANTIDA_SEM_MERGE', chaveIdempotencia: 'C:' + u })))).toBe('permission-denied');
    expect((await lerC('7700')).status).toBe('EM_REVISAO');
  });
  test('resolução NÃO escolhe vencedor nem muda owner: ambas as carteiras mantêm seus donos', async () => {
    const r = await OWN.resolverConflito(db, FieldValue, base('7700', { operadorUid: CAM, versaoEsperada: 2, resolucao: 'MANTIDA_SEM_MERGE', chaveIdempotencia: 'C:cam' }));
    expect(r.depois).toMatchObject({ status: 'ATIVA', ownerUid: ADE, versao: 3, conflito: { revisao: 'RESOLVIDO' } });
    expect((await lerC('7701')).ownerUid).toBe(FAB); expect((await lerC('7701')).status).toBe('EM_REVISAO');
    const ev = (await db.collection('carteira_comercial_historico').doc(r.eventoId).get()).data(); expect(ev).toMatchObject({ tipoEvento: 'CONFLITO_RESOLVIDO', ownerAnteriorUid: ADE, ownerNovoUid: ADE });
    const p = await OWN.resolverConflito(db, FieldValue, base('7701', { operadorUid: GES, versaoEsperada: 2, resolucao: 'DESCARTADO_FALSO_POSITIVO', chaveIdempotencia: 'C:ges' })); expect(p.depois.ownerUid).toBe(FAB);
  });
});
