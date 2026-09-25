'use strict';
// N35.14 — Worklist V2: CAP por vendedor, ordenação canônica, D-RETRY, D-RECONTACT,
// concorrência, duplicidades, nomes sob demanda, snapshot com identidade operacional.
// Puro: sem emulador, sem produção.

const {
  ESTADOS, OUTCOMES, criarEstadoInicial, claimOportunidade, registrarOutcome,
  releaseOportunidade, proximoDiaUtil, dataComercial,
} = require('../lib/filaOperacional');
const {
  gerarWorklistPorVendedor, resolverVendedoresAtivos, indiceAtribuicoes, montarDocumentoWorklist,
  gerarDailyWorklist, compararPrioridade, WORKLIST_CAP, resolverParticipantes,
} = require('../lib/dailyWorklist');
const { compararOrdemCanonica } = require('../lib/filaOrdering');
const { filtrarOrdenarFilaHoje, prepararDadosUI, verificarCamposBloqueados } = require('../lib/filaComercialUtils');
const { buildOpportunityInstanceId, buildCommercialEntityId, SOURCES } = require('../lib/commercialIdentity');
const { processarPerfilParaFila } = require('../lib/filaComercialPipeline');
const { resolverNomesSelecionados } = require('../lib/filaNomes');
const QC = require('../lib/filaQueueConfig');
const config = require('../lib/operationalConfig');

const FAB = 'UGXinD3KVXX0ouYEfamBWjizC5C2';
const ADEMIR = 'G9JDOBsquwdth77qgwtXpcjSxYd2';
const CAMILA = 'wVtUJcgwIqQK4VOlYBlREWk8C1Y2';
const MURILO = 'BN8skgBkkbbxQvY1kvsBDLCBo6b2';
const DR = '2026-09-25'; // sexta-feira

let seq = 1;
function cand(o = {}) {
  const n = seq++;
  const ent = o.ent || `GC_NATIVE:${10000000 + n}`;
  const tipo = o.tipo || 'REATIVACAO_120D';
  return {
    commercialEntityId: ent,
    opportunityInstanceId: 'opp' in o ? o.opp : buildOpportunityInstanceId(ent, tipo, o.uc || '2026-01-01'),
    tipoOportunidade: tipo,
    decisaoAcaoComercial: o.decisao || 'AGIR_AGORA',
    prioridade: o.prio ?? 80,
    diasSemComprar: o.dsc ?? 150,
    gestaoClickId: o.gc || null,
    nomeCliente: o.nome ?? null,
    source: ent.startsWith('GC_NATIVE:') ? 'GC_NATIVE' : 'MR4_LINKED',
  };
}
const muitos = (k, o = {}) => Array.from({ length: k }, (_, i) => cand({ ...o, dsc: 1000 - i }));
const wl = (o) => gerarWorklistPorVendedor({ estados: new Map(), vendedoresAtivos: [FAB], dataReferencia: DR, ...o });
const ids = arr => arr.map(x => x.opportunityInstanceId);
function estadoDe(c, passos, t0 = '2026-09-24T12:00:00.000Z') {
  let e = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, t0);
  let t = Date.parse(t0);
  for (const [op, outcome, meta] of passos) {
    t += 60000; e = claimOportunidade(e, op, new Date(t).toISOString());
    if (outcome === 'RELEASE') { t += 60000; e = releaseOportunidade(e, op, new Date(t).toISOString()); continue; }
    if (outcome) { t += 60000; e = registrarOutcome(e, op, outcome, new Date(t).toISOString(), meta || {}); }
  }
  return e;
}
function embaralhar(arr, seed) {
  const a = [...arr]; let s = seed;
  for (let i = a.length - 1; i > 0; i--) { s = (s * 1103515245 + 12345) % 2147483648; const j = s % (i + 1); [a[i], a[j]] = [a[j], a[i]]; }
  return a;
}

// ── Auditoria do canário humano (estado real lido em produção, FASE 8) ──────────
describe('Canário humano (a31a49b109172b18)', () => {
  const REAL = {
    commercialEntityId: 'MR4_LINKED:AimKwxONryOZPpnUVOUH', opportunityInstanceId: 'a31a49b109172b18',
    tipoOportunidade: 'REATIVACAO_120D', estado: 'DISPONIVEL', claimAtual: null, cooledUntil: null, nextFollowUpAt: null,
    eventos: [
      { tipo: 'CLAIMED', operadorId: FAB, estadoAntes: 'DISPONIVEL', estadoDepois: 'EM_ATENDIMENTO', timestamp: '2026-09-25T15:43:26.089Z' },
      { tipo: 'RELEASED', operadorId: FAB, estadoAntes: 'EM_ATENDIMENTO', estadoDepois: 'DISPONIVEL', timestamp: '2026-09-25T15:44:40.424Z' },
    ],
  };
  test('HC-01 claim e release pela Fabiana, uma vez cada', () => {
    expect(REAL.eventos.filter(e => e.tipo === 'CLAIMED').map(e => e.operadorId)).toEqual([FAB]);
    expect(REAL.eventos.filter(e => e.tipo === 'RELEASED').map(e => e.operadorId)).toEqual([FAB]);
  });
  test('HC-02 estado final DISPONIVEL, sem outcome, sem cooldown, sem follow-up', () => {
    expect(REAL.estado).toBe('DISPONIVEL');
    expect(REAL.claimAtual).toBeNull();
    expect(REAL.eventos.some(e => e.tipo === 'OUTCOME_REGISTERED')).toBe(false);
    expect(REAL.cooledUntil).toBeNull();
    expect(REAL.nextFollowUpAt).toBeNull();
  });
  test('HC-03 máquina de estados reproduz o mesmo histórico (claim → release)', () => {
    let e = criarEstadoInicial(REAL.commercialEntityId, REAL.opportunityInstanceId, REAL.tipoOportunidade, '2026-09-24T22:21:04.505Z');
    e = claimOportunidade(e, FAB, REAL.eventos[0].timestamp);
    e = releaseOportunidade(e, FAB, REAL.eventos[1].timestamp);
    expect(e.estado).toBe(REAL.estado);
    expect(e.eventos.map(x => [x.tipo, x.operadorId, x.estadoAntes, x.estadoDepois, x.timestamp])).toEqual(REAL.eventos.map(x => [x.tipo, x.operadorId, x.estadoAntes, x.estadoDepois, x.timestamp]));
  });
  test('HC-04 canário liberado sem outcome volta como canário (fora do CAP), não como nova', () => {
    const c = cand({ ent: REAL.commercialEntityId, opp: REAL.opportunityInstanceId });
    const r = wl({ candidatos: [c, ...muitos(12)], estados: new Map([[c.opportunityInstanceId, REAL]]), canaryIds: QC.CANARY_OPPORTUNITY_IDS });
    expect(ids(r.canarios)).toEqual([c.opportunityInstanceId]);
    expect(r.porVendedor[FAB].newOpportunities).toHaveLength(10);
    expect(ids(r.porVendedor[FAB].newOpportunities)).not.toContain(c.opportunityInstanceId);
  });
});

// ── Snapshot com identidade operacional ────────────────────────────────────────
describe('Snapshot — opportunityInstanceId', () => {
  const CANARIOS = [
    ['a31a49b109172b18', 'MR4_LINKED:AimKwxONryOZPpnUVOUH', '2025-08-07'],
    ['a4ff158c667e74ef', 'MR4_LINKED:jDC32RQVOXrfRyXI9tnB', '2025-06-20'],
    ['c42a7af563da0a06', 'MR4_LINKED:xCKommcUFF6ULOIFbTN2', '2026-01-09'],
    ['f6f744b856019469', 'MR4_LINKED:M6wAPSqRGQVKcMqK76lt', '2024-10-25'],
  ];
  test('SN-01 4/4 canários byte-exact', () => {
    const match = CANARIOS.filter(([opp, ent, uc]) => buildOpportunityInstanceId(ent, 'REATIVACAO_120D', uc) === opp);
    expect(match).toHaveLength(4);
  });
  test('SN-02 lista de canários da config = os 4 documentos existentes', () => {
    expect([...QC.CANARY_OPPORTUNITY_IDS].sort()).toEqual(CANARIOS.map(c => c[0]).sort());
  });
  test('SN-03 id determinístico e independente do nome', async () => {
    const perfil = { clienteMr4Id: 'AimKwxONryOZPpnUVOUH', ultimaCompraEm: '2025-08-07', diasSemComprar: 414, nuncaComprou: false, pedidosTotal: 3, faturamentoTotal: 900, diasEntreComprasMediana: 30 };
    const a = await processarPerfilParaFila(perfil, 'Nome A', { dataReferencia: DR });
    const b = await processarPerfilParaFila(perfil, 'Outro Nome', { dataReferencia: DR });
    expect(a.opportunityInstanceId).toBe(b.opportunityInstanceId);
    if (a.opportunityInstanceId) expect(a.opportunityInstanceId).toMatch(/^[0-9a-f]{16}$/);
  });
  test('SN-04 snapshot publica opportunityInstanceId e NÃO publica commercialEntityId/gestaoClickId/source', () => {
    const ui = prepararDadosUI({ ...cand({ gc: '123' }), clienteMr4Id: 'x' });
    expect(ui.opportunityInstanceId).toMatch(/^[0-9a-f]{16}$/);
    expect(ui).not.toHaveProperty('commercialEntityId');
    expect(ui).not.toHaveProperty('gestaoClickId');
    expect(ui).not.toHaveProperty('source');
    expect(verificarCamposBloqueados({ clientesHoje: [ui] })).toHaveLength(0);
  });
});

// ── Vendedores ativos ─────────────────────────────────────────────────────────
describe('Ativação de vendedores', () => {
  const users = new Map([
    [FAB, { ativo: true, role: 'funcionario' }], [ADEMIR, { ativo: true, role: 'funcionario' }],
    [CAMILA, { ativo: true, role: 'funcionario' }], [MURILO, { ativo: true, role: 'gestor' }],
  ]);
  const FC = { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 };
  const sys = new Map([
    [FAB, { nome: 'Fabiana', modulos: ['catalogo', 'fila-comercial', 'fila-comercial-operar'], admin: false, filaComercial: FC }],
    [ADEMIR, { modulos: ['fila-comercial', 'fila-comercial-operar'], admin: false }],
    [CAMILA, { modulos: ['ponto', 'fila-comercial-gestao'], admin: false }],
    [MURILO, { modulos: ['fila-comercial'], admin: true }],
  ]);
  // N35.17: participação vem da configuração sistema_usuarios.filaComercial (sem lista no código)
  test('SA-01 somente quem tem configuração ativa participa (Fabiana)', () => {
    expect(QC.ACTIVE_QUEUE_SELLERS).toBeUndefined();
    expect(resolverParticipantes(sys, users).participantes.map(p => p.uid)).toEqual([FAB]);
  });
  test('SA-02 Ademir tem fila-comercial-operar mas sem configuração → não participa', () => {
    expect(resolverParticipantes(sys, users).participantes.map(p => p.uid)).not.toContain(ADEMIR);
  });
  test('SA-03 Camila (gestão) configurada por engano é rejeitada: SEM_MODULO_OPERAR', () => {
    const s2 = new Map(sys); s2.set(CAMILA, { ...sys.get(CAMILA), filaComercial: FC });
    const r = resolverParticipantes(s2, users);
    expect(r.participantes.map(p => p.uid)).not.toContain(CAMILA);
    expect(r.rejeitados).toContainEqual({ uid: CAMILA, motivo: 'SEM_MODULO_OPERAR' });
  });
  test('SA-04 gestor (Murilo) configurado não participa: ROLE_NAO_VENDEDOR', () => {
    const s2 = new Map(sys); s2.set(MURILO, { ...sys.get(MURILO), modulos: ['fila-comercial-operar'], filaComercial: FC });
    expect(resolverParticipantes(s2, users).rejeitados).toContainEqual({ uid: MURILO, motivo: 'ROLE_NAO_VENDEDOR' });
  });
  test('SA-05 vendedor configurado bloqueado ou inativo é rejeitado', () => {
    const s2 = new Map(sys); s2.set(FAB, { ...sys.get(FAB), bloqueado: true });
    expect(resolverParticipantes(s2, users).rejeitados[0].motivo).toBe('BLOQUEADO');
    const u2 = new Map(users); u2.set(FAB, { ativo: false, role: 'funcionario' });
    expect(resolverParticipantes(sys, u2).rejeitados[0].motivo).toBe('INATIVO');
  });
  test('SA-06 vendedor não ativo recebe 0 mesmo existindo candidatos', () => {
    const r = wl({ candidatos: muitos(15), vendedoresAtivos: [] });
    expect(Object.keys(r.porVendedor)).toHaveLength(0);
    expect(r.backlog).toHaveLength(15);
  });
});

// ── Ordenação canônica ────────────────────────────────────────────────────────
describe('Ordenação canônica', () => {
  test('OR-01 prioridade DESC', () => { expect([cand({ prio: 70 }), cand({ prio: 95 })].sort(compararOrdemCanonica)[0].prioridade).toBe(95); });
  test('OR-02 diasSemComprar DESC no empate de prioridade', () => { expect([cand({ dsc: 130 }), cand({ dsc: 400 })].sort(compararOrdemCanonica)[0].diasSemComprar).toBe(400); });
  test('OR-03 identidade canônica ASC como desempate final', () => {
    const r = [cand({ ent: 'MR4_LINKED:bbbbbbbbbbbbbbbbbbbb', prio: 90, dsc: 200 }), cand({ ent: 'GC_NATIVE:999', prio: 90, dsc: 200 })].sort(compararOrdemCanonica);
    expect(r[0].commercialEntityId).toBe('GC_NATIVE:999');
  });
  test('OR-04 20 entradas embaralhadas → mesma worklist byte a byte', () => {
    const pop = Array.from({ length: 60 }, (_, i) => cand({ prio: [100, 90, 90, 80][i % 4], dsc: [200, 200, 150][i % 3] }));
    const ref = JSON.stringify(wl({ candidatos: pop }).porVendedor[FAB].worklist);
    let divergencias = 0;
    for (let s = 1; s <= 20; s++) if (JSON.stringify(wl({ candidatos: embaralhar(pop, s) }).porVendedor[FAB].worklist) !== ref) divergencias++;
    expect(divergencias).toBe(0);
  });
  test('OR-05 snapshot HOJE e worklist usam a MESMA ordem', () => {
    const pop = Array.from({ length: 30 }, (_, i) => cand({ prio: [100, 90][i % 2], dsc: [200, 150, 150][i % 3] }));
    const hoje = filtrarOrdenarFilaHoje(embaralhar(pop, 7));
    const w = wl({ candidatos: embaralhar(pop, 11), cap: 30 }).porVendedor[FAB].newOpportunities;
    expect(ids(w)).toEqual(ids(hoje));
  });
  test('OR-06 compararPrioridade legado = canônica para AGIR_AGORA', () => {
    const pop = embaralhar(Array.from({ length: 25 }, (_, i) => cand({ prio: [100, 90][i % 2], dsc: [10, 20, 20][i % 3] })), 3);
    expect(ids([...pop].sort(compararPrioridade))).toEqual(ids([...pop].sort(compararOrdemCanonica)));
  });
});

// ── CAP por vendedor ──────────────────────────────────────────────────────────
describe('CAP por vendedor', () => {
  test('CP-01 config: 10 por vendedor; follow-ups não contam', () => {
    expect(WORKLIST_CAP).toBe(10);
    expect(config.FOLLOWUPS_COUNT_TOWARD_CAP).toBe(false);
  });
  test('CP-02 Fabiana sozinha: no máximo 10 novas', () => {
    const r = wl({ candidatos: muitos(40) });
    expect(r.porVendedor[FAB].newOpportunities).toHaveLength(10);
    expect(r.backlog).toHaveLength(30);
  });
  test('CP-03 10 novas + 3 follow-ups vencidos = 13', () => {
    const fu = muitos(3, { prio: 40 });
    const est = new Map(fu.map(c => [c.opportunityInstanceId, estadoDe(c, [[FAB, OUTCOMES.PEDIU_RETORNO, { scheduledFor: DR }]])]));
    const r = wl({ candidatos: [...fu, ...muitos(20)], estados: est });
    const g = r.porVendedor[FAB];
    expect(g.newOpportunities).toHaveLength(10);
    expect(g.dueFollowUps).toHaveLength(3);
    expect(g.worklist).toHaveLength(13);
    expect(ids(g.worklist.slice(0, 3)).sort()).toEqual(ids(fu).sort());
  });
  test('CP-04 dois vendedores (sintético): ≤10 cada, sem colisão', () => {
    const r = wl({ candidatos: muitos(30), vendedoresAtivos: [FAB, ADEMIR] });
    expect(r.porVendedor[FAB].newOpportunities).toHaveLength(10);
    expect(r.porVendedor[ADEMIR].newOpportunities).toHaveLength(10);
    expect(() => indiceAtribuicoes(r)).not.toThrow();
    const f = new Set(ids(r.porVendedor[FAB].newOpportunities));
    expect(ids(r.porVendedor[ADEMIR].newOpportunities).filter(x => f.has(x))).toHaveLength(0);
  });
  test('CP-05 CAP inválido lança erro', () => {
    expect(() => wl({ candidatos: [], cap: 0 })).toThrow();
  });
});

// ── SEM_RESPOSTA / follow-up ──────────────────────────────────────────────────
describe('SEM_RESPOSTA e follow-up', () => {
  test('SR-01 próximo dia útil: seg→ter … sex→seg, sáb/dom→seg', () => {
    expect(proximoDiaUtil('2026-09-21')).toBe('2026-09-22');
    expect(proximoDiaUtil('2026-09-22')).toBe('2026-09-23');
    expect(proximoDiaUtil('2026-09-23')).toBe('2026-09-24');
    expect(proximoDiaUtil('2026-09-24')).toBe('2026-09-25');
    expect(proximoDiaUtil('2026-09-25')).toBe('2026-09-28');
    expect(proximoDiaUtil('2026-09-26')).toBe('2026-09-28');
    expect(proximoDiaUtil('2026-09-27')).toBe('2026-09-28');
  });
  test('SR-02 dia comercial em America/Fortaleza (23h local ainda é o mesmo dia)', () => {
    expect(dataComercial('2026-09-26T01:30:00.000Z')).toBe('2026-09-25');
  });
  test('SR-03 SEM_RESPOSTA #1 → próximo dia útil, estado DISPONIVEL, sem cooldown', () => {
    const e = estadoDe(cand(), [[FAB, OUTCOMES.SEM_RESPOSTA]], '2026-09-25T13:00:00.000Z');
    expect(e.nextFollowUpAt).toBe('2026-09-28');
    expect(e.estado).toBe(ESTADOS.DISPONIVEL);
    expect(e.cooledUntil).toBeNull();
  });
  test('SR-04 SEM_RESPOSTA #2 → próximo dia útil novamente', () => {
    const e = estadoDe(cand(), [[FAB, OUTCOMES.SEM_RESPOSTA], [FAB, OUTCOMES.SEM_RESPOSTA]], '2026-09-28T13:00:00.000Z');
    expect(e.nextFollowUpAt).toBe('2026-09-29');
    expect(e.cooledUntil).toBeNull();
  });
  test('SR-05 SEM_RESPOSTA #3 → cooldown 30 dias e SEM follow-up', () => {
    const e = estadoDe(cand(), [[FAB, OUTCOMES.SEM_RESPOSTA], [FAB, OUTCOMES.SEM_RESPOSTA], [FAB, OUTCOMES.SEM_RESPOSTA]], '2026-09-28T13:00:00.000Z');
    expect(e.nextFollowUpAt).toBeNull();
    const dias = (Date.parse(e.cooledUntil) - Date.parse(e.eventos[e.eventos.length - 1].timestamp)) / 86400000;
    expect(dias).toBe(config.SEM_RESPOSTA_COOLDOWN_DAYS);
  });
  test('SR-06 retry vencido → mesmo vendedor, fora do CAP', () => {
    const c = cand({ prio: 40 });
    const e = estadoDe(c, [[FAB, OUTCOMES.SEM_RESPOSTA]], '2026-09-24T13:00:00.000Z'); // retry em 25/09
    const r = wl({ candidatos: [c, ...muitos(15)], estados: new Map([[c.opportunityInstanceId, e]]) });
    expect(ids(r.porVendedor[FAB].dueFollowUps)).toEqual([c.opportunityInstanceId]);
    expect(r.porVendedor[FAB].newOpportunities).toHaveLength(10);
    expect(ids(r.porVendedor[FAB].newOpportunities)).not.toContain(c.opportunityInstanceId);
  });
  test('SR-07 retry ainda não vencido → fora de follow-ups E de novas', () => {
    const c = cand({ prio: 100 });
    const e = estadoDe(c, [[FAB, OUTCOMES.SEM_RESPOSTA]], '2026-09-25T13:00:00.000Z'); // retry em 28/09
    const r = wl({ candidatos: [c], estados: new Map([[c.opportunityInstanceId, e]]) });
    expect(r.porVendedor[FAB].worklist).toHaveLength(0);
    expect(r.excluidos.FOLLOWUP_FUTURO).toEqual([c.opportunityInstanceId]);
  });
  test('SR-08 follow-up de outro vendedor não aparece para quem não é o dono', () => {
    const c = cand();
    const e = estadoDe(c, [[ADEMIR, OUTCOMES.PEDIU_RETORNO, { scheduledFor: DR }]]);
    const r = wl({ candidatos: [c], estados: new Map([[c.opportunityInstanceId, e]]), vendedoresAtivos: [FAB, ADEMIR] });
    expect(ids(r.porVendedor[ADEMIR].dueFollowUps)).toEqual([c.opportunityInstanceId]);
    expect(r.porVendedor[FAB].worklist).toHaveLength(0);
  });
  test('SR-09 follow-up vencido de dono inativo fica separado (sem reatribuição automática)', () => {
    const c = cand();
    const e = estadoDe(c, [[ADEMIR, OUTCOMES.PEDIU_RETORNO, { scheduledFor: DR }]]);
    const r = wl({ candidatos: [c], estados: new Map([[c.opportunityInstanceId, e]]) });
    expect(r.porVendedor[FAB].worklist).toHaveLength(0);
    expect(r.followUpsSemDonoAtivo.map(x => x.donoOriginal)).toEqual([ADEMIR]);
  });
  test('SR-10 follow-up pendente bloqueia a entidade como nova mesmo com nova instância', () => {
    const velho = cand({ ent: 'GC_NATIVE:700', tipo: 'JANELA_DE_RECOMPRA' });
    const novo = cand({ ent: 'GC_NATIVE:700', tipo: 'REATIVACAO_120D' });
    const e = estadoDe(velho, [[FAB, OUTCOMES.PEDIU_RETORNO, { scheduledFor: '2026-10-05' }]]);
    const r = wl({ candidatos: [novo], estados: new Map([[velho.opportunityInstanceId, e]]) });
    expect(r.porVendedor[FAB].worklist).toHaveLength(0);
  });
  test('SR-11 legado: follow-up futuro não reaparece como nova (bug N35.13 corrigido)', () => {
    const c = cand();
    const e = estadoDe(c, [[FAB, OUTCOMES.PEDIU_RETORNO, { scheduledFor: '2026-09-30' }]]);
    const r = gerarDailyWorklist({ clientesHoje: [c], estadosOperacionais: new Map([[c.opportunityInstanceId, e]]), operadorId: FAB, dataReferencia: '2026-09-26' });
    expect(r.newOpportunities).toHaveLength(0);
  });
});

// ── Supressão por entidade ────────────────────────────────────────────────────
describe('Supressão por entidade (RECONTACT_SUPPRESSION_DAYS=30)', () => {
  const cenario = (diaIso) => {
    const janela = cand({ ent: 'MR4_LINKED:xCKommcUFF6ULOIFbTN2', tipo: 'JANELA_DE_RECOMPRA' });
    const reat = cand({ ent: 'MR4_LINKED:xCKommcUFF6ULOIFbTN2', tipo: 'REATIVACAO_120D' });
    const e = estadoDe(janela, [[FAB, OUTCOMES.CONVERSA_REALIZADA]], '2026-09-01T12:00:00.000Z');
    return { reat, r: wl({ candidatos: [reat], estados: new Map([[janela.opportunityInstanceId, e]]), dataReferencia: diaIso }) };
  };
  test('SU-01 config', () => { expect(config.RECONTACT_SUPPRESSION_DAYS).toBe(30); });
  test('SU-02 dia 10: tipo muda (novo opportunityInstanceId) → continua suprimido', () => {
    const { reat, r } = cenario('2026-09-11');
    expect(r.porVendedor[FAB].newOpportunities).toHaveLength(0);
    expect(r.excluidos.RECONTACT_SUPPRESSION).toEqual([reat.opportunityInstanceId]);
  });
  test('SU-03 dia 29: ainda suprimido', () => { expect(cenario('2026-09-30').r.porVendedor[FAB].newOpportunities).toHaveLength(0); });
  test('SU-04 dia 31: volta a ser elegível', () => {
    const { reat, r } = cenario('2026-10-02');
    expect(ids(r.porVendedor[FAB].newOpportunities)).toEqual([reat.opportunityInstanceId]);
  });
  test('SU-05 a mesma instância encerrada nunca reaparece (máquina não permite novo claim)', () => {
    const c = cand();
    const e = estadoDe(c, [[FAB, OUTCOMES.CONVERSA_REALIZADA]], '2026-08-01T12:00:00.000Z');
    const r = wl({ candidatos: [c], estados: new Map([[c.opportunityInstanceId, e]]) });
    expect(r.excluidos.CONCLUIDA_MESMA_INSTANCIA).toEqual([c.opportunityInstanceId]);
  });
  test('SU-06 SEM_INTERESSE suprime a entidade inteira', () => {
    const a = cand({ ent: 'GC_NATIVE:808', tipo: 'QUEDA_DE_COMPRAS' });
    const b = cand({ ent: 'GC_NATIVE:808', tipo: 'REATIVACAO_120D' });
    const e = estadoDe(a, [[FAB, OUTCOMES.SEM_INTERESSE_AGORA]]);
    expect(wl({ candidatos: [b], estados: new Map([[a.opportunityInstanceId, e]]) }).porVendedor[FAB].worklist).toHaveLength(0);
  });
  test('SU-07 3× SEM_RESPOSTA suprime a entidade inteira por 30 dias', () => {
    const a = cand({ ent: 'GC_NATIVE:909' });
    const b = cand({ ent: 'GC_NATIVE:909', tipo: 'QUEDA_DE_COMPRAS' });
    const e = estadoDe(a, [[FAB, OUTCOMES.SEM_RESPOSTA], [FAB, OUTCOMES.SEM_RESPOSTA], [FAB, OUTCOMES.SEM_RESPOSTA]]);
    const r = wl({ candidatos: [a, b], estados: new Map([[a.opportunityInstanceId, e]]) });
    expect(r.porVendedor[FAB].worklist).toHaveLength(0);
    expect(r.excluidos.COOLDOWN).toHaveLength(1);
  });
});

// ── Concorrência ──────────────────────────────────────────────────────────────
describe('Concorrência / claim', () => {
  test('CC-01 EM_ATENDIMENTO por A: aparece só para A (emAtendimento), nunca para B', () => {
    const c = cand({ prio: 100 });
    let e = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, '2026-09-25T12:00:00.000Z');
    e = claimOportunidade(e, ADEMIR, '2026-09-25T12:00:00.000Z');
    const r = wl({ candidatos: [c, ...muitos(3)], estados: new Map([[c.opportunityInstanceId, e]]), vendedoresAtivos: [FAB, ADEMIR], agoraIso: '2026-09-25T13:00:00.000Z' });
    expect(ids(r.porVendedor[ADEMIR].emAtendimento)).toEqual([c.opportunityInstanceId]);
    expect(ids(r.porVendedor[FAB].worklist)).not.toContain(c.opportunityInstanceId);
    expect(ids(r.porVendedor[ADEMIR].newOpportunities)).not.toContain(c.opportunityInstanceId);
  });
  test('CC-02 EM_ATENDIMENTO por vendedor não ativo: não disponível para ninguém', () => {
    const c = cand();
    let e = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, '2026-09-25T12:00:00.000Z');
    e = claimOportunidade(e, ADEMIR, '2026-09-25T12:00:00.000Z');
    const r = wl({ candidatos: [c], estados: new Map([[c.opportunityInstanceId, e]]), agoraIso: '2026-09-25T13:00:00.000Z' });
    expect(r.porVendedor[FAB].worklist).toHaveLength(0);
    expect(r.excluidos.EM_ATENDIMENTO).toEqual([c.opportunityInstanceId]);
  });
  test('CC-03 claim expirado (>4h) volta a ser elegível', () => {
    const c = cand();
    let e = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, '2026-09-25T08:00:00.000Z');
    e = claimOportunidade(e, ADEMIR, '2026-09-25T08:00:00.000Z');
    const r = wl({ candidatos: [c], estados: new Map([[c.opportunityInstanceId, e]]), agoraIso: '2026-09-25T12:30:00.000Z' });
    expect(ids(r.porVendedor[FAB].newOpportunities)).toEqual([c.opportunityInstanceId]);
  });
  test('CC-04 release sem outcome devolve à fila de novas', () => {
    const c = cand();
    const e = estadoDe(c, [[FAB, 'RELEASE']]);
    expect(ids(wl({ candidatos: [c], estados: new Map([[c.opportunityInstanceId, e]]) }).porVendedor[FAB].newOpportunities)).toEqual([c.opportunityInstanceId]);
  });
  test('CC-05 legado sem operadorId: atendimento em curso NÃO aparece como disponível (bug N35.13)', () => {
    const c = cand();
    let e = criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, '2026-09-25T12:00:00.000Z');
    e = claimOportunidade(e, ADEMIR, '2026-09-25T12:00:00.000Z');
    const r = gerarDailyWorklist({ clientesHoje: [c], estadosOperacionais: new Map([[c.opportunityInstanceId, e]]), dataReferencia: DR });
    expect(r.newOpportunities).toHaveLength(0);
  });
  test('CC-06 documento de worklist: só IDs, atribuição única por oportunidade', () => {
    const r = wl({ candidatos: muitos(12), vendedoresAtivos: [FAB, ADEMIR] });
    const doc = montarDocumentoWorklist(r, '2026-09-25T09:00:00.000Z');
    expect(Object.keys(doc.atribuicoes)).toHaveLength(12);
    expect(JSON.stringify(doc)).not.toMatch(/nomeCliente|cpf|cnpj|telefone|email/i);
    for (const a of Object.values(doc.atribuicoes)) expect([FAB, ADEMIR]).toContain(a.uid);
  });
});

// ── Duplicidades ──────────────────────────────────────────────────────────────
describe('Duplicidades GC', () => {
  test('DU-01 config: 11 grupos, 22 IDs distintos', () => {
    expect(QC.DUPLICATE_GC_GROUPS).toHaveLength(11);
    expect(new Set(QC.DUPLICATE_GC_IDS).size).toBe(22);
  });
  test('DU-02 os 22 IDs GC_NATIVE são excluídos', () => {
    const cands = QC.DUPLICATE_GC_IDS.map(id => cand({ ent: `GC_NATIVE:${id}` }));
    const r = wl({ candidatos: cands, duplicateGcIds: QC.DUPLICATE_GC_IDS });
    expect(r.porVendedor[FAB].worklist).toHaveLength(0);
    expect(r.excluidos.DUPLICATA_GC).toHaveLength(22);
  });
  test('DU-03 MR4_LINKED vinculado a GC duplicado também é excluído', () => {
    const r = wl({ candidatos: [cand({ ent: 'MR4_LINKED:abcdefghijABCDEFGHIJ', gc: '44553294' })], duplicateGcIds: QC.DUPLICATE_GC_IDS });
    expect(r.excluidos.DUPLICATA_GC).toHaveLength(1);
  });
  test('DU-04 MR4_LINKED com GC NÃO duplicado permanece (sem exclusão indevida)', () => {
    const r = wl({ candidatos: [cand({ ent: 'MR4_LINKED:abcdefghijABCDEFGHIJ', gc: '12345678' })], duplicateGcIds: QC.DUPLICATE_GC_IDS });
    expect(r.porVendedor[FAB].newOpportunities).toHaveLength(1);
  });
  test('DU-05 mesma entidade com duas instâncias → uma só (a melhor)', () => {
    const r = wl({ candidatos: [cand({ ent: 'GC_NATIVE:5', prio: 60 }), cand({ ent: 'GC_NATIVE:5', prio: 99, tipo: 'QUEDA_DE_COMPRAS' })] });
    expect(r.porVendedor[FAB].newOpportunities.map(x => x.prioridade)).toEqual([99]);
  });
  test('DU-06 nomes iguais em entidades diferentes → ambas; identidade inválida → excluída', () => {
    const r = wl({ candidatos: [cand({ nome: 'JOSE' }), cand({ nome: 'JOSE' }), cand({ opp: 'NAO-HEX' }), cand({ ent: 'FOO:1' })] });
    expect(r.porVendedor[FAB].newOpportunities).toHaveLength(2);
    expect(r.excluidos.IDENTIDADE_INVALIDA).toHaveLength(2);
  });
});

// ── Nomes GC_NATIVE sob demanda ───────────────────────────────────────────────
describe('Nomes sob demanda', () => {
  test('NM-01 lookup só para itens sem nome; identidade intacta', async () => {
    const itens = [cand({ gc: '1', nome: 'JA TEM' }), cand({ gc: '2' }), cand({ gc: '3' })];
    const chamadas = [];
    const r = await resolverNomesSelecionados(itens, { lookupNome: async gc => { chamadas.push(gc); return 'Cliente ' + gc; } });
    expect(chamadas).toEqual(['2', '3']);
    expect(r.itens.map(x => x.commercialEntityId)).toEqual(itens.map(x => x.commercialEntityId));
    expect(r.itens.map(x => x.opportunityInstanceId)).toEqual(itens.map(x => x.opportunityInstanceId));
  });
  test('NM-02 teto de lookups respeitado', async () => {
    const itens = Array.from({ length: 30 }, (_, i) => cand({ gc: String(i + 1) }));
    let n = 0;
    const r = await resolverNomesSelecionados(itens, { lookupNome: async () => { n++; return 'x'; }, max: 10 });
    expect(n).toBe(10);
    expect(r.naoResolvidos).toBe(20);
  });
  test('NM-04 adaptador GC: GET /clientes/{id}, devolve só o nome, ignora id divergente', async () => {
    const { criarLookupNomeGC } = require('../lib/filaNomes');
    const chamadas = [];
    const fetchImpl = async (url, opts) => {
      chamadas.push({ url, headers: Object.keys(opts.headers) });
      const id = url.split('/').pop();
      return { ok: true, json: async () => ({ data: { id: id === '555' ? '999' : id, nome: 'Pessoa', razao_social: 'Loja X LTDA', nome_fantasia: '', cpf_cnpj: '00000000000', telefone: '85999999999' } }) };
    };
    const lookup = criarLookupNomeGC({ accessToken: 'a', secretToken: 'b', fetchImpl });
    expect(await lookup('123')).toBe('Loja X LTDA');
    expect(await lookup('555')).toBeNull();
    expect(await lookup('abc')).toBeNull();
    expect(chamadas.map(c => c.url)).toEqual(['https://api.gestaoclick.com/clientes/123', 'https://api.gestaoclick.com/clientes/555']);
    expect(() => criarLookupNomeGC({ accessToken: '', secretToken: 'b', fetchImpl })).toThrow();
  });
  test('NM-03 falha no lookup não quebra nem altera identidade', async () => {
    const r = await resolverNomesSelecionados([cand({ gc: '9' })], { lookupNome: async () => { throw new Error('GC down'); } });
    expect(r.itens[0].nameResolved).toBe('FALHOU');
    expect(r.itens[0].nomeCliente).toBeNull();
  });
});

// ── Simulação D+1 sintética (FASE 21) ─────────────────────────────────────────
describe('D+1', () => {
  test('DP-01 SEM_RESPOSTA / PR vencido / PR futuro / concluído / troca de tipo / em atendimento / novos', () => {
    const base = muitos(30);
    const D0 = '2026-09-24'; // quinta
    const d0 = wl({ candidatos: base, dataReferencia: D0 });
    const F = d0.porVendedor[FAB].newOpportunities;
    const est = new Map();
    const t = h => `${D0}T${h}:00:00.000Z`;
    const aplicar = (c, fn) => est.set(c.opportunityInstanceId, fn(criarEstadoInicial(c.commercialEntityId, c.opportunityInstanceId, c.tipoOportunidade, t('11'))));
    aplicar(F[0], e => registrarOutcome(claimOportunidade(e, FAB, t('12')), FAB, OUTCOMES.SEM_RESPOSTA, t('13')));
    aplicar(F[1], e => registrarOutcome(claimOportunidade(e, FAB, t('12')), FAB, OUTCOMES.PEDIU_RETORNO, t('13'), { scheduledFor: '2026-09-25' }));
    aplicar(F[2], e => registrarOutcome(claimOportunidade(e, FAB, t('12')), FAB, OUTCOMES.PEDIU_RETORNO, t('13'), { scheduledFor: '2026-10-01' }));
    aplicar(F[3], e => registrarOutcome(claimOportunidade(e, FAB, t('12')), FAB, OUTCOMES.CONVERSA_REALIZADA, t('13')));
    aplicar(F[4], e => claimOportunidade(e, FAB, '2026-09-25T13:30:00.000Z'));
    const trocaTipo = { ...F[3], tipoOportunidade: 'REATIVACAO_120D', opportunityInstanceId: buildOpportunityInstanceId(F[3].commercialEntityId, 'REATIVACAO_120D', '2026-01-01') };
    const novosClientes = muitos(5, { prio: 99 });
    const cands1 = [...base.filter(c => c !== F[3]), trocaTipo, ...novosClientes];
    const r = wl({ candidatos: cands1, estados: est, dataReferencia: '2026-09-25', agoraIso: '2026-09-25T14:00:00.000Z' });
    const g = r.porVendedor[FAB];
    const tem = (arr, c) => ids(arr).includes(c.opportunityInstanceId);
    expect(tem(g.dueFollowUps, F[0])).toBe(true);                       // SEM_RESPOSTA próximo dia útil, mesmo vendedor
    expect(tem(g.newOpportunities, F[0])).toBe(false);                  // fora do CAP
    expect(tem(g.dueFollowUps, F[1])).toBe(true);                       // PR vencido
    expect([...g.worklist, ...g.emAtendimento].some(x => x.commercialEntityId === F[2].commercialEntityId)).toBe(false); // PR futuro
    expect(g.worklist.some(x => x.commercialEntityId === F[3].commercialEntityId)).toBe(false);                          // concluído + troca de tipo
    expect(tem(g.emAtendimento, F[4])).toBe(true);                      // atendimento ativo mantido com o dono
    expect(tem(g.newOpportunities, F[4])).toBe(false);
    expect(g.newOpportunities.length).toBeLessThanOrEqual(10);
    expect(ids(g.newOpportunities).filter(x => ids(novosClientes).includes(x))).toHaveLength(5); // novos entram pela prioridade
  });
});
