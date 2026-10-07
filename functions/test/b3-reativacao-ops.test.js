'use strict';
// B3 — operações de reativação no EMULADOR: reserva idempotente/limite, conversão transacional, concorrência, retry, job inativo, Rules.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const R = require('../lib/reativacao120'); const OPS = require('../lib/reativacaoOps'); const JOB = require('../lib/reativacaoJob'); const { carregarContexto } = require('../lib/reativacaoContexto');
jest.setTimeout(120000);
const ADE = 'b3-ade', FAB = 'b3-fab', GES = 'b3-ges', HOJE = '2026-10-07';
const dia = n => R.somarDias(HOJE, -n); const T0 = '2026-09-26T13:59:45.769Z';
const erro = p => p.then(() => 'OK', e => e.code || e.message);
const limpar = async cols => { for (const c of cols) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const COLS = ['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'vendas_gc', 'users', 'sistema_usuarios', 'interacoes_fila', 'clientes', 'carteira_comercial_config', 'carteira_comercial_restricoes', 'audit_log'];
const v2 = (gc, owner, ex = {}) => ({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: owner === ADE ? '111' : '222', criadoEm: T0, atualizadoEm: T0, versao: 2,
  status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: null, conflito: null, ultimoEventoId: 'E', ...ex });
const venda = (id, cli, data, gcVend, ex = {}) => ({ id: String(id), cliente_id: String(cli), data, vendedor_id: String(gcVend), nome_situacao: 'Concretizada', valor_total: '100', ...ex });
const seedVendas = async vs => { for (const v of vs) { const { id, ...r } = v; await db.doc('vendas_gc/' + id).set(r); } };
let vend;
beforeAll(async () => {
  await limpar(COLS);
  for (const [uid, role, mods, cc] of [[ADE, 'funcionario', ['fila-comercial-operar'], '111'], [FAB, 'funcionario', ['fila-comercial-operar'], '222'], [GES, 'gestor', [], null]]) {
    await db.doc('users/' + uid).set({ role, ativo: true });
    await db.doc('sistema_usuarios/' + uid).set({ nome: uid, modulos: mods, admin: false, ...(cc ? { carteiraComercial: { podePossuirCarteira: true, ativoComercialmente: true, gestaoClickVendedorId: cc, pausaTemporaria: false, desligado: false }, filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } } : {}) });
  }
});
afterAll(async () => { await limpar(COLS); });
const ctx = () => carregarContexto(db, { hoje: HOJE });
beforeAll(async () => { await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' }); });       // B3.1: exclusão mútua R2×B3 — escrita de ownership só com o motor B3 autorizado

describe('B3 ops — INATIVAS por construção', () => {
  test('index.js não referencia o motor/ops/job; job tem trava FORCAR_DRY; nenhum agendador B3', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'); expect(idx).not.toMatch(/require\('\.\/lib\/(reativacaoOps|reativacao120|carteiraOwnership|carteiraV2|reativacaoReversao|devolucoes|restricoes)'\)/); expect(typeof JOB.FORCAR_DRY).toBe('boolean');   // B3.3: só job/vendas/gestão são referenciados; agendadores nascem DESLIGADOS (configuração)
       // B3.1: único acréscimo permitido = callable de gestão (sem job/agendador)
    expect(require('../lib/carteiraRegraJob').FORCAR_SOMBRA).toBe(true);
  });
  test('Rules: reservas, restrições e devoluções sem escrita do cliente; leitura só da gestão', () => {
    const r = fs.readFileSync(path.join(__dirname, '../../modulos/firestore.rules'), 'utf8');
    for (const c of ['carteira_reativacoes', 'carteira_comercial_restricoes', 'carteira_comercial_devolucoes']) expect(r).toMatch(new RegExp('match /' + c + '/\\{id\\} \\{\\s*allow read:  if isGestor\\(\\) \\|\\| temAcessoModulo\\(\'fila-comercial-gestao\'\\);\\s*allow write: if false;'));
  });
});

describe('B3 ops — reserva de reativação', () => {
  beforeAll(async () => { await db.doc('carteira_comercial/GC:10').set(v2('10', ADE)); await db.doc('carteira_comercial/GC:11').set(v2('11', ADE, { status: 'EM_REVISAO', conflito: { revisao: 'PENDENTE', relacionados: ['GC:12'], grupoId: 'CG-0123456789ab', tipos: ['DOC_IGUAL'], forca: 'FORTE', donosDiferentes: false, revisores: ['PROPRIETARIO'], detectadoEm: null, origemDeteccao: 'X' } })); });
  const p = (ex = {}) => ({ chave: R.chaveReativacao('GC:10', dia(150)), portfolioId: 'GC:10', ciclo: dia(150), tipo: 'CARTEIRA', ownerUid: ADE, destinoUid: FAB, liberadoEm: HOJE, prioridade: 0.9, agoraIso: HOJE + 'T09:00:00.000Z', ...ex });
  test('cria reserva de 7 dias; reexecução (retry) não duplica; owner da carteira intocado', async () => {
    const r1 = await OPS.liberarReserva(db, FieldValue, p()); expect(r1.repetido).toBe(false); expect(r1.doc).toMatchObject({ estado: 'RESERVADA', reservaAte: R.somarDias(HOJE, 7), destinoUid: FAB, ownerUid: ADE });
    const r2 = await OPS.liberarReserva(db, FieldValue, p()); expect(r2.repetido).toBe(true);
    expect((await db.collection('carteira_reativacoes').get()).size).toBe(1); expect((await db.doc('carteira_comercial/GC:10').get()).data().ownerUid).toBe(ADE);
  });
  test('recusa: carteira em conflito, destino = owner, cliente com carteira como SEM_CARTEIRA, cliente irmão de conflito', async () => {
    expect(await erro(OPS.liberarReserva(db, FieldValue, p({ chave: R.chaveReativacao('GC:11', dia(150)), portfolioId: 'GC:11', ownerUid: ADE })))).toBe('failed-precondition');
    expect(await erro(OPS.liberarReserva(db, FieldValue, p({ chave: R.chaveReativacao('GC:10', dia(160)), destinoUid: ADE })))).toBe('failed-precondition');
    expect(await erro(OPS.liberarReserva(db, FieldValue, p({ chave: R.chaveReativacao('GC:10', dia(170)), tipo: 'SEM_CARTEIRA', ownerUid: null })))).toBe('failed-precondition');
    expect(await erro(OPS.liberarReserva(db, FieldValue, p({ chave: R.chaveReativacao('GC:12', dia(150)), portfolioId: 'GC:12', tipo: 'SEM_CARTEIRA', ownerUid: null })))).toBe('failed-precondition');
  });
  test('limite diário (10) no servidor: a 11ª reserva do mesmo destino/dia é recusada, inclusive sob concorrência', async () => {
    await limpar(['carteira_reativacoes']); for (let i = 100; i < 112; i++) await db.doc('carteira_comercial/GC:' + i).set(v2(String(i), ADE));
    const rs = await Promise.allSettled(Array.from({ length: 12 }, (_, k) => OPS.liberarReserva(db, FieldValue, p({ chave: R.chaveReativacao('GC:' + (100 + k), dia(150)), portfolioId: 'GC:' + (100 + k) }))));
    expect((await db.collection('carteira_reativacoes').where('destinoUid', '==', FAB).get()).size).toBeLessThanOrEqual(10);
    expect(rs.filter(x => x.status === 'fulfilled').length).toBeLessThanOrEqual(10);
  });
  test('follow-up estende a janela só com data futura e motivo; nunca indefinido', async () => {
    await limpar(['carteira_reativacoes']); const pp = p(); await OPS.liberarReserva(db, FieldValue, pp);
    expect(await erro(OPS.estenderPorFollowUp(db, FieldValue, { chave: pp.chave, destinoUid: FAB, followUpAte: dia(1), motivo: 'cliente pediu retorno', hoje: HOJE }))).toBe('invalid-argument');
    expect(await erro(OPS.estenderPorFollowUp(db, FieldValue, { chave: pp.chave, destinoUid: FAB, followUpAte: R.somarDias(HOJE, 20), motivo: '', hoje: HOJE }))).toBe('invalid-argument');
    expect(await erro(OPS.estenderPorFollowUp(db, FieldValue, { chave: pp.chave, destinoUid: FAB, followUpAte: R.somarDias(HOJE, 400), motivo: 'x y z', hoje: HOJE }))).toBe('invalid-argument');
    expect(await erro(OPS.estenderPorFollowUp(db, FieldValue, { chave: pp.chave, destinoUid: ADE, followUpAte: R.somarDias(HOJE, 20), motivo: 'x y z', hoje: HOJE }))).toBe('failed-precondition');
    await OPS.estenderPorFollowUp(db, FieldValue, { chave: pp.chave, destinoUid: FAB, followUpAte: R.somarDias(HOJE, 20), motivo: 'cliente pediu retorno em 20 dias', hoje: HOJE });
    expect((await db.collection('carteira_reativacoes').get()).docs[0].data().followUpAte).toBe(R.somarDias(HOJE, 20));
  });
  test('reservas vencidas EXPIRAM sem transferir nada', async () => {
    await limpar(['carteira_reativacoes']); await OPS.liberarReserva(db, FieldValue, p({ liberadoEm: dia(20) }));
    expect(await OPS.expirarReservas(db, HOJE)).toBe(1); expect((await db.collection('carteira_reativacoes').get()).docs[0].data().estado).toBe('EXPIRADA'); expect((await db.doc('carteira_comercial/GC:10').get()).data().ownerUid).toBe(ADE);
  });
});

describe('B3 ops — venda converte a reserva e transfere (transação única)', () => {
  const chaveX = R.chaveReativacao('GC:20', dia(150));
  const prep = async () => { await limpar(['carteira_reativacoes', 'carteira_comercial_historico', 'vendas_gc', 'audit_log']); await db.doc('carteira_comercial/GC:20').set(v2('20', ADE)); await OPS.liberarReserva(db, FieldValue, { chave: chaveX, portfolioId: 'GC:20', ciclo: dia(150), tipo: 'CARTEIRA', ownerUid: ADE, destinoUid: FAB, liberadoEm: dia(2), agoraIso: T0 }); };
  const processar = async v => { const c = await ctx(); const cli = c.vendasPorCliente.get(String(v.cliente_id)); const reservas = await OPS.carregarReservasDoCliente(db, 'GC:' + v.cliente_id);
    const cart = (await db.doc('carteira_comercial/GC:' + v.cliente_id).get()).data() || null;
    const decisao = R.decidirVendaB3({ venda: { ...v }, vendasCliente: cli, carteira: cart, vend: c.vend, reservas, hoje: HOJE, conflitoGc: c.conflitosGc });
    return { decisao, res: await OPS.aplicarDecisaoVenda(db, FieldValue, { decisao, venda: v, carteira: cart, agoraIso: HOJE + 'T10:00:00.000Z' }) }; };
  test('reativação + venda válida: owner anterior → novo owner, reserva CONVERTIDA, evento v2 com venda/ciclo/versões/chave, auditoria; retry não duplica', async () => {
    await prep(); const v0 = venda(1, 20, dia(150), '111'), v1 = venda(2, 20, dia(1), '222'); await seedVendas([v0, v1]);
    const r = await processar(v1); expect(r.decisao.decisao).toBe('TRANSFERIR_REATIVACAO');
    const c = (await db.doc('carteira_comercial/GC:20').get()).data(); expect(c).toMatchObject({ ownerUid: FAB, versao: 3, origem: 'REATIVACAO_120D', cicloAncoraEm: dia(1), status: 'ATIVA' });
    const ev = (await db.collection('carteira_comercial_historico').doc(r.res.eventoId).get()).data();
    expect(ev).toMatchObject({ schemaVersion: 'historico-v2', tipoEvento: 'REATIVACAO_120D_PRIMEIRA_VENDA', ownerAnteriorUid: ADE, ownerNovoUid: FAB, motivoCodigo: 'REATIVACAO_120D', versaoCarteiraAntes: 2, versaoCarteiraDepois: 3, atorTipo: 'SYSTEM', chaveIdempotencia: 'B3:TRANSFERIR_REATIVACAO:2', referencias: { vendaGcId: '2', ciclo: dia(150), reservaChave: chaveX } });
    expect((await db.collection('carteira_reativacoes').get()).docs[0].data()).toMatchObject({ estado: 'CONVERTIDA', vendaId: '2' });
    expect((await db.collection('audit_log').where('entityId', '==', 'GC:20').where('action', '==', 'PORTFOLIO_REATIVACAO_120D_PRIMEIRA_VENDA').get()).size).toBe(1);   // + 1 evento REACTIVATION_RESERVED (B3.1)
    const again = await OPS.aplicarDecisaoVenda(db, FieldValue, { decisao: r.decisao, venda: v1, carteira: (await db.doc('carteira_comercial/GC:20').get()).data().versao === 3 ? { ...c, versao: 2 } : c, agoraIso: HOJE + 'T10:00:00.000Z' });
    expect(again.repetido).toBe(true); expect((await db.collection('carteira_comercial_historico').get()).size).toBe(1);
  });
  test('duas vendas "concorrentes" (Fabiana na reativação e Ademir): só UMA decisão de transferência; sem dois owners', async () => {
    await prep(); const v0 = venda(1, 20, dia(150), '111'), a = venda(2, 20, dia(1), '222'), b = venda(3, 20, dia(1), '111'); await seedVendas([v0, a, b]);
    const rs = await Promise.allSettled([processar(a), processar(b)]);
    const c = (await db.doc('carteira_comercial/GC:20').get()).data(); expect([ADE, FAB]).toContain(c.ownerUid);
    const trocas = (await db.collection('carteira_comercial_historico').where('tipoEvento', '==', 'REATIVACAO_120D_PRIMEIRA_VENDA').get()).size; expect(trocas).toBeLessThanOrEqual(1);
    expect(rs.some(x => x.status === 'fulfilled')).toBe(true);
  });
  test('cobertura (<120d): renova o ciclo do owner original; owner não muda; evento RENOVACAO_CICLO', async () => {
    await limpar(['carteira_reativacoes', 'carteira_comercial_historico', 'vendas_gc']); await db.doc('carteira_comercial/GC:30').set(v2('30', ADE)); const v0 = venda(1, 30, dia(60), '111'), v1 = venda(2, 30, dia(2), '222'); await seedVendas([v0, v1]);
    const r = await processar(v1); expect(r.decisao).toMatchObject({ decisao: 'COBERTURA_RENOVA_OWNER', creditoUid: FAB });
    expect((await db.doc('carteira_comercial/GC:30').get()).data()).toMatchObject({ ownerUid: ADE, cicloAncoraEm: dia(2), versao: 3 });
    expect((await db.collection('carteira_comercial_historico').get()).docs[0].data()).toMatchObject({ tipoEvento: 'RENOVACAO_CICLO', ownerAnteriorUid: ADE, ownerNovoUid: ADE });
  });
  test('sem carteira: reserva + primeira venda do vendedor cria carteira para QUEM vendeu e converte a reserva', async () => {
    await limpar(['carteira_reativacoes', 'carteira_comercial_historico', 'vendas_gc']); const v0 = venda(1, 40, dia(200), '999'), v1 = venda(2, 40, dia(1), '222'); await seedVendas([v0, v1]);
    const ch = R.chaveReativacao('GC:40', dia(200)); await OPS.liberarReserva(db, FieldValue, { chave: ch, portfolioId: 'GC:40', ciclo: dia(200), tipo: 'SEM_CARTEIRA', ownerUid: null, destinoUid: FAB, liberadoEm: dia(2), agoraIso: T0 });
    expect((await db.doc('carteira_comercial/GC:40').get()).exists).toBe(false);                                 // reserva NÃO cria owner
    const r = await processar(v1); expect(r.decisao.decisao).toBe('CRIAR_VIA_REATIVACAO');
    expect((await db.doc('carteira_comercial/GC:40').get()).data()).toMatchObject({ ownerUid: FAB, origem: 'REATIVACAO_120D', versao: 1 });
    expect((await db.collection('carteira_reativacoes').get()).docs[0].data().estado).toBe('CONVERTIDA');
  });
  test('venda sem oportunidade ou da gestão: nada é escrito', async () => {
    await limpar(['carteira_reativacoes', 'carteira_comercial_historico', 'vendas_gc']); await db.doc('carteira_comercial/GC:50').set(v2('50', ADE)); const v0 = venda(1, 50, dia(150), '111'), v1 = venda(2, 50, dia(1), '222'), v2_ = venda(3, 50, dia(1), '999'); await seedVendas([v0, v1, v2_]);
    for (const v of [v1, v2_]) { const r = await processar(v); expect(r.res.ignorado).toBeTruthy(); }
    expect((await db.doc('carteira_comercial/GC:50').get()).data()).toMatchObject({ ownerUid: ADE, versao: 2 }); expect((await db.collection('carteira_comercial_historico').get()).size).toBe(0);
  });
});

describe('B3 job — preparado e inativo', () => {
  beforeAll(async () => { await limpar(['carteira_reativacoes', 'carteira_comercial_historico', 'vendas_gc', 'carteira_comercial']); await db.doc('carteira_comercial_config/reativacao').delete(); await db.doc('carteira_comercial/GC:60').set(v2('60', ADE)); await seedVendas([venda(1, 60, dia(150), '111')]); });
  test('DESLIGADO por padrão (sem config) → nada acontece', async () => { expect((await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE })).status).toBe('DESLIGADO'); });
  test('modo DRY ou ATIVO com a trava FORCAR_DRY: calcula o plano e NÃO escreve', async () => {
    for (const modo of ['DRY', 'ATIVO']) { await db.doc('carteira_comercial_config/reativacao').set({ modo }); const r = await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE, forcarDry: true }); expect(r.status).toBe('DRY'); expect(r.plano.liberar).toHaveLength(1); expect((await db.collection('carteira_reativacoes').get()).size).toBe(0); }
  });
  test('só com a trava removida (forcarDry=false) e modo ATIVO grava — idempotente no retry (ensaio em emulador)', async () => {
    await db.doc('carteira_comercial_config/reativacao').set({ modo: 'ATIVO' });
    const a = await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE, forcarDry: false, lookupNome: async gc => 'Cliente ' + gc, agoraIso: HOJE + 'T06:00:00.000Z' }); expect(a).toMatchObject({ status: 'ATIVO', criadas: 1 });
    const b = await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE, forcarDry: false, lookupNome: async gc => 'Cliente ' + gc, agoraIso: HOJE + 'T06:00:01.000Z' }); expect(b).toMatchObject({ criadas: 0 });
    expect((await db.collection('carteira_reativacoes').get()).size).toBe(1); expect((await db.doc('carteira_comercial/GC:60').get()).data().ownerUid).toBe(ADE);
  });
});
