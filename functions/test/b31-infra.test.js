'use strict';
// B3.1 — infraestrutura operacional da reativação (EMULADOR). Nada disto é acionado automaticamente em produção.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const R = require('../lib/reativacao120'); const OPS = require('../lib/reativacaoOps'); const REV = require('../lib/reativacaoReversao'); const RESTR = require('../lib/restricoes'); const DEV = require('../lib/devolucoes');
const CONF = require('../lib/conflitosRegistro'); const MOTOR = require('../lib/motorCarteira'); const { carregarContexto } = require('../lib/reativacaoContexto');
const Q = require('../lib/crmConsulta'); const CAN = require('../lib/canaryCallable'); const G = require('../lib/reativacaoGestaoCallable'); const OWN = require('../lib/carteiraOwnership');
jest.setTimeout(180000);
const ADE = 'b31-ade', FAB = 'b31-fab', CAM = 'b31-cam', GES = 'b31-ges', VEND = 'b31-vend';
const HOJE = '2026-10-07', dia = n => R.somarDias(HOJE, -n); const T0 = '2026-09-26T13:59:45.769Z';
const at = d => ({ now: () => new Date(d + 'T13:00:00.000Z') });                                  // 10:00 em Fortaleza
const erro = p => p.then(() => 'OK', e => e.code || e.message);
const COLS = ['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_comercial_restricoes', 'carteira_comercial_restricoes_hist', 'carteira_comercial_devolucoes', 'carteira_comercial_revisoes', 'identidade_conflitos',
  'vendas_gc', 'users', 'sistema_usuarios', 'interacoes_fila', 'clientes', 'carteira_comercial_config', 'audit_log', 'crm_notas_privadas', 'fila_comercial'];
const limpar = async cols => { for (const c of cols) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const v2 = (gc, owner, ex = {}) => ({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: owner === ADE ? '111' : '222', criadoEm: T0, atualizadoEm: T0, versao: 2,
  status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: null, conflito: null, ultimoEventoId: 'E', ...ex });
const venda = (id, cli, data, gcVend, ex = {}) => ({ id: String(id), cliente_id: String(cli), data, vendedor_id: String(gcVend), nome_situacao: 'Concretizada', valor_total: '100', ...ex });
const seedV = async vs => { for (const v of vs) { const { id, ...r } = v; await db.doc('vendas_gc/' + id).set(r); } };
const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
const rid = n => 'req-b31-' + n + '-' + Math.random().toString(36).slice(2, 8);
const reservar = (gc, destino, owner, liberadoEm, ex = {}) => OPS.liberarReserva(db, FieldValue, { chave: R.chaveReativacao('GC:' + gc, ex.ciclo || dia(150)), portfolioId: 'GC:' + gc, ciclo: ex.ciclo || dia(150), tipo: owner ? 'CARTEIRA' : 'SEM_CARTEIRA', ownerUid: owner || null, destinoUid: destino, liberadoEm, nomeCliente: 'Cliente ' + gc, agoraIso: liberadoEm + 'T09:00:00.000Z' });
const opp = (gc, ciclo) => OPS.idOportunidade(R.chaveReativacao('GC:' + gc, ciclo || dia(150)));

beforeAll(async () => {
  await limpar(COLS);
  for (const [uid, role, mods, cc] of [[ADE, 'funcionario', ['fila-comercial-operar'], '111'], [FAB, 'funcionario', ['fila-comercial-operar'], '222'], [CAM, 'funcionario', ['fila-comercial-gestao'], null], [GES, 'gestor', [], null], [VEND, 'funcionario', ['clientes'], null]]) {
    await db.doc('users/' + uid).set({ role, ativo: true });
    await db.doc('sistema_usuarios/' + uid).set({ nome: uid, modulos: mods, admin: false, ...(cc ? { carteiraComercial: { podePossuirCarteira: true, ativoComercialmente: true, gestaoClickVendedorId: cc, pausaTemporaria: false, desligado: false }, filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } } : {}) });
  }
  await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' });
});
afterAll(async () => { await limpar(COLS); });
const limparDados = () => limpar(['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_comercial_restricoes', 'carteira_comercial_restricoes_hist', 'carteira_comercial_devolucoes', 'carteira_comercial_revisoes', 'identidade_conflitos', 'vendas_gc', 'interacoes_fila', 'audit_log', 'crm_notas_privadas']);

describe('B3.1 — reservas visíveis só para o vendedor reservado (worklist/CRM) [1,2]', () => {
  beforeAll(async () => { await limparDados(); await db.doc('carteira_comercial/GC:101').set(v2('101', FAB)); await db.doc('carteira_comercial/GC:102').set(v2('102', ADE)); await seedV([venda(1, 101, dia(150), '222'), venda(2, 102, dia(150), '111')]);
    await reservar(101, ADE, FAB, HOJE); await reservar(102, FAB, ADE, HOJE); });
  test('Ademir só vê a reserva dele (cliente da carteira da Fabiana); Fabiana só a dela', async () => {
    const a = await Q.crmConsultaHandler(req(ADE, { acao: 'fila' }), { db }), f = await Q.crmConsultaHandler(req(FAB, { acao: 'fila' }), { db });
    expect(a.escopo).toBe('VENDEDOR'); expect(a.reativacoes.map(x => x.commercialEntityId)).toEqual(['GC_NATIVE:101']); expect(f.reativacoes.map(x => x.commercialEntityId)).toEqual(['GC_NATIVE:102']);
    expect(a.reativacoes[0]).toMatchObject({ tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente 101', reativacao: { semCarteira: false, estado: 'RESERVADA', bloqueadoContato: false } });
    expect(a.reativacoes[0].contextoComercial.historico).toMatchObject({ ultimaCompraEm: dia(150), diasSemComprar: 150, pedidosTotal: 1 });
    expect(JSON.stringify(a)).not.toContain('GC_NATIVE:102'); expect(JSON.stringify(f)).not.toContain('GC_NATIVE:101');
  });
  test('gestão vê todas; sem módulo e anônimo são recusados; vendedor só abre o cliente da própria reserva', async () => {
    const g = await Q.crmConsultaHandler(req(GES, { acao: 'fila' }), { db }); expect(g.reativacoes).toHaveLength(2);
    expect(await erro(Q.crmConsultaHandler(req(VEND, { acao: 'fila' }), { db }))).toBe('permission-denied'); expect(await erro(Q.crmConsultaHandler(req(null, { acao: 'fila' }), { db }))).toBe('unauthenticated');
    expect((await Q.crmConsultaHandler(req(ADE, { acao: 'cliente', entidade: 'GC_NATIVE:101' }), { db })).entidade || true).toBeTruthy();
    expect(await erro(Q.crmConsultaHandler(req(ADE, { acao: 'cliente', entidade: 'GC_NATIVE:999' }), { db }))).toBe('permission-denied');          // fora do escopo (nem reserva, nem carteira)
    expect(await erro(Q.crmConsultaHandler(req(FAB, { acao: 'cliente', entidade: 'GC_NATIVE:101' }), { db }))).toBe('OK');                  // Fabiana é DONA da carteira 101 (o cliente da reserva do Ademir)
  });
});

describe('B3.1 — claim/resultado na reserva; sem carteira; follow-up; sem interesse [4,8,9,10,11]', () => {
  beforeEach(async () => { await limparDados(); await seedV([venda(1, 30, dia(200), '999')]); });
  test('claim: só o vendedor reservado; Fabiana é recusada; carteira inexistente CONTINUA inexistente durante a reserva', async () => {
    await reservar(30, ADE, null, HOJE, { ciclo: dia(200) }); const o = opp(30, dia(200));
    expect(await erro(CAN.claimOpportunityHandler(req(FAB, { opportunityInstanceId: o }), at(HOJE)))).toBe('permission-denied');
    const r = await CAN.claimOpportunityHandler(req(ADE, { opportunityInstanceId: o }), at(HOJE)); expect(r.estado).toBe('EM_ATENDIMENTO');
    expect((await db.doc('carteira_comercial/GC:30').get()).exists).toBe(false);                                              // reserva ≠ ownership
    expect((await db.doc('interacoes_fila/' + o).get()).data()).toMatchObject({ tipoOportunidade: 'REATIVACAO_120D', commercialEntityId: 'GC_NATIVE:30' });
  });
  test('reserva vencida ou ainda não aberta não permite claim', async () => {
    await reservar(30, ADE, null, dia(20), { ciclo: dia(200) }); const o = opp(30, dia(200));
    expect(await erro(CAN.claimOpportunityHandler(req(ADE, { opportunityInstanceId: o }), at(HOJE)))).toBe('failed-precondition');
  });
  test('follow-up válido (data futura + motivo) estende a reserva e mantém o fluxo além de 7 dias', async () => {
    await reservar(30, ADE, null, HOJE, { ciclo: dia(200) }); const o = opp(30, dia(200)); await CAN.claimOpportunityHandler(req(ADE, { opportunityInstanceId: o }), at(HOJE));
    const ate = R.somarDias(HOJE, 20);
    const r = await CAN.registerOutcomeHandler(req(ADE, { opportunityInstanceId: o, outcome: 'PEDIU_RETORNO', scheduledFor: ate, nota: 'cliente pediu retorno após feriado' }), at(HOJE)); expect(r.nextFollowUpAt).toBe(ate);
    const rv = (await db.collection('carteira_reativacoes').get()).docs[0].data(); expect(rv).toMatchObject({ followUpAte: ate, estado: 'RESERVADA' });
    const depois = R.somarDias(HOJE, 12);                                                                                       // além dos 7 dias: continua válido
    expect(R.reservaValida(rv, ADE, depois)).toBe(true);
    const aud = (await db.collection('audit_log').where('action', '==', 'REACTIVATION_FOLLOWUP_EXTENDED').get()).docs.map(d => d.data()); expect(aud).toHaveLength(1); expect(aud[0]).toMatchObject({ actorUid: ADE, category: 'COMMERCIAL' });
  });
  test('follow-up INVÁLIDO é rejeitado: sem motivo, motivo curto, data passada/hoje; nada é gravado na reserva', async () => {
    await reservar(30, ADE, null, HOJE, { ciclo: dia(200) }); const o = opp(30, dia(200)); await CAN.claimOpportunityHandler(req(ADE, { opportunityInstanceId: o }), at(HOJE));
    for (const x of [{ scheduledFor: R.somarDias(HOJE, 20) }, { scheduledFor: R.somarDias(HOJE, 20), nota: 'ok' }, { scheduledFor: HOJE, nota: 'motivo suficiente' }, { scheduledFor: dia(3), nota: 'motivo suficiente' }])
      expect(await erro(CAN.registerOutcomeHandler(req(ADE, { opportunityInstanceId: o, outcome: 'PEDIU_RETORNO', ...x }), at(HOJE)))).toBe('invalid-argument');
    expect((await db.collection('carteira_reativacoes').get()).docs[0].data().followUpAte).toBeNull();
    expect((await db.doc('interacoes_fila/' + o).get()).data().estado).toBe('EM_ATENDIMENTO');
  });
  test('Sem interesse: encerra a reserva, cooldown de 30 dias, bloqueia nova oportunidade; após 30 dias volta a ser elegível', async () => {
    await db.doc('carteira_comercial/GC:31').set(v2('31', FAB)); await seedV([venda(2, 31, dia(150), '222')]); await reservar(31, ADE, FAB, HOJE); const o = opp(31); await CAN.claimOpportunityHandler(req(ADE, { opportunityInstanceId: o }), at(HOJE));
    const r = await CAN.registerOutcomeHandler(req(ADE, { opportunityInstanceId: o, outcome: 'SEM_INTERESSE_AGORA' }), at(HOJE)); expect(r.cooledUntil).toBeTruthy();
    const dias = Math.round((Date.parse(r.cooledUntil) - Date.parse(HOJE + 'T13:00:00Z')) / 86400000); expect(dias).toBe(30);
    expect((await db.collection('carteira_reativacoes').get()).docs.find(d => d.data().portfolioId === 'GC:31').data()).toMatchObject({ estado: 'ENCERRADA', motivoEncerramento: 'SEM_INTERESSE' });
    const ctx = hoje => carregarContexto(db, { hoje }).then(c => R.planejarLiberacao({ hoje, carteiras: c.carteiras, semCarteira: c.semCarteira, vendasPorCliente: c.vendasPorCliente, vend: c.vend, conflitosGc: c.conflitosGc, naoContatar: c.naoContatar, cooldowns: c.cooldowns, followUps: c.followUps, devolucoes: c.devolucoes, reservasExistentes: new Map() }));
    const p1 = await ctx(R.somarDias(HOJE, 5)); expect(p1.bloqueados.COOLDOWN).toContain('31'); expect(p1.liberar.find(x => x.id === '31')).toBeUndefined();
    const p2 = await ctx(R.somarDias(HOJE, 31)); expect(p2.bloqueados.COOLDOWN).not.toContain('31'); expect(p2.liberar.find(x => x.id === '31')).toBeTruthy();
    expect((await db.collection('audit_log').where('action', '==', 'REACTIVATION_CLOSED_NO_INTEREST').get()).size).toBe(1);
  });
});

describe('B3.1 — NÃO CONTATAR [12,13]', () => {
  beforeEach(async () => { await limparDados(); await db.doc('carteira_comercial/GC:40').set(v2('40', FAB)); await seedV([venda(1, 40, dia(150), '222')]); });
  const marcar = (uid, ex = {}) => G.reativacaoGestaoHandler(req(uid, { acao: 'naoContatar', portfolioId: 'GC:40', naoContatar: true, motivoCodigo: 'PEDIDO_DO_CLIENTE', motivo: 'cliente pediu para não ser contatado', requestId: rid('nc'), ...ex }), { db });
  test('só gestão marca/desmarca (proprietário e Camila sem admin); vendedor, sem módulo e anônimo não', async () => {
    for (const u of [ADE, FAB, VEND]) expect(await erro(marcar(u))).toBe('permission-denied');
    expect(await erro(G.reativacaoGestaoHandler(req(null, { acao: 'naoContatar' }), { db }))).toBe('unauthenticated');
    expect((await marcar(CAM)).naoContatar).toBe(true); expect((await db.doc('carteira_comercial_restricoes/GC:40').get()).data()).toMatchObject({ naoContatar: true, atualizadoPorUid: CAM, atualizadoPorPapel: 'CAMILA', versao: 1 });
    const r = await G.reativacaoGestaoHandler(req(GES, { acao: 'naoContatar', portfolioId: 'GC:40', naoContatar: false, motivoCodigo: 'DECISAO_COMERCIAL', motivo: 'liberado pela gestão', requestId: rid('nc2') }), { db }); expect(r.naoContatar).toBe(false);
  });
  test('identidade/payload: ator NÃO vem do payload; campos extras e motivo vazio são recusados; retry com o mesmo requestId não duplica', async () => {
    expect(await erro(marcar(GES, { operadorUid: ADE }))).toBe('invalid-argument'); expect(await erro(marcar(GES, { motivo: '' }))).toBe('invalid-argument'); expect(await erro(marcar(GES, { motivoCodigo: 'QUALQUER' }))).toBe('invalid-argument');
    const id = rid('same'); await marcar(GES, { requestId: id }); const again = await marcar(GES, { requestId: id }); expect(again.repetido).toBe(true);
    expect((await db.collection('carteira_comercial_restricoes_hist').get()).size).toBe(1); expect((await db.doc('carteira_comercial_restricoes/GC:40').get()).data().versao).toBe(1);
    expect(await erro(marcar(GES))).toBe('failed-precondition');                                                                   // já está marcado
    const aud = (await db.collection('audit_log').where('action', '==', 'DO_NOT_CONTACT_SET').get()).docs.map(d => d.data()); expect(aud).toHaveLength(1); expect(aud[0].actorUid).toBe(GES);
  });
  test('bloqueia a automação (planejamento, reserva e claim); prevalece sobre cooldown; retorno espontâneo não é tocado', async () => {
    await marcar(GES); const c = await carregarContexto(db, { hoje: HOJE });
    const p = R.planejarLiberacao({ hoje: HOJE, carteiras: c.carteiras, vend: c.vend, vendasPorCliente: c.vendasPorCliente, naoContatar: c.naoContatar, cooldowns: new Map([['40', R.somarDias(HOJE, 3)]]) });
    expect(p.bloqueados.NAO_CONTATAR).toEqual(['40']); expect(p.bloqueados.COOLDOWN).toEqual([]);
    expect(await erro(reservar(40, ADE, FAB, HOJE))).toBe('failed-precondition');
    await db.doc('carteira_comercial_restricoes/GC:40').delete(); await reservar(40, ADE, FAB, HOJE);                               // reserva criada antes da marcação…
    await marcar(GES); expect(await erro(CAN.claimOpportunityHandler(req(ADE, { opportunityInstanceId: opp(40) }), at(HOJE)))).toBe('failed-precondition');   // …não pode ser iniciada
    const f = await Q.crmConsultaHandler(req(ADE, { acao: 'fila' }), { db }); expect(f.reativacoes[0].reativacao.bloqueadoContato).toBe(true);   // vendedor VÊ o bloqueio
  });
  test('vendedor não remove nem altera a restrição pelo SDK (Rules)', () => {
    const r = require('fs').readFileSync(require('path').join(__dirname, '../../modulos/firestore.rules'), 'utf8');
    expect(r).toMatch(/match \/carteira_comercial_restricoes\/\{id\} \{\s*allow read:  if isGestor\(\) \|\| temAcessoModulo\('fila-comercial-gestao'\);\s*allow write: if false;/);
  });
});

describe('B3.1 — devoluções [14,15]', () => {
  beforeEach(async () => { await limparDados(); await db.doc('carteira_comercial/GC:50').set(v2('50', ADE)); await seedV([venda(1, 50, dia(150), '111'), venda(2, 50, dia(5), '111')]); });
  const dev = (uid, ex = {}) => G.reativacaoGestaoHandler(req(uid, { acao: 'devolucao', vendaId: '2', tipo: 'TOTAL', dataDevolucao: dia(1), motivo: 'devolução integral', requestId: rid('dv'), ...ex }), { db });
  test('registro exige gestão, venda existente e válida; sem fonte textual; retry não duplica; TOTAL único por venda', async () => {
    expect(await erro(dev(ADE))).toBe('permission-denied'); expect(await erro(dev(GES, { vendaId: '999' }))).toBe('not-found'); expect(await erro(dev(GES, { tipo: 'X' }))).toBe('invalid-argument'); expect(await erro(dev(GES, { dataDevolucao: dia(10) }))).toBe('invalid-argument');
    const id = rid('d1'); const a = await dev(CAM, { requestId: id }); expect(a).toMatchObject({ ok: true, reversaoPodeSerNecessaria: true }); const b = await dev(CAM, { requestId: id }); expect(b.repetido).toBe(true);
    expect((await db.collection('carteira_comercial_devolucoes').get()).size).toBe(1); expect(await erro(dev(GES))).toBe('already-exists');
    const doc = (await db.collection('carteira_comercial_devolucoes').get()).docs[0].data(); expect(doc).toMatchObject({ vendaId: '2', portfolioId: 'GC:50', tipo: 'TOTAL', registradoPorUid: CAM }); expect(JSON.stringify(doc)).not.toMatch(/nome|telefone|cpf|valor/i);
    expect((await db.collection('audit_log').where('action', '==', 'RETURN_REGISTERED').get()).size).toBe(1);
  });
  test('PARCIAL mantém a renovação; TOTAL invalida (ciclo volta a ser o da compra anterior)', async () => {
    await dev(GES, { tipo: 'PARCIAL' }); let c = await carregarContexto(db, { hoje: HOJE }); expect(c.devolucoes.get('2')).toBe('PARCIAL');
    const vs = c.vendasPorCliente.get('50'); expect(R.cicloDoCliente({ vendasCliente: vs, carteira: c.carteiras.get('GC:50'), vend: c.vend, hoje: HOJE, devolucoes: c.devolucoes })).toMatchObject({ dias: 5, aberta: false });
    await dev(GES, { tipo: 'TOTAL', dataDevolucao: dia(1) }); c = await carregarContexto(db, { hoje: HOJE }); expect(c.devolucoes.get('2')).toBe('TOTAL');       // TOTAL prevalece sobre PARCIAL
    expect(R.cicloDoCliente({ vendasCliente: vs, carteira: c.carteiras.get('GC:50'), vend: c.vend, hoje: HOJE, devolucoes: c.devolucoes })).toMatchObject({ dias: 150, aberta: true });
  });
});

describe('B3.1 — transferência e REVERSÃO [16,17,18]', () => {
  const chave = R.chaveReativacao('GC:60', dia(150));
  const preparar = async () => {
    await limparDados(); await db.doc('carteira_comercial/GC:60').set(v2('60', ADE, { cicloAncoraEm: '2026-05-01' })); await seedV([venda(1, 60, dia(150), '111'), venda(2, 60, dia(1), '222')]); await reservar(60, FAB, ADE, dia(2));
    const c = await carregarContexto(db, { hoje: HOJE }); const v = { id: '2', ...(await db.doc('vendas_gc/2').get()).data() }; const cart = (await db.doc('carteira_comercial/GC:60').get()).data();
    const decisao = R.decidirVendaB3({ venda: v, vendasCliente: c.vendasPorCliente.get('60'), carteira: cart, vend: c.vend, reservas: await OPS.carregarReservasDoCliente(db, 'GC:60'), hoje: HOJE });
    expect(decisao.decisao).toBe('TRANSFERIR_REATIVACAO'); return OPS.aplicarDecisaoVenda(db, FieldValue, { decisao, venda: v, carteira: cart, agoraIso: HOJE + 'T10:00:00.000Z' });
  };
  test('exclusão mútua: sem o motor B3 autorizado NADA muda de owner (motor NENHUM ou R2)', async () => {
    for (const m of ['NENHUM', 'R2']) {
      await limparDados(); await db.doc('carteira_comercial_config/motor').set({ motorAtivo: m }); await db.doc('carteira_comercial/GC:60').set(v2('60', ADE)); await seedV([venda(1, 60, dia(150), '111'), venda(2, 60, dia(1), '222')]); await reservar(60, FAB, ADE, dia(2));
      const c = await carregarContexto(db, { hoje: HOJE }); const v = { id: '2', ...(await db.doc('vendas_gc/2').get()).data() }; const cart = (await db.doc('carteira_comercial/GC:60').get()).data();
      const decisao = R.decidirVendaB3({ venda: v, vendasCliente: c.vendasPorCliente.get('60'), carteira: cart, vend: c.vend, reservas: await OPS.carregarReservasDoCliente(db, 'GC:60'), hoje: HOJE });
      expect(await erro(OPS.aplicarDecisaoVenda(db, FieldValue, { decisao, venda: v, carteira: cart, agoraIso: HOJE + 'T10:00:00.000Z' }))).toBe('failed-precondition');
      expect((await db.doc('carteira_comercial/GC:60').get()).data().ownerUid).toBe(ADE);
    }
    expect(MOTOR.lerMotor(undefined)).toBe('NENHUM'); expect(MOTOR.podeEscreverOwnership('R2', 'B3')).toBe(false); expect(MOTOR.podeEscreverOwnership('B3', 'R2')).toBe(false);
    await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' });
  });
  test('cancelamento posterior → REVERSÃO: owner anterior restaurado, histórico preservado, novo evento, versão, idempotente, auditável', async () => {
    const t = await preparar(); expect((await db.doc('carteira_comercial/GC:60').get()).data()).toMatchObject({ ownerUid: FAB, versao: 3 });
    expect((await REV.avaliarReversao(db, { portfolioId: 'GC:60', vendaId: '2', hoje: HOJE })).decisao).toBe('NAO_NECESSARIA');          // venda ainda válida
    await db.doc('vendas_gc/2').update({ nome_situacao: 'Cancelada' });
    const r = await G.reativacaoGestaoHandler(req(GES, { acao: 'reversao', portfolioId: 'GC:60', vendaId: '2', requestId: rid('rv') }), { db }); expect(r.status).toBe('REVERTIDA');
    const c = (await db.doc('carteira_comercial/GC:60').get()).data(); expect(c).toMatchObject({ ownerUid: ADE, ownerDesde: T0, cicloAncoraEm: '2026-05-01', origem: 'MIGRACAO_ONDA1_N3526', status: 'ATIVA', versao: 4 });
    const evs = (await db.collection('carteira_comercial_historico').get()).docs.map(d => d.data()); expect(evs.map(e => e.tipoEvento).sort()).toEqual(['REATIVACAO_120D_PRIMEIRA_VENDA', 'REVERSAO_TRANSFERENCIA']);   // a transferência original NÃO foi apagada
    expect(evs.find(e => e.tipoEvento === 'REVERSAO_TRANSFERENCIA')).toMatchObject({ ownerAnteriorUid: FAB, ownerNovoUid: ADE, versaoCarteiraAntes: 3, versaoCarteiraDepois: 4, referencias: { vendaGcId: '2' }, atorTipo: 'USER' });
    expect((await REV.executarReversao(db, FieldValue, { portfolioId: 'GC:60', vendaId: '2', operadorUid: GES })).status).toMatch(/JA_REVERTIDA|NAO_NECESSARIA|REVISAO_DA_GESTAO/);   // retry nunca duplica
    expect((await db.collection('carteira_comercial_historico').get()).size).toBe(2); expect((await db.collection('audit_log').where('action', '==', 'PORTFOLIO_REVERSAO_TRANSFERENCIA').get()).size).toBe(1);
  });
  test('devolução TOTAL registrada também dispara a reversão; vendedor não pode executá-la', async () => {
    await preparar(); expect(await erro(G.reativacaoGestaoHandler(req(ADE, { acao: 'reversao', portfolioId: 'GC:60', vendaId: '2', requestId: rid('rv') }), { db }))).toBe('permission-denied');
    const d = await G.reativacaoGestaoHandler(req(CAM, { acao: 'devolucao', vendaId: '2', tipo: 'TOTAL', dataDevolucao: dia(0), motivo: 'devolvida integralmente', requestId: rid('dv') }), { db }); expect(d.reversaoPodeSerNecessaria).toBe(true);
    expect((await G.reativacaoGestaoHandler(req(CAM, { acao: 'reversao', portfolioId: 'GC:60', vendaId: '2', requestId: rid('rv') }), { db })).status).toBe('REVERTIDA'); expect((await db.doc('carteira_comercial/GC:60').get()).data().ownerUid).toBe(ADE);
  });
  test('reversão AMBÍGUA não decide: evento posterior / novo owner vendeu depois ⇒ revisão da gestão, owner e histórico intactos', async () => {
    await preparar(); await db.doc('vendas_gc/2').update({ nome_situacao: 'Cancelada' }); await seedV([venda(3, 60, dia(0), '222')]);                 // nova venda válida da nova owner (Fabiana) depois
    const r = await G.reativacaoGestaoHandler(req(GES, { acao: 'reversao', portfolioId: 'GC:60', vendaId: '2', requestId: rid('rv') }), { db });
    expect(r.status).toBe('REVISAO_DA_GESTAO'); expect(r.motivos).toContain('NOVO_OWNER_VENDEU_DEPOIS'); expect((await db.doc('carteira_comercial/GC:60').get()).data()).toMatchObject({ ownerUid: FAB, versao: 3 });
    expect((await db.collection('carteira_comercial_revisoes').get()).docs[0].data()).toMatchObject({ tipo: 'REVERSAO_AMBIGUA', estado: 'PENDENTE', vendaId: '2' }); expect((await db.collection('carteira_comercial_historico').get()).size).toBe(1);
    await G.reativacaoGestaoHandler(req(GES, { acao: 'reversao', portfolioId: 'GC:60', vendaId: '2', requestId: rid('rv2') }), { db }); expect((await db.collection('carteira_comercial_revisoes').get()).size).toBe(1);      // revisão idempotente
    await limparDados(); await preparar(); await db.doc('vendas_gc/2').update({ nome_situacao: 'Cancelada' });
    const cur = (await db.doc('carteira_comercial/GC:60').get()).data(); await db.doc('carteira_comercial/GC:60').update({ ultimoEventoId: 'OUTRO_EVENTO', versao: cur.versao + 1 });          // algo aconteceu depois
    expect((await REV.avaliarReversao(db, { portfolioId: 'GC:60', vendaId: '2', hoje: HOJE })).motivos).toContain('EVENTO_POSTERIOR_NA_CARTEIRA');
  });
  test('criação por reativação (sem carteira) também é reversível: volta a SEM owner (LIBERADA), histórico preservado', async () => {
    await limparDados(); await seedV([venda(1, 61, dia(200), '999'), venda(2, 61, dia(1), '222')]); await reservar(61, FAB, null, dia(2), { ciclo: dia(200) });
    const c = await carregarContexto(db, { hoje: HOJE }); const v = { id: '2', ...(await db.doc('vendas_gc/2').get()).data() };
    const decisao = R.decidirVendaB3({ venda: v, vendasCliente: c.vendasPorCliente.get('61'), carteira: null, vend: c.vend, reservas: await OPS.carregarReservasDoCliente(db, 'GC:61'), hoje: HOJE }); expect(decisao.decisao).toBe('CRIAR_VIA_REATIVACAO');
    await OPS.aplicarDecisaoVenda(db, FieldValue, { decisao, venda: v, carteira: null, agoraIso: HOJE + 'T10:00:00.000Z' }); expect((await db.doc('carteira_comercial/GC:61').get()).data().ownerUid).toBe(FAB);
    await db.doc('vendas_gc/2').update({ nome_situacao: 'Cancelada' }); expect((await REV.executarReversao(db, FieldValue, { portfolioId: 'GC:61', vendaId: '2', operadorUid: GES })).status).toBe('REVERTIDA');
    expect((await db.doc('carteira_comercial/GC:61').get()).data()).toMatchObject({ ownerUid: null, status: 'LIBERADA' }); expect((await db.collection('carteira_comercial_historico').get()).size).toBe(2);
  });
});

describe('B3.1 — registro persistente de conflitos [19]', () => {
  beforeEach(limparDados);
  test('grupos persistem sem PII, criação idempotente, não resolve/mescla; bloqueia reserva e planejamento mesmo sem carteira', async () => {
    const grupos = [{ grupoId: 'CG-aaaaaaaaaaaa', ids: ['70', '71'], tipos: ['DOC_IGUAL'], forca: 'FORTE', comCarteira: [], semCarteira: ['70', '71'], donosDiferentes: false }];
    const r1 = await CONF.registrarGrupos(db, FieldValue, grupos, { agoraIso: HOJE + 'T00:00:00Z', executar: true }); expect(r1.novos).toHaveLength(1);
    const r2 = await CONF.registrarGrupos(db, FieldValue, grupos, { agoraIso: HOJE + 'T00:00:00Z', executar: true }); expect(r2.novos).toHaveLength(0); expect(r2.existentes).toEqual(['CG-aaaaaaaaaaaa']);
    const doc = (await db.doc('identidade_conflitos/CG-aaaaaaaaaaaa').get()).data(); expect(doc).toMatchObject({ status: 'PENDENTE', membros: ['GC:70', 'GC:71'], versao: 1 }); expect(JSON.stringify(doc)).not.toMatch(/nome|cpf|telefone|email/i);
    expect(await erro(reservar(70, ADE, null, HOJE, { ciclo: dia(200) }))).toBe('failed-precondition'); expect((await CONF.membrosBloqueados(db)).has('71')).toBe(true);
    await seedV([venda(1, 70, dia(200), '111'), venda(2, 72, dia(200), '111')]); const c = await carregarContexto(db, { hoje: HOJE });
    const p = R.planejarLiberacao({ hoje: HOJE, carteiras: c.carteiras, semCarteira: c.semCarteira, vendasPorCliente: c.vendasPorCliente, vend: c.vend, conflitosGc: c.conflitosGc, incluirSemCarteira: true });
    expect(p.bloqueados.CONFLITO).toEqual(['70']); expect(p.liberar.map(x => x.id)).toEqual(['72']);
    expect((await db.collection('audit_log').where('action', '==', 'IDENTITY_CONFLICT_REGISTERED').get()).size).toBe(1);
  });
});

describe('B3.1 — uma reserva por ciclo, expiração e venda fora da reserva [5,6,7,20,21,22]', () => {
  beforeEach(async () => { await limparDados(); await db.doc('carteira_comercial/GC:80').set(v2('80', ADE)); await seedV([venda(1, 80, dia(150), '111')]); });
  test('uma oportunidade ativa por cliente/ciclo: duplicada, outro vendedor ou outro dia não criam segunda; retry idempotente', async () => {
    const a = await reservar(80, FAB, ADE, HOJE); expect(a.repetido).toBe(false); expect((await reservar(80, FAB, ADE, HOJE)).repetido).toBe(true);
    expect((await reservar(80, FAB, ADE, R.somarDias(HOJE, 1))).repetido).toBe(true);                                                           // mesma chave de ciclo em outro dia
    expect(await erro(reservar(80, ADE, null, HOJE, { ciclo: dia(160) }))).toBe('failed-precondition');                                         // outro ciclo/destino com reserva ativa do cliente
    expect((await db.collection('carteira_reativacoes').get()).size).toBe(1); expect((await db.collection('audit_log').where('action', '==', 'REACTIVATION_RESERVED').get()).size).toBe(1);
  });
  test('sem carteira: só UM vendedor reservado por vez (Ademir e Fabiana nunca simultâneos)', async () => {
    await seedV([venda(2, 81, dia(200), '999')]); const rs = await Promise.allSettled([reservar(81, ADE, null, HOJE, { ciclo: dia(200) }), reservar(81, FAB, null, HOJE, { ciclo: dia(200) })]);
    expect((await db.collection('carteira_reativacoes').where('portfolioId', '==', 'GC:81').get()).size).toBe(1); expect(rs.filter(x => x.status === 'fulfilled' && !x.value.repetido).length).toBe(1);
  });
  test('expiração: após o prazo sem venda nem follow-up a reserva EXPIRA, owner mantido, sem carteira continua sem carteira; com follow-up vigente não expira; auditada', async () => {
    await reservar(80, FAB, ADE, dia(10)); await seedV([venda(2, 82, dia(200), '999')]); await reservar(82, ADE, null, dia(10), { ciclo: dia(200) });
    expect(await OPS.expirarReservas(db, HOJE, FieldValue)).toBe(2); const estados = (await db.collection('carteira_reativacoes').get()).docs.map(d => d.data().estado); expect(estados).toEqual(['EXPIRADA', 'EXPIRADA']);
    expect((await db.doc('carteira_comercial/GC:80').get()).data().ownerUid).toBe(ADE); expect((await db.doc('carteira_comercial/GC:82').get()).exists).toBe(false);
    expect((await db.collection('audit_log').where('action', '==', 'REACTIVATION_EXPIRED').get()).size).toBe(2); expect(await OPS.expirarReservas(db, HOJE, FieldValue)).toBe(0);      // idempotente
    await limparDados(); await db.doc('carteira_comercial/GC:80').set(v2('80', ADE)); await reservar(80, FAB, ADE, dia(10)); const ref = (await db.collection('carteira_reativacoes').get()).docs[0].ref; await ref.update({ followUpAte: R.somarDias(HOJE, 5) });
    expect(await OPS.expirarReservas(db, HOJE, FieldValue)).toBe(0);
  });
  test('venda FORA da reserva (sem reserva, vencida, encerrada ou de outro vendedor) NÃO transfere; venda da gestão é neutra', async () => {
    await reservar(80, FAB, ADE, dia(30)); const vf = venda(2, 80, dia(1), '222'); await seedV([vf]);
    const c = await carregarContexto(db, { hoje: HOJE }); const cart = (await db.doc('carteira_comercial/GC:80').get()).data(); const reservas = await OPS.carregarReservasDoCliente(db, 'GC:80');
    const d = R.decidirVendaB3({ venda: vf, vendasCliente: c.vendasPorCliente.get('80'), carteira: cart, vend: c.vend, reservas, hoje: HOJE }); expect(d.decisao).toBe('MANTER_SEM_OPORTUNIDADE');
    expect((await OPS.aplicarDecisaoVenda(db, FieldValue, { decisao: d, venda: vf, carteira: cart, agoraIso: HOJE + 'T10:00:00.000Z' })).ignorado).toBe('MANTER_SEM_OPORTUNIDADE'); expect((await db.doc('carteira_comercial/GC:80').get()).data().ownerUid).toBe(ADE);
    const vg = venda(3, 80, dia(1), '999'); await seedV([vg]); const c2 = await carregarContexto(db, { hoje: HOJE });
    const dg = R.decidirVendaB3({ venda: vg, vendasCliente: c2.vendasPorCliente.get('80'), carteira: cart, vend: c2.vend, reservas, hoje: HOJE }); expect(dg).toMatchObject({ decisao: 'VENDA_GESTAO_NEUTRA', creditoUid: null, renovaCicloDe: null });
    expect((await OPS.aplicarDecisaoVenda(db, FieldValue, { decisao: dg, venda: vg, carteira: cart, agoraIso: HOJE + 'T10:00:00.000Z' })).ignorado).toBe('VENDA_GESTAO_NEUTRA');
  });
  test('concorrência: duas vendas na reativação ⇒ no máximo uma transferência, nunca dois owners', async () => {
    await reservar(80, FAB, ADE, dia(2)); const a = venda(2, 80, dia(1), '222'), b = venda(3, 80, dia(1), '111'); await seedV([a, b]);
    const proc = async v => { const c = await carregarContexto(db, { hoje: HOJE }); const cart = (await db.doc('carteira_comercial/GC:80').get()).data(); const d = R.decidirVendaB3({ venda: v, vendasCliente: c.vendasPorCliente.get('80'), carteira: cart, vend: c.vend, reservas: await OPS.carregarReservasDoCliente(db, 'GC:80'), hoje: HOJE });
      return OPS.aplicarDecisaoVenda(db, FieldValue, { decisao: d, venda: v, carteira: cart, agoraIso: HOJE + 'T10:00:00.000Z' }); };
    await Promise.allSettled([proc(a), proc(b)]); expect((await db.collection('carteira_comercial_historico').where('tipoEvento', '==', 'REATIVACAO_120D_PRIMEIRA_VENDA').get()).size).toBeLessThanOrEqual(1);
    expect([ADE, FAB]).toContain((await db.doc('carteira_comercial/GC:80').get()).data().ownerUid);
  });
});

describe('B3.1 — segurança: vendedor não controla owner/reserva/data [3]', () => {
  test('gestão callable: payload estrito, ação inválida e identidade; nenhuma ação cria oportunidade ou muda owner por si só', async () => {
    expect(await erro(G.reativacaoGestaoHandler(req(GES, { acao: 'transferir', portfolioId: 'GC:1' }), { db }))).toBe('invalid-argument');
    expect(await erro(G.reativacaoGestaoHandler(req(GES, { acao: 'reversao', portfolioId: 'GC:1', vendaId: '1', requestId: rid('x'), ownerUid: ADE }), { db }))).toBe('invalid-argument');
    expect(Object.keys(G.PERMITIDOS).sort()).toEqual(['devolucao', 'naoContatar', 'pendencias', 'reversao', 'venda']);   // B3.2: + consulta de venda e pendências (somente leitura)
  });
  test('claim/outcome recusam campos de identidade e de reserva no payload (vendedor não escolhe owner/vendedor/data)', async () => {
    for (const campo of ['ownerUid', 'novoOwnerUid', 'destinoUid', 'reservaAte', 'cicloAncoraEm', 'liberadoEm'])
      expect(await erro(CAN.claimOpportunityHandler(req(ADE, { opportunityInstanceId: '0123456789abcdef', [campo]: ADE }), at(HOJE)))).toBe('invalid-argument');
  });
});
