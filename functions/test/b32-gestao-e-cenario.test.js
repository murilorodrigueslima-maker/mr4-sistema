'use strict';
// B3.2 — ferramentas da gestão (tela + callable) e CENÁRIO CONTROLADO ponta a ponta (dados sintéticos, emulador; sem cliente real, sem senha).
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const R = require('../lib/reativacao120'); const OPS = require('../lib/reativacaoOps'); const PV = require('../lib/reativacaoVendas'); const JOB = require('../lib/reativacaoJob'); const Q = require('../lib/crmConsulta'); const CAN = require('../lib/canaryCallable'); const G = require('../lib/reativacaoGestaoCallable');
jest.setTimeout(240000);
const ADE = 'b32g-ade', FAB = 'b32g-fab', CAM = 'b32g-cam', GES = 'b32g-ges', HOJE = '2026-10-07', CORTE = '2026-09-27', dia = n => R.somarDias(HOJE, -n), T0 = '2026-09-26T13:59:45.769Z';
const AGORA = HOJE + 'T10:00:00.000Z'; const at = d => ({ now: () => new Date(d + 'T13:00:00.000Z') });
const erro = p => p.then(() => 'OK', e => e.code || e.message); const req = (uid, data) => ({ auth: uid ? { uid } : null, data }); const rid = n => 'rq-b32g-' + n + '-' + Math.random().toString(36).slice(2, 7);
const COLS = ['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_reativacao_decisoes', 'carteira_reativacao_decisoes_sombra', 'carteira_comercial_devolucoes', 'carteira_comercial_revisoes', 'carteira_comercial_restricoes', 'carteira_comercial_restricoes_hist',
  'identidade_conflitos', 'vendas_gc', 'users', 'sistema_usuarios', 'interacoes_fila', 'clientes', 'carteira_comercial_config', 'audit_log', 'crm_notas_privadas', 'fila_comercial'];
const limpar = async cols => { for (const c of cols) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const v2 = (gc, owner, ex = {}) => ({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: owner === ADE ? '111' : '222', criadoEm: T0, atualizadoEm: T0, versao: 2,
  status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: null, conflito: null, ultimoEventoId: 'E', ...ex });
const venda = (id, cli, data, gcVend, ex = {}) => ({ id: String(id), cliente_id: String(cli), data, vendedor_id: String(gcVend), nome_situacao: 'Concretizada', valor_total: '100', ...ex });
const seedV = async vs => { for (const v of vs) { const { id, ...r } = v; await db.doc('vendas_gc/' + id).set(r); } };
const fila = uid => Q.crmConsultaHandler(req(uid, { acao: 'fila' }), { db });
beforeAll(async () => {
  await limpar(COLS);
  for (const [uid, role, mods, cc] of [[ADE, 'funcionario', ['fila-comercial-operar'], '111'], [FAB, 'funcionario', ['fila-comercial-operar'], '222'], [CAM, 'funcionario', ['fila-comercial-gestao'], null], [GES, 'gestor', [], null]]) {
    await db.doc('users/' + uid).set({ role, ativo: true });
    await db.doc('sistema_usuarios/' + uid).set({ nome: uid, modulos: mods, admin: false, ...(cc ? { carteiraComercial: { podePossuirCarteira: true, ativoComercialmente: true, gestaoClickVendedorId: cc, pausaTemporaria: false, desligado: false }, filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } } : {}) });
  }
});
afterAll(async () => { await limpar(COLS); });

describe('B3.2 — tela da gestão (crm-gestao.html)', () => {
  const h = fs.readFileSync(path.join(__dirname, '../../modulos/crm-gestao.html'), 'utf8'), crm = fs.readFileSync(path.join(__dirname, '../../modulos/crm.html'), 'utf8');
  test('traz as 4 ferramentas pedidas e NÃO traz tela de conflitos de identidade', () => {
    for (const t of ['Não contatar', 'Devoluções', 'Pendências de reversão', 'Histórico e auditoria']) expect(h).toContain(t);
    expect(h).toContain('Conferi que esta é a venda correta'); expect(h).not.toMatch(/identidade_conflitos|conflito de identidade/i);
  });
  test('só chama a Function de gestão para mudar algo (sem escrita direta no Firestore); acesso restrito a proprietário/gestão; usa texto escapado', () => {
    expect(h).not.toMatch(/setDoc|updateDoc|addDoc|deleteDoc|writeBatch/); expect(h).toMatch(/role === 'gestor' \|\| \(ss\.data\(\)\.modulos \|\| \[\]\)\.includes\('fila-comercial-gestao'\)/); expect(h).toContain("'crmReativacaoGestao'"); expect(h).toMatch(/const esc =/);
  });
  test('o CRM só mostra o atalho para a gestão', () => { expect(crm).toMatch(/if \(S\.gestao\) \{ const l = document\.getElementById\('linkGestao'\)/); expect(crm).toMatch(/id="linkGestao"[^>]*hidden/); });
});

describe('B3.2 — callable da gestão: consulta de venda e pendências', () => {
  beforeAll(async () => { await limpar(['carteira_comercial', 'carteira_comercial_historico', 'vendas_gc', 'carteira_comercial_revisoes', 'carteira_comercial_devolucoes']); await seedV([venda(7001, 701, dia(5), '111')]); await db.collection('carteira_comercial_revisoes').doc('rv_x').set({ tipo: 'REVERSAO_AMBIGUA', portfolioId: 'GC:701', vendaId: '7001', motivos: ['CONFLITO_ABERTO'], estado: 'PENDENTE', criadoEm: AGORA }); });
  test('consulta da venda: proprietário e Camila podem; vendedor e anônimo não; sem nome/contato do cliente', async () => {
    for (const u of [GES, CAM]) { const r = await G.reativacaoGestaoHandler(req(u, { acao: 'venda', vendaId: '7001' }), { db }); expect(r.venda).toMatchObject({ vendaId: '7001', valida: true, clienteGc: '701', vendedorGc: '111' }); expect(JSON.stringify(r)).not.toMatch(/nome|telefone|email|cpf/i); }
    for (const u of [ADE, FAB]) expect(await erro(G.reativacaoGestaoHandler(req(u, { acao: 'venda', vendaId: '7001' }), { db }))).toBe('permission-denied');
    expect(await erro(G.reativacaoGestaoHandler(req(null, { acao: 'venda', vendaId: '7001' }), { db }))).toBe('unauthenticated'); expect(await erro(G.reativacaoGestaoHandler(req(GES, { acao: 'venda', vendaId: '999' }), { db }))).toBe('not-found');
    expect(await erro(G.reativacaoGestaoHandler(req(GES, { acao: 'venda', vendaId: '7001', extra: 1 }), { db }))).toBe('invalid-argument');
  });
  test('pendências: gestão vê revisões abertas; vendedor não', async () => {
    const r = await G.reativacaoGestaoHandler(req(CAM, { acao: 'pendencias' }), { db }); expect(r.revisoesAbertas).toHaveLength(1); expect(r.revisoesAbertas[0]).toMatchObject({ tipo: 'REVERSAO_AMBIGUA', vendaId: '7001' });
    expect(await erro(G.reativacaoGestaoHandler(req(ADE, { acao: 'pendencias' }), { db }))).toBe('permission-denied');
  });
});

describe('B3.2 — CENÁRIO CONTROLADO (sintético): gestão + vendedor, do bloqueio à reversão, sem tocar dados reais', () => {
  beforeAll(async () => {
    await limpar(['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_reativacao_decisoes', 'carteira_comercial_devolucoes', 'carteira_comercial_revisoes', 'carteira_comercial_restricoes', 'carteira_comercial_restricoes_hist', 'vendas_gc', 'interacoes_fila', 'audit_log', 'carteira_comercial_config', 'crm_notas_privadas']);
    await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' }); await db.doc('carteira_comercial_config/reativacao').set({ modo: 'ATIVO', corte: CORTE });
    await db.doc('carteira_comercial/GC:900').set(v2('900', ADE, { cicloAncoraEm: '2026-05-01' })); await db.doc('carteira_comercial/GC:901').set(v2('901', ADE)); await db.doc('carteira_comercial/GC:902').set(v2('902', FAB));
    await seedV([venda(1, 900, dia(150), '111'), venda(2, 901, dia(150), '111'), venda(3, 902, dia(150), '222')]);
  });
  const state = {};
  test('1. gestão marca NÃO CONTATAR no 901 (Camila); vendedor não consegue', async () => {
    expect(await erro(G.reativacaoGestaoHandler(req(ADE, { acao: 'naoContatar', portfolioId: 'GC:901', naoContatar: false, motivoCodigo: 'OUTRO', motivo: 'tentando remover', requestId: rid('a') }), { db }))).toBe('permission-denied');
    const r = await G.reativacaoGestaoHandler(req(CAM, { acao: 'naoContatar', portfolioId: 'GC:901', naoContatar: true, motivoCodigo: 'PEDIDO_DO_CLIENTE', motivo: 'cliente pediu para não ser contatado', requestId: rid('b') }), { db }); expect(r.naoContatar).toBe(true);
  });
  test('2. dry-run do job (trava ativa): planeja 900 e 902; bloqueia 901; ZERO escritas', async () => {
    const r = await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE, agoraIso: AGORA }); expect(r.status).toBe('DRY');        // config=ATIVO, mas a trava FORCAR_DRY impede qualquer escrita
    expect((await db.collection('carteira_reativacoes').get()).size).toBe(0);
    await db.doc('carteira_comercial_config/reativacao').set({ modo: 'DRY', corte: CORTE }); const d = await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE, agoraIso: AGORA }); expect(d.status).toBe('DRY');
    expect(d.plano.liberar.map(x => x.id).sort()).toEqual(['900', '902']); expect(d.plano.bloqueados.NAO_CONTATAR).toEqual(['901']); expect((await db.collection('carteira_reativacoes').get()).size).toBe(0);
    await db.doc('carteira_comercial_config/reativacao').set({ modo: 'ATIVO', corte: CORTE });
  });
  test('3. ensaio ATIVO (trava removida só no emulador): reservas com nome; cada vendedor vê apenas as suas', async () => {
    const r = await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE, agoraIso: HOJE + 'T06:00:00.000Z', forcarDry: false, lookupNome: async gc => 'Cliente Sintético ' + gc }); expect(r).toMatchObject({ status: 'ATIVO', criadas: 2 });
    const a = await fila(ADE), f = await fila(FAB);
    expect(a.reativacoes.map(x => x.nomeCliente)).toEqual(['Cliente Sintético 902']); expect(f.reativacoes.map(x => x.nomeCliente)).toEqual(['Cliente Sintético 900']); state.opp900 = f.reativacoes[0].opportunityInstanceId;
    expect(f.reativacoes[0].reativacao).toMatchObject({ semCarteira: false, bloqueadoContato: false }); expect(JSON.stringify(a)).not.toContain('900'); expect(JSON.stringify(f)).not.toContain('902');
    const g = await fila(GES); expect(g.escopo).toBe('GESTAO'); expect(g.reativacoes).toHaveLength(2);
  });
  test('4. Fabiana trabalha: inicia, tenta follow-up sem motivo (recusado), faz follow-up válido; Ademir não consegue iniciar a oportunidade da Fabiana', async () => {
    expect(await erro(CAN.claimOpportunityHandler(req(ADE, { opportunityInstanceId: state.opp900 }), at(HOJE)))).toBe('permission-denied');
    expect((await CAN.claimOpportunityHandler(req(FAB, { opportunityInstanceId: state.opp900 }), at(HOJE))).estado).toBe('EM_ATENDIMENTO');
    expect(await erro(CAN.registerOutcomeHandler(req(FAB, { opportunityInstanceId: state.opp900, outcome: 'PEDIU_RETORNO', scheduledFor: R.somarDias(HOJE, 15) }), at(HOJE)))).toBe('invalid-argument');
    const ate = R.somarDias(HOJE, 15); await CAN.registerOutcomeHandler(req(FAB, { opportunityInstanceId: state.opp900, outcome: 'PEDIU_RETORNO', scheduledFor: ate, nota: 'cliente volta após inventário' }), at(HOJE));
    expect((await db.collection('carteira_reativacoes').get()).docs.find(d => d.data().portfolioId === 'GC:900').data().followUpAte).toBe(ate);
    expect((await db.doc('carteira_comercial/GC:900').get()).data().ownerUid).toBe(ADE);                                                          // follow-up não transfere
  });
  test('5. venda válida da Fabiana na reserva ⇒ processador (ATIVO) transfere; reserva CONVERTIDA; histórico e auditoria', async () => {
    await seedV([venda(10, 900, HOJE, '222')]); const r = await PV.processarVendas(db, FieldValue, { agoraIso: AGORA, forcarDry: false, modoForcado: 'ATIVO' }); expect(r.aplicadas).toBe(1);
    expect((await db.doc('carteira_comercial/GC:900').get()).data()).toMatchObject({ ownerUid: FAB, origem: 'REATIVACAO_120D', cicloAncoraEm: HOJE });
    const ev = (await db.collection('carteira_comercial_historico').get()).docs.map(d => d.data()).find(e => e.tipoEvento === 'REATIVACAO_120D_PRIMEIRA_VENDA'); expect(ev).toMatchObject({ ownerAnteriorUid: ADE, ownerNovoUid: FAB, referencias: { vendaGcId: '10' } });
    expect((await fila(FAB)).reativacoes).toHaveLength(0);                                                                                         // reserva convertida some do CRM
    expect((await db.collection('audit_log').where('action', '==', 'PORTFOLIO_REATIVACAO_120D_PRIMEIRA_VENDA').get()).size).toBe(1);
    // Ademir NÃO ganha nada com a venda do 902 (Fabiana é dona; reserva do Ademir ainda não teve venda)
    expect((await db.doc('carteira_comercial/GC:902').get()).data().ownerUid).toBe(FAB);
  });
  test('6. venda cancelada depois ⇒ pendência visível à gestão e reversão (pela tela) restaura o dono anterior; nada é apagado', async () => {
    await db.doc('vendas_gc/10').update({ nome_situacao: 'Cancelada' }); await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' });
    const p = await G.reativacaoGestaoHandler(req(CAM, { acao: 'pendencias' }), { db }); expect(p.invalidacoes.detalhes).toEqual([expect.objectContaining({ portfolioId: 'GC:900', vendaId: '10', acao: 'REVERTER' })]);
    expect(await erro(G.reativacaoGestaoHandler(req(FAB, { acao: 'reversao', portfolioId: 'GC:900', vendaId: '10', requestId: rid('r') }), { db }))).toBe('permission-denied');
    const r = await G.reativacaoGestaoHandler(req(GES, { acao: 'reversao', portfolioId: 'GC:900', vendaId: '10', requestId: rid('r2') }), { db }); expect(r.status).toBe('REVERTIDA');
    expect((await db.doc('carteira_comercial/GC:900').get()).data()).toMatchObject({ ownerUid: ADE, cicloAncoraEm: '2026-05-01' }); expect((await db.collection('carteira_comercial_historico').get()).size).toBe(2);
    expect((await G.reativacaoGestaoHandler(req(GES, { acao: 'pendencias' }), { db })).invalidacoes.detalhes.filter(d => d.acao === 'REVERTER')).toHaveLength(0);
  });
  test('7. conclusão: o único cliente sem trava foi tratado; nada fora do cenário mudou (901 bloqueado, 902 intacto, sem carteira nova)', async () => {
    expect((await db.doc('carteira_comercial/GC:901').get()).data()).toMatchObject({ ownerUid: ADE, versao: 2 }); expect((await db.collection('carteira_comercial').get()).size).toBe(3);
    expect((await db.collection('carteira_reativacoes').get()).docs.find(d => d.data().portfolioId === 'GC:901')).toBeUndefined();
  });
});
