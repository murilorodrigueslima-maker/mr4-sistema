'use strict';
// CRM MR4 2.0 — Fase 1. Testes puros + EMULADOR (localhost:8080). PROD_WRITES=0.
// Cobre: REGISTER_OUTCOME, OBSERVATION, FOLLOWUP, FOLLOWUP_OWNER_PROTECTION, FORTALEZA_TIMEZONE, AGENDA, CUSTOMER_360, TIMELINE,
//        CONTACT_TO_SALE, RECOVERED_CUSTOMER, SELLER_HOME, OPPORTUNITY_CARD.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT          = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
db.settings({ ignoreUndefinedProperties: true });

const F  = require('../lib/filaOperacional');
const C  = require('../lib/canaryCallable');
const Q  = require('../lib/crmConsulta');
const TL = require('../lib/crmTimeline');
const V  = require('../../modulos/crm-view.js');

// relógio: segunda 28/09/2026; 22:30 em Fortaleza = 01:30Z de terça 29/09
const T_MANHA = '2026-09-28T13:00:00.000Z';          // 10:00 Fortaleza
const T_NOITE = '2026-09-29T01:30:00.000Z';          // 22:30 Fortaleza (ainda dia 28 localmente)
const at = iso => ({ now: () => new Date(iso) });
const FAB = 'crmf1-fab', ADE = 'crmf1-ade', GES = 'crmf1-gestor', VEN0 = 'crmf1-semmod';
const OPP = { a: 'c1f1000000000001', b: 'c1f1000000000002', c: 'c1f1000000000003', d: 'c1f1000000000004', e: 'c1f1000000000005' };
const ENT = { a: 'GC_NATIVE:99100001', b: 'GC_NATIVE:99100002', c: 'GC_NATIVE:99100003', d: 'MR4_LINKED:crmf1cli0004', e: 'GC_NATIVE:99100005' };
const criados = [];
const put = async (p, d) => { criados.push(p); await db.doc(p).set(d); };
const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
const erro = p => p.then(() => 'OK', e => e.code + ':' + e.message);
let wlAntes = null;

function worklist(dataReferencia, extra = {}) {
  const item = (opp, ent, nome, grupo) => ({ opportunityInstanceId: opp, commercialEntityId: ent, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: nome,
    contextoComercial: { versao: 'V1', motivo: 'Cliente parado há mais de 120 dias.', rotuloTipo: 'Retomar contato', historico: { ultimaCompraEm: '2026-04-01', diasSemComprar: 180, pedidosTotal: 9, cicloHabitualDias: 30 }, tendencia: 'CAINDO' } });
  return {
    schemaVersion: 'worklist-v2', versao: 'N35.18.1', dataReferencia, cap: 10, vendedoresAtivos: [FAB, ADE], vendedoresRotulos: { [FAB]: 'Fabiana', [ADE]: 'Ademir' },
    vendedores: {
      [FAB]: { novas: [item(OPP.a, ENT.a, 'Cliente A', 'novas'), item(OPP.d, ENT.d, 'Cliente D', 'novas')], followUps: [], emAtendimento: [], pendentes: [item(OPP.b, ENT.b, 'Cliente B', 'pendentes')] },
      [ADE]: { novas: [item(OPP.c, ENT.c, 'Cliente C', 'novas')], followUps: [], emAtendimento: [], pendentes: [] },
    },
    atribuicoes: {
      [OPP.a]: { uid: FAB, grupo: 'novas', commercialEntityId: ENT.a, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente A', desde: dataReferencia },
      [OPP.b]: { uid: FAB, grupo: 'pendentes', commercialEntityId: ENT.b, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente B', desde: '2026-09-25' },
      [OPP.d]: { uid: FAB, grupo: 'novas', commercialEntityId: ENT.d, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente D', desde: dataReferencia },
      [OPP.c]: { uid: ADE, grupo: 'novas', commercialEntityId: ENT.c, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente C', desde: dataReferencia },
    },
    pendenciasRetidas: {}, canarios: [], ...extra,
  };
}
async function limparOps() { for (const o of Object.values(OPP)) await db.collection('interacoes_fila').doc(o).delete(); }

beforeAll(async () => {
  const w = await db.doc('fila_comercial/worklist').get(); wlAntes = w.exists ? w.data() : null;
  for (const [uid, role, mods, nome] of [[FAB, 'funcionario', ['fila-comercial', 'fila-comercial-operar'], 'Fabiana Teste'], [ADE, 'funcionario', ['fila-comercial', 'fila-comercial-operar'], 'Ademir Teste'],
    [GES, 'gestor', ['fila-comercial'], 'Gestor Teste'], [VEN0, 'funcionario', ['ponto'], 'Sem Modulo']]) {
    await put('users/' + uid, { role, ativo: true }); await put('sistema_usuarios/' + uid, { nome, bloqueado: false, modulos: mods });
  }
  // vendas do cliente A (GC 99100001): parado desde 01/04; compra em 02/10 (após contato de 28/09); cliente E: venda no mesmo dia do contato
  const vendas = [
    ['crmf1-v1', '99100001', '2026-03-01', 300], ['crmf1-v2', '99100001', '2026-04-01', 250], ['crmf1-v3', '99100001', '2026-10-02', 480],
    ['crmf1-v4', '99100005', '2026-01-10', 100], ['crmf1-v5', '99100005', '2026-09-28', 90], ['crmf1-v6', '99100001', '2026-09-20', 0],
  ];
  for (const [id, cli, data, valor] of vendas) await put('vendas_gc/' + id, { id, cliente_id: cli, data, nome_situacao: 'Concretizada', valor_total: String(valor), vendedor_id: '948278', nome_vendedor: 'Fabiana', produtos: [{ produto_id: '1', nome_produto: 'Lâmpada LED H4', quantidade: '2', valor_total: String(valor) }] });
  await put('display_metrics/painel_comercial', { vendedores: [{ nome: 'Fabiana', meta: 20000, totalMes: 5000 }, { nome: 'Ademir', meta: 30000, totalMes: 12000 }], equipe: {} });
  await put('clientes/crmf1cli0004', { nome: 'Cliente D', cidade: 'Fortaleza', whatsapp: '85999990000', gestaoClickId: '99100004' });
  await put('perfis_360/crmf1cli0004', { clienteMr4Id: 'crmf1cli0004', gestaoClickId: '99100004', faturamentoTotal: 15000, ticketMedio180d: 800, faturamento180d: 4000, diasEntreComprasMediana: 25,
    categoriasMaisCompradas: [{ categoria: 'ILUMINAÇÃO', quantidadePedidos: 7 }, { categoria: 'SOM', quantidadePedidos: 3 }, { categoria: 'SEM_CATEGORIA', quantidadePedidos: 9 }] });
}, 60000);
beforeEach(async () => { await limparOps(); await db.doc('fila_comercial/worklist').set(worklist('2026-09-28')); });
afterAll(async () => {
  await limparOps();
  for (const p of criados) await db.doc(p).delete();
  if (wlAntes) await db.doc('fila_comercial/worklist').set(wlAntes); else await db.doc('fila_comercial/worklist').delete();
});

// ── PUROS ───────────────────────────────────────────────────────────────────────────────────────────
describe('Observação (puro)', () => {
  test('OB-01 normalizarNota: trim, vazio→null, 280 ok, 281 rejeita, não-texto rejeita, controle removido', () => {
    expect(F.normalizarNota('  oi  ')).toBe('oi');
    expect(F.normalizarNota('   ')).toBeNull(); expect(F.normalizarNota(undefined)).toBeNull(); expect(F.normalizarNota(null)).toBeNull();
    expect(F.normalizarNota('é'.repeat(280))).toHaveLength(280);
    expect(() => F.normalizarNota('x'.repeat(281))).toThrow(/280/);
    expect(() => F.normalizarNota(123)).toThrow(/texto/);
    expect(F.normalizarNota('a\u0000b\u0007')).toBe('ab');
    expect(V.validarNota('  x ').texto).toBe('x'); expect(V.validarNota('y'.repeat(281)).ok).toBe(false); expect(V.validarNota('').ok).toBe(true);
  });
  test('OB-02 registrarOutcome guarda meta.nota no evento e mantém as anteriores (histórico)', () => {
    let e = F.criarEstadoInicial(ENT.a, OPP.a, 'REATIVACAO_120D', T_MANHA);
    e = F.claimOportunidade(e, FAB, T_MANHA);
    e = F.registrarOutcome(e, FAB, 'SEM_RESPOSTA', T_MANHA, { nota: '  tentei às 10h ' });
    e = F.claimOportunidade(e, FAB, '2026-09-29T13:00:00.000Z');
    e = F.registrarOutcome(e, FAB, 'PEDIU_RETORNO', '2026-09-29T13:05:00.000Z', { scheduledFor: '2026-10-05', nota: 'ligar dia 5' });
    const outs = e.eventos.filter(x => x.tipo === 'OUTCOME_REGISTERED');
    expect(outs.map(x => x.meta && x.meta.nota)).toEqual(['tentei às 10h', 'ligar dia 5']);
    expect(e.nextFollowUpAt).toBe('2026-10-05');
    const sem = F.registrarOutcome(F.claimOportunidade(F.criarEstadoInicial(ENT.a, OPP.a, 'REATIVACAO_120D', T_MANHA), FAB, T_MANHA), FAB, 'CONVERSA_REALIZADA', T_MANHA, { nota: '   ' });
    expect(sem.eventos.pop().meta).toBeUndefined();
  });
});

describe('Hoje / Agenda / Cartão (puro)', () => {
  const op = (opp, ent, extra) => ({ opportunityInstanceId: opp, commercialEntityId: ent, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'N', estado: 'DISPONIVEL', claimAtual: null, cooledUntil: null, nextFollowUpAt: null, eventos: [], ...extra });
  const outcome = (uid, outcome, ts, meta) => ({ tipo: 'OUTCOME_REGISTERED', operadorId: uid, outcome, timestamp: ts, ...(meta ? { meta } : {}) });
  test('HO-01 ordem ATRASADOS → RETORNOS DE HOJE → EM ATENDIMENTO → PENDENTES → NOVAS; só o próprio vendedor', () => {
    const doc = worklist('2026-09-28');
    doc.vendedores[FAB].followUps = [{ opportunityInstanceId: OPP.e, commercialEntityId: ENT.e, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'E' }];
    const opMap = new Map([[OPP.e, op(OPP.e, ENT.e, { estado: 'AGUARDANDO_RETORNO', nextFollowUpAt: '2026-09-24', eventos: [outcome(FAB, 'PEDIU_RETORNO', '2026-09-20T12:00:00Z')] })],
      [OPP.a, op(OPP.a, ENT.a, { estado: 'EM_ATENDIMENTO', claimAtual: { operadorId: FAB, claimadoEm: '2026-09-28T12:30:00.000Z' } })]]);
    const h = V.montarHoje({ doc, opMap, uid: FAB, hoje: '2026-09-28', agoraMs: Date.parse(T_MANHA), podeOperar: true });
    expect(h.atrasados.map(x => x.item.opportunityInstanceId)).toEqual([OPP.e]);
    expect(h.emAtendimento.map(x => x.item.opportunityInstanceId)).toEqual([OPP.a]);
    expect(h.pendentes.map(x => x.item.opportunityInstanceId)).toEqual([OPP.b]);
    expect(h.novas.map(x => x.item.opportunityInstanceId)).toEqual([OPP.d]);
    const ha = V.montarHoje({ doc, opMap, uid: ADE, hoje: '2026-09-28', agoraMs: Date.parse(T_MANHA), podeOperar: true });
    expect([...ha.atrasados, ...ha.emAtendimento, ...ha.pendentes].length).toBe(0);
    expect(ha.novas.map(x => x.item.opportunityInstanceId)).toEqual([OPP.c]);
  });
  test('HO-02 sem worklist de hoje (fim de semana): mostra só os retornos vencidos próprios, a partir de interacoes_fila', () => {
    const opMap = new Map([[OPP.e, op(OPP.e, ENT.e, { estado: 'AGUARDANDO_RETORNO', nextFollowUpAt: '2026-09-28', eventos: [outcome(FAB, 'PEDIU_RETORNO', '2026-09-20T12:00:00Z')] })],
      [OPP.c, op(OPP.c, ENT.c, { estado: 'AGUARDANDO_RETORNO', nextFollowUpAt: '2026-09-28', eventos: [outcome(ADE, 'PEDIU_RETORNO', '2026-09-20T12:00:00Z')] })]]);
    const h = V.montarHoje({ doc: worklist('2026-09-25'), opMap, uid: FAB, hoje: '2026-09-28', agoraMs: Date.parse(T_MANHA), podeOperar: true });
    expect(h.worklistDeHoje).toBe(false);
    expect(h.retornosHoje.map(x => x.item.opportunityInstanceId)).toEqual([OPP.e]);
  });
  test('AG-01 agenda: atrasados / hoje / amanhã / esta semana (até domingo) / depois; dono = autor do último resultado; concluída e cooldown fora', () => {
    const mk = (opp, data, uid, extra) => op(opp, 'GC_NATIVE:9' + opp.slice(-3), { estado: 'AGUARDANDO_RETORNO', nextFollowUpAt: data, eventos: [outcome(uid, 'PEDIU_RETORNO', '2026-09-20T12:00:00Z')], ...extra });
    const opMap = new Map([
      ['a000000000000001', mk('a000000000000001', '2026-09-25', FAB)], ['a000000000000002', mk('a000000000000002', '2026-09-28', FAB)],
      ['a000000000000003', mk('a000000000000003', '2026-09-29', FAB)], ['a000000000000004', mk('a000000000000004', '2026-10-04', FAB)],
      ['a000000000000005', mk('a000000000000005', '2026-10-05', FAB)], ['a000000000000006', mk('a000000000000006', '2026-09-30', ADE)],
      ['a000000000000007', mk('a000000000000007', '2026-09-30', FAB, { estado: 'CONCLUIDA' })],
      ['a000000000000008', mk('a000000000000008', '2026-09-30', FAB, { cooledUntil: '2026-10-20T00:00:00.000Z' })],
    ]);
    const a = V.montarAgenda({ opMap, uid: FAB, hoje: '2026-09-28', agoraMs: Date.parse(T_MANHA) });
    const ids = k => a[k].map(x => x.opportunityInstanceId.slice(-1));
    expect([ids('atrasados'), ids('hoje'), ids('amanha'), ids('semana'), ids('depois')]).toEqual([['1'], ['2'], ['3'], ['4'], ['5']]);
    const g = V.montarAgenda({ opMap, uid: null, hoje: '2026-09-28', agoraMs: Date.parse(T_MANHA) });     // gestão: todos
    expect(g.semana.map(x => x.opportunityInstanceId.slice(-1)).sort()).toEqual(['4', '6']);
  });
  test('TZ-01 fronteira: 22:30 de Fortaleza ainda é o dia 28; domingo fecha a semana; limites de retorno', () => {
    expect(V.dataComercial(new Date(T_NOITE))).toBe('2026-09-28');
    expect(TL.diaComercial(T_NOITE)).toBe('2026-09-28');
    expect(V.fimDaSemana('2026-09-28')).toBe('2026-10-04'); expect(V.fimDaSemana('2026-10-04')).toBe('2026-10-04');
    expect(V.limitesRetorno('2026-09-28')).toEqual({ min: '2026-09-29', max: '2027-03-27' });
  });
  test('CA-01 cartão: só campos com dado; categorias/alto valor vindos do servidor; último resultado com observação', () => {
    const doc = worklist('2026-09-28'); const v = { item: doc.vendedores[FAB].novas[0], grupoOrigem: 'novas', estado: { codigo: 'DISPONIVEL' } };
    const opx = op(OPP.a, ENT.a, { eventos: [outcome(FAB, 'SEM_RESPOSTA', '2026-09-25T12:00:00Z', { nota: 'caixa postal' })], nextFollowUpAt: '2026-09-29', estado: 'DISPONIVEL' });
    const m = V.modeloCartao(v, opx, { categorias: ['ILUMINAÇÃO', 'SOM'], faixaValor: 'ALTO_VALOR' });
    expect(m.linhas.map(l => l.k)).toEqual(['Dias sem comprar', 'Última compra', 'Pedidos', 'Compra a cada', 'Tendência', 'Categorias']);
    expect(m.altoValor).toBe(true); expect(m.ultimoResultado).toMatchObject({ rotulo: 'Sem resposta', nota: 'caixa postal' }); expect(m.proximoRetorno).toBe('2026-09-29');
    const vazio = V.modeloCartao({ item: { opportunityInstanceId: OPP.a, commercialEntityId: ENT.a, nomeCliente: 'X' }, estado: {} }, null, null);
    expect(vazio.linhas).toEqual([]); expect(vazio.altoValor).toBe(false); expect(vazio.ultimoResultado).toBeNull();
  });
});

describe('Timeline / venda após contato / recuperado (puro)', () => {
  const est = eventos => [{ opportunityInstanceId: OPP.a, commercialEntityId: ENT.a, estado: 'CONCLUIDA', eventos }];
  const vendas = [{ id: '1', data: '2026-04-01', nome_situacao: 'Concretizada', valor_total: '250' }, { id: '2', data: '2026-10-02', nome_situacao: 'Concretizada', valor_total: '480', nome_vendedor: 'Fabiana' },
    { id: '3', data: '2026-09-20', nome_situacao: 'Concretizada', valor_total: '0' }, { id: '4', data: '2026-09-21', nome_situacao: 'Cancelada', valor_total: '100' }];
  test('TL-01 ordem cronológica, ator SISTEMA/VENDEDOR/VENDA, observação no evento, venda sem valor para vendedor', () => {
    const ev = [{ tipo: 'CLAIMED', operadorId: FAB, timestamp: '2026-09-28T12:40:00Z' }, { tipo: 'OUTCOME_REGISTERED', operadorId: FAB, outcome: 'PEDIU_RETORNO', timestamp: '2026-09-28T12:45:00Z', meta: { scheduledFor: '2026-09-30', nota: 'estoque alto' } }];
    const t = TL.montarTimeline({ estados: est(ev), vendas, atribuicoes: [{ desde: '2026-09-28', uid: FAB }], nomePorUid: { [FAB]: 'Fabiana' } });
    const cron = [...t].reverse().map(x => x.tipo);
    expect(cron).toEqual(['VENDA', 'VENDA', 'ENTROU_WORKLIST', 'INICIOU', 'RESULTADO', 'VENDA']);   // inclui o pedido de valor zero (20/09); cancelada fica fora
    expect(t.find(x => x.tipo === 'RESULTADO')).toMatchObject({ ator: 'VENDEDOR', nota: 'estoque alto', detalhe: 'Retorno marcado para 30/09/2026' });
    expect(t.filter(x => x.tipo === 'VENDA').every(x => x.ator === 'VENDA' && x.valor === undefined)).toBe(true);
    expect(TL.montarTimeline({ estados: est(ev), vendas, podeVerValores: true }).find(x => x.tipo === 'VENDA').valor).toBe(480);
  });
  test('VC-01 venda após contato: APOS (dia seguinte ou depois), INDETERMINADO (mesmo dia), nada antes; CONTATO_INVALIDO não conta', () => {
    const c = [{ tipo: 'OUTCOME_REGISTERED', operadorId: FAB, outcome: 'CONVERSA_REALIZADA', timestamp: '2026-09-28T12:45:00Z' }];
    expect(TL.vendasAposContato({ estados: est(c), vendas }).map(x => [x.relacao, x.venda.data, x.diasAposContato])).toEqual([['APOS', '2026-10-02', 4]]);
    const mesmo = [{ tipo: 'OUTCOME_REGISTERED', operadorId: FAB, outcome: 'SEM_RESPOSTA', timestamp: '2026-10-02T21:00:00Z' }];   // 18h Fortaleza do dia 02
    expect(TL.vendasAposContato({ estados: est(mesmo), vendas }).map(x => x.relacao)).toEqual(['INDETERMINADO']);
    const inval = [{ tipo: 'OUTCOME_REGISTERED', operadorId: FAB, outcome: 'CONTATO_INVALIDO', timestamp: '2026-09-28T12:45:00Z' }];
    expect(TL.vendasAposContato({ estados: est(inval), vendas })).toEqual([]);
    const noite = [{ tipo: 'OUTCOME_REGISTERED', operadorId: FAB, outcome: 'CONVERSA_REALIZADA', timestamp: '2026-10-02T01:30:00Z' }]; // 22:30 do dia 01 em Fortaleza
    expect(TL.vendasAposContato({ estados: est(noite), vendas })[0]).toMatchObject({ relacao: 'APOS', diasAposContato: 1 });
  });
  test('RC-01 cliente recuperado: ≥120 dias parado no contato + compra depois; <120 não; sem histórico não; mesmo dia indeterminado', () => {
    const c = [{ tipo: 'OUTCOME_REGISTERED', operadorId: FAB, outcome: 'CONVERSA_REALIZADA', timestamp: '2026-09-28T12:45:00Z' }];
    expect(TL.clienteRecuperado({ estados: est(c), vendas })).toMatchObject({ status: 'RECUPERADO_APOS_CONTATO', diasParadoNoContato: 180, ultimaCompraAntes: '2026-04-01', diasAteVenda: 4 });
    const recente = [{ id: '9', data: '2026-08-01', nome_situacao: 'Concretizada', valor_total: '10' }, { id: '10', data: '2026-10-02', nome_situacao: 'Concretizada', valor_total: '10' }];
    expect(TL.clienteRecuperado({ estados: est(c), vendas: recente })).toBeNull();
    expect(TL.clienteRecuperado({ estados: est(c), vendas: [{ id: '2', data: '2026-10-02', nome_situacao: 'Concretizada', valor_total: '10' }] })).toBeNull();
    const mesmo = [{ id: '1', data: '2026-04-01', nome_situacao: 'Concretizada', valor_total: '10' }, { id: '2', data: '2026-09-28', nome_situacao: 'Concretizada', valor_total: '10' }];
    expect(TL.clienteRecuperado({ estados: est(c), vendas: mesmo }).status).toBe('INDETERMINADO');
  });
});

// ── EMULADOR: callables ────────────────────────────────────────────────────────────────────────────
describe('Registro rápido (registerOutcome) + observação + duplicidade', () => {
  test('RO-01 claim → resultado com observação: gravada no evento, com vendedor e horário; resposta traz retorno', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    const r = await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'SEM_RESPOSTA', nota: '  caixa postal  ' }), at(T_MANHA));
    expect(r).toMatchObject({ estado: 'DISPONIVEL', nextFollowUpAt: '2026-09-29' });
    const ev = (await db.doc('interacoes_fila/' + OPP.a).get()).data().eventos.filter(e => e.tipo === 'OUTCOME_REGISTERED');
    expect(ev[0]).toMatchObject({ operadorId: FAB, outcome: 'SEM_RESPOSTA', timestamp: T_MANHA, meta: { nota: 'caixa postal' } });
  });
  test('RO-02 observação > 280 / não-texto → invalid-argument sem gravar; vazia permitida (sem meta.nota)', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    expect(await erro(C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'CONVERSA_REALIZADA', nota: 'x'.repeat(281) }), at(T_MANHA)))).toMatch(/^invalid-argument:Observação inválida/);
    expect(await erro(C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'CONVERSA_REALIZADA', nota: { a: 1 } }), at(T_MANHA)))).toMatch(/^invalid-argument/);
    expect((await db.doc('interacoes_fila/' + OPP.a).get()).data().estado).toBe('EM_ATENDIMENTO');
    await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'CONVERSA_REALIZADA', nota: '   ' }), at(T_MANHA));
    const ev = (await db.doc('interacoes_fila/' + OPP.a).get()).data().eventos.pop();
    expect(ev.meta).toBeUndefined();
  });
  test('RO-03 submissão duplicada (duplo clique / 2 abas): só um resultado é gravado', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    const p = { opportunityInstanceId: OPP.a, outcome: 'CONVERSA_REALIZADA', nota: 'fechado' };
    const r = await Promise.all([1, 2, 3].map(() => erro(C.registerOutcomeHandler(req(FAB, p), at(T_MANHA)))));
    expect(r.filter(x => x === 'OK')).toHaveLength(1);
    const outs = (await db.doc('interacoes_fila/' + OPP.a).get()).data().eventos.filter(e => e.tipo === 'OUTCOME_REGISTERED');
    expect(outs).toHaveLength(1);
  }, 30000);
  test('RO-04 histórico: resultados sucessivos acumulam observações, nenhuma sobrescrita', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'SEM_RESPOSTA', nota: 'primeira' }), at(T_MANHA));
    await db.doc('fila_comercial/worklist').set(worklist('2026-09-29'));
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at('2026-09-29T13:00:00.000Z'));
    await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'PEDIU_RETORNO', scheduledFor: '2026-10-05', nota: 'segunda' }), at('2026-09-29T13:10:00.000Z'));
    const d = (await db.doc('interacoes_fila/' + OPP.a).get()).data();
    expect(d.eventos.filter(e => e.tipo === 'OUTCOME_REGISTERED').map(e => e.meta.nota)).toEqual(['primeira', 'segunda']);
    expect(d).toMatchObject({ estado: 'AGUARDANDO_RETORNO', nextFollowUpAt: '2026-10-05' });
  });
});

describe('Follow-up: fuso de Fortaleza, datas e proteção de dono no servidor', () => {
  test('TZ-02 às 22:30 de Fortaleza (01:30Z do dia seguinte), "amanhã" local é aceito e "hoje" local é recusado', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_NOITE));
    expect(await erro(C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'PEDIU_RETORNO', scheduledFor: '2026-09-28' }), at(T_NOITE)))).toMatch(/futura/);
    const r = await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'PEDIU_RETORNO', scheduledFor: '2026-09-29' }), at(T_NOITE));
    expect(r.nextFollowUpAt).toBe('2026-09-29');
  });
  test('FU-01 datas inválidas: formato, dia inexistente, além de 180 dias, ausente em PEDIU_RETORNO', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    for (const d of ['29/09/2026', '2026-02-31', '2027-04-01', undefined]) {
      expect(await erro(C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'PEDIU_RETORNO', scheduledFor: d }), at(T_MANHA)))).toMatch(/^invalid-argument/);
    }
    expect((await db.doc('interacoes_fila/' + OPP.a).get()).data().estado).toBe('EM_ATENDIMENTO');
  });
  test('FU-02 SEM_RESPOSTA agenda o próximo dia útil para o mesmo vendedor; 3ª seguida → cooldown 30 dias', async () => {
    let t = ['2026-09-28T13:00:00.000Z', '2026-09-29T13:00:00.000Z', '2026-09-30T13:00:00.000Z'];
    for (let i = 0; i < 3; i++) {
      await db.doc('fila_comercial/worklist').set(worklist(t[i].slice(0, 10)));
      await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(t[i]));
      const r = await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'SEM_RESPOSTA' }), at(t[i]));
      if (i < 2) expect(r.nextFollowUpAt).toBe(['2026-09-29', '2026-09-30'][i]); else expect(r.cooledUntil).toBe('2026-10-30T13:00:00.000Z');
    }
    expect(V.donoDoRetorno((await db.doc('interacoes_fila/' + OPP.a).get()).data(), Date.parse(t[2]))).toBeNull();
  }, 30000);
  test('FUP-01 PROTEÇÃO: retorno reservado para Fabiana não pode ser assumido por Ademir por chamada direta (sem atribuição hoje)', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'PEDIU_RETORNO', scheduledFor: '2026-10-05' }), at(T_MANHA));
    // dias depois, a worklist do dia não contém mais OPP.a (retorno futuro fica fora da lista)
    const w = worklist('2026-09-30'); delete w.atribuicoes[OPP.a]; w.vendedores[FAB].novas = w.vendedores[FAB].novas.filter(i => i.opportunityInstanceId !== OPP.a);
    await db.doc('fila_comercial/worklist').set(w);
    expect(await erro(C.claimOpportunityHandler(req(ADE, { opportunityInstanceId: OPP.a }), at('2026-09-30T13:00:00.000Z')))).toBe('permission-denied:Retorno reservado para outro vendedor.');
    expect(await erro(C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at('2026-09-30T13:00:00.000Z')))).toBe('OK');   // a dona consegue
  });
  test('FUP-02 PROTEÇÃO: worklist de outro dia (antes das 06:00 / fim de semana) mantém a atribuição anterior', async () => {
    await db.doc('fila_comercial/worklist').set(worklist('2026-09-25'));    // sexta; hoje é segunda antes da geração
    expect(await erro(C.claimOpportunityHandler(req(ADE, { opportunityInstanceId: OPP.b }), at('2026-09-28T08:00:00.000Z')))).toBe('permission-denied:Oportunidade reservada para outro vendedor.');
  });
  test('FUP-03 regra antiga preservada: atribuída a outro vendedor HOJE continua negada; vendedor sem módulo continua negado', async () => {
    expect(await erro(C.claimOpportunityHandler(req(ADE, { opportunityInstanceId: OPP.a }), at(T_MANHA)))).toBe('permission-denied:Oportunidade atribuída a outro vendedor hoje.');
    expect(await erro(C.claimOpportunityHandler(req(VEN0, { opportunityInstanceId: OPP.a }), at(T_MANHA)))).toMatch(/^permission-denied/);
  });
  test('FUP-04 retorno vencido e sem cooldown volta ao mesmo dono (dono = autor do último resultado)', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'PEDIU_RETORNO', scheduledFor: '2026-09-29' }), at(T_MANHA));
    const d = (await db.doc('interacoes_fila/' + OPP.a).get()).data();
    expect(V.donoDoRetorno(d, Date.parse('2026-09-29T13:00:00Z'))).toBe(FAB);
    expect(V.montarAgenda({ opMap: new Map([[OPP.a, d]]), uid: FAB, hoje: '2026-09-29', agoraMs: Date.parse('2026-09-29T13:00:00Z') }).hoje).toHaveLength(1);
  });
});

describe('Cliente 360 (crmConsulta) — escopo, valores, timeline', () => {
  test('C360-01 vendedora abre cliente da própria lista: resumo, compras sem R$, produtos, timeline, venda após contato, recuperado', async () => {
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'CONVERSA_REALIZADA', nota: 'vai comprar semana que vem' }), at(T_MANHA));
    const r = await Q.crmConsultaHandler(req(FAB, { acao: 'cliente', entidade: ENT.a }), { db, ...at('2026-10-03T13:00:00.000Z') });
    expect(r.podeVerValores).toBe(false);
    expect(r.resumo).toMatchObject({ ultimaCompraEm: '2026-10-02', pedidosTotal: 4 });   // Perfil 360 conta o pedido de valor zero
    expect(r.compras).toHaveLength(4);                                             // lista coerente com o resumo
    expect(r.resumo.valores).toBeUndefined();
    expect(r.compras.every(c => c.valor === undefined)).toBe(true);
    expect(r.produtos.maisComprados[0]).toMatchObject({ nome: 'Lâmpada LED H4' });
    expect(r.observacoes[0]).toMatchObject({ nota: 'vai comprar semana que vem', por: 'Fabiana' });
    expect(r.vendaAposContato[0]).toMatchObject({ relacao: 'APOS', dataVenda: '2026-10-02', diasAposContato: 4 });
    expect(r.recuperado).toMatchObject({ status: 'RECUPERADO_APOS_CONTATO', diasParadoNoContato: 180 });
    expect(r.recuperado.valorVenda).toBeUndefined();
    const tipos = r.timeline.map(e => e.tipo);
    expect(tipos).toEqual(expect.arrayContaining(['VENDA', 'ENTROU_WORKLIST', 'INICIOU', 'RESULTADO']));
    expect(r.timeline[0].tipo).toBe('VENDA');                                   // mais recente primeiro (02/10)
  });
  test('C360-02 gestão vê valores em R$; vendedor de fora do escopo é barrado; sem módulo é barrado; payload validado', async () => {
    const g = await Q.crmConsultaHandler(req(GES, { acao: 'cliente', entidade: ENT.a }), { db, ...at(T_MANHA) });
    expect(g.podeVerValores).toBe(true); expect(g.resumo.valores.faturamentoTotal).toBe(1030);   // 300 + 250 + 480 (+ 0)
    expect(await erro(Q.crmConsultaHandler(req(ADE, { acao: 'cliente', entidade: ENT.a }), { db, ...at(T_MANHA) }))).toBe('permission-denied:CLIENTE_FORA_DO_SEU_ESCOPO');
    expect(await erro(Q.crmConsultaHandler(req(VEN0, { acao: 'cliente', entidade: ENT.a }), { db, ...at(T_MANHA) }))).toBe('permission-denied:SEM_PERMISSAO');
    expect(await erro(Q.crmConsultaHandler(req(FAB, { acao: 'cliente', entidade: 'GC_NATIVE:abc' }), { db, ...at(T_MANHA) }))).toBe('invalid-argument:ENTIDADE_INVALIDA');
    expect(await erro(Q.crmConsultaHandler(req(FAB, { acao: 'apagar' }), { db, ...at(T_MANHA) }))).toBe('invalid-argument:ACAO_INVALIDA');
    expect(await erro(Q.crmConsultaHandler(req(FAB, { acao: 'cliente', entidade: ENT.a, x: 1 }), { db, ...at(T_MANHA) }))).toBe('invalid-argument:CAMPOS_NAO_PERMITIDOS');
    expect(await erro(Q.crmConsultaHandler(req(null, { acao: 'indicadores' }), { db }))).toMatch(/^unauthenticated/);
  });
  test('C360-03 MR4_LINKED: cadastro (cidade/telefone), categorias confiáveis (sem SEM_CATEGORIA), carteira ausente tratada', async () => {
    const r = await Q.crmConsultaHandler(req(FAB, { acao: 'cliente', entidade: ENT.d }), { db, ...at(T_MANHA) });
    expect(r.cliente).toMatchObject({ nome: 'Cliente D', cidade: 'Fortaleza', telefone: '85999990000', gestaoClickId: '99100004' });
    expect(r.produtos.categorias.map(c => c.categoria)).toEqual(['ILUMINAÇÃO', 'SOM']);
    expect(r.resumo.nuncaComprou).toBe(true); expect(r.compras).toEqual([]);
  });
  test('CA-02 cartoes: extras só para o próprio escopo; R$ só para gestão; indicadores do topo', async () => {
    const v = await Q.crmConsultaHandler(req(FAB, { acao: 'cartoes', entidades: [ENT.d, ENT.c] }), { db, ...at(T_MANHA) });
    expect(v.cartoes[ENT.d]).toEqual({ categorias: ['ILUMINAÇÃO', 'SOM'], faixaValor: 'ALTO_VALOR', frequenciaDias: 25 });
    expect(v.negadas).toBe(1);                                                 // ENT.c é do Ademir
    const g = await Q.crmConsultaHandler(req(GES, { acao: 'cartoes', entidades: [ENT.d] }), { db, ...at(T_MANHA) });
    expect(g.cartoes[ENT.d]).toMatchObject({ ticketMedio180d: 800, faturamento180d: 4000 });
    await C.claimOpportunityHandler(req(FAB, { opportunityInstanceId: OPP.a }), at(T_MANHA));
    await C.registerOutcomeHandler(req(FAB, { opportunityInstanceId: OPP.a, outcome: 'CONVERSA_REALIZADA' }), at(T_MANHA));
    const k = await Q.crmConsultaHandler(req(FAB, { acao: 'indicadores' }), { db, ...at('2026-10-02T20:00:00.000Z') });
    expect(k).toMatchObject({ vendedorUid: FAB, vendasAposContato7d: 1, meta: { meta: 20000, realizado: 5000, pct: 25 } });
    const k2 = await Q.crmConsultaHandler(req(FAB, { acao: 'indicadores' }), { db, ...at(T_MANHA) });
    expect(k2.contatosHoje).toBe(1);
    expect(await erro(Q.crmConsultaHandler(req(FAB, { acao: 'indicadores', vendedorUid: ADE }), { db }))).toBe('permission-denied:SEM_PERMISSAO');
  }, 30000);
});
