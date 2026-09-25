'use strict';
// N35.15 — View-model do frontend (modulos/fila-worklist-view.js). Puro, sem DOM.
const path = require('path');
const V = require(path.join(__dirname, '..', '..', 'modulos', 'fila-worklist-view.js'));

const FAB = 'fab-uid', ADEMIR = 'ademir-uid', OUTRO = 'outro-uid';
const HOJE = '2026-09-25';
const AGORA = Date.parse('2026-09-25T15:00:00.000Z');
const item = (n, o = {}) => ({ opportunityInstanceId: n.toString(16).padStart(16, '0'), commercialEntityId: 'GC_NATIVE:' + n, tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente ' + n, rank: n, ...o });
function doc({ novas = [], followUps = [], emAtendimento = [], data = HOJE } = {}) {
  return { schemaVersion: 'worklist-v2', dataReferencia: data, cap: 10, vendedoresAtivos: [FAB], vendedoresRotulos: { [FAB]: 'FABIANA' }, vendedores: { [FAB]: { novas, followUps, emAtendimento } }, atribuicoes: {} };
}
const op = (o) => ({ estado: 'DISPONIVEL', eventos: [], claimAtual: null, cooledUntil: null, nextFollowUpAt: null, ...o });
const emAt = (uid, iso) => op({ estado: 'EM_ATENDIMENTO', claimAtual: { operadorId: uid, claimadoEm: iso, operadorNome: uid === FAB ? 'Fabiana' : 'Outro' } });
const vend = (d, opMap = new Map(), extra = {}) => V.montarVisaoVendedor({ doc: d, uid: FAB, hoje: HOJE, agoraMs: AGORA, opMap, podeOperar: true, ...extra });

describe('Vendedora', () => {
  test('VW-01 worklist de hoje: 10 novas, todas disponíveis com Iniciar (lazy, sem doc operacional)', () => {
    const v = vend(doc({ novas: Array.from({ length: 10 }, (_, i) => item(i + 1)) }));
    expect(v.novas).toHaveLength(10);
    expect(v.novas.every(x => x.estado.codigo === 'DISPONIVEL' && x.estado.podeIniciar)).toBe(true);
  });
  test('VW-02 vê SOMENTE a própria worklist (outro vendedor → null)', () => {
    const d = doc({ novas: [item(1)] });
    expect(V.montarVisaoVendedor({ doc: d, uid: ADEMIR, hoje: HOJE, agoraMs: AGORA, opMap: new Map(), podeOperar: true })).toBeNull();
  });
  test('VW-03 worklist de outro dia → null (tela volta ao snapshot)', () => {
    expect(vend(doc({ novas: [item(1)], data: '2026-09-24' }))).toBeNull();
  });
  test('VW-04 schema desconhecido → null', () => {
    expect(vend({ ...doc({ novas: [item(1)] }), schemaVersion: 'v1' })).toBeNull();
  });
  test('VW-05 claim próprio ativo → Em atendimento por você, com Registrar/Cancelar', () => {
    const it = item(1);
    const v = vend(doc({ novas: [it] }), new Map([[it.opportunityInstanceId, emAt(FAB, '2026-09-25T14:00:00.000Z')]]));
    expect(v.emAtendimento).toHaveLength(1);
    expect(v.emAtendimento[0].estado).toMatchObject({ codigo: 'EM_ATENDIMENTO_MEU', podeRegistrar: true, podeCancelar: true, podeIniciar: false });
    expect(v.novas).toHaveLength(0);
  });
  test('VW-06 claim expirado (>4h) → volta a Disponível com Iniciar', () => {
    const it = item(1);
    const v = vend(doc({ novas: [it] }), new Map([[it.opportunityInstanceId, emAt(FAB, '2026-09-25T10:00:00.000Z')]]));
    expect(v.novas[0].estado).toMatchObject({ codigo: 'DISPONIVEL', podeIniciar: true });
  });
  test('VW-07 SEM_RESPOSTA hoje → sai da lista ativa, vai para trabalhados com retorno agendado', () => {
    const it = item(1);
    const o = op({ nextFollowUpAt: '2026-09-28', eventos: [{ tipo: 'OUTCOME_REGISTERED', outcome: 'SEM_RESPOSTA', operadorId: FAB }] });
    const v = vend(doc({ novas: [it] }), new Map([[it.opportunityInstanceId, o]]));
    expect(v.novas).toHaveLength(0);
    expect(v.trabalhadasHoje[0].estado).toMatchObject({ codigo: 'RETORNO_AGENDADO', detalhe: '2026-09-28', podeIniciar: false });
  });
  test('VW-08 concluído → trabalhados, sem ações, com rótulo do resultado', () => {
    const it = item(1);
    const o = op({ estado: 'CONCLUIDA', eventos: [{ tipo: 'OUTCOME_REGISTERED', outcome: 'CONVERSA_REALIZADA' }] });
    const v = vend(doc({ novas: [it] }), new Map([[it.opportunityInstanceId, o]]));
    expect(v.trabalhadasHoje[0].estado).toMatchObject({ codigo: 'CONCLUIDA', detalhe: 'Contato realizado', podeIniciar: false });
  });
  test('VW-09 pausa (cooldown) → sem Iniciar', () => {
    const it = item(1);
    const v = vend(doc({ novas: [it] }), new Map([[it.opportunityInstanceId, op({ cooledUntil: '2026-10-25T00:00:00.000Z' })]]));
    expect(v.trabalhadasHoje[0].estado).toMatchObject({ codigo: 'PAUSA', podeIniciar: false });
  });
  test('VW-10 retorno de hoje aparece em Retornos, com Iniciar', () => {
    const it = item(7);
    const o = op({ estado: 'AGUARDANDO_RETORNO', nextFollowUpAt: HOJE });
    const v = vend(doc({ followUps: [it] }), new Map([[it.opportunityInstanceId, o]]));
    expect(v.retornos).toHaveLength(1);
    expect(v.retornos[0].estado.podeIniciar).toBe(true);
    expect(v.contagens.retornos).toBe(1);
  });
  test('VW-11 item sem nome nunca é exibido (nem id, nem "—")', () => {
    const v = vend(doc({ novas: [item(1), item(2, { nomeCliente: null }), item(3, { nomeCliente: '  ' })] }));
    expect(v.novas.map(x => x.item.nomeCliente)).toEqual(['Cliente 1']);
  });
  test('VW-12 sem permissão de operar → nenhum Iniciar', () => {
    const v = vend(doc({ novas: [item(1)] }), new Map(), { podeOperar: false });
    expect(v.novas[0].estado.podeIniciar).toBe(false);
  });
  test('VW-13 item atendido por OUTRO usuário nunca é operável pela vendedora', () => {
    const it = item(1);
    const v = vend(doc({ novas: [it] }), new Map([[it.opportunityInstanceId, emAt(OUTRO, '2026-09-25T14:30:00.000Z')]]));
    const todos = [...v.novas, ...v.retornos, ...v.emAtendimento, ...v.trabalhadasHoje];
    expect(todos[0].estado).toMatchObject({ codigo: 'EM_ATENDIMENTO_OUTRO', podeIniciar: false, podeRegistrar: false, podeCancelar: false });
  });
  test('VW-14 contagens: CAP informado e novas do dia', () => {
    const v = vend(doc({ novas: Array.from({ length: 10 }, (_, i) => item(i + 1)) }));
    expect(v.contagens).toMatchObject({ novas: 10, cap: 10 });
  });
});

describe('Gestão (somente leitura)', () => {
  const ges = (d, opMap = new Map()) => V.montarVisaoGestao({ doc: d, hoje: HOJE, agoraMs: AGORA, opMap });
  test('VG-01 resumo por vendedor com rótulo e contagens', () => {
    const n = Array.from({ length: 10 }, (_, i) => item(i + 1));
    const m = new Map([[n[0].opportunityInstanceId, emAt(FAB, '2026-09-25T14:30:00.000Z')], [n[1].opportunityInstanceId, op({ estado: 'CONCLUIDA', eventos: [] })]]);
    const g = ges(doc({ novas: n, followUps: [item(20)] }), m);
    expect(g).toHaveLength(1);
    expect(g[0].rotulo).toBe('FABIANA');
    expect(g[0].contagens).toMatchObject({ novas: 10, retornos: 1, emAtendimento: 1, concluidas: 1, pendentes: 9 });
  });
  test('VG-02 nenhuma linha operável para gestão', () => {
    const it = item(1);
    const g = ges(doc({ novas: [it, item(2)] }), new Map([[it.opportunityInstanceId, emAt(FAB, '2026-09-25T14:30:00.000Z')]]));
    expect(g[0].linhas.every(l => !l.estado.podeIniciar && !l.estado.podeRegistrar && !l.estado.podeCancelar)).toBe(true);
  });
  test('VG-03 sem worklist de hoje → null', () => {
    expect(ges(doc({ novas: [item(1)], data: '2026-09-24' }))).toBeNull();
  });
});

describe('Datas', () => {
  test('DT-01 dia comercial em America/Fortaleza', () => {
    expect(V.dataComercial(new Date('2026-09-26T02:59:00.000Z'))).toBe('2026-09-25');
    expect(V.dataComercial(new Date('2026-09-26T03:00:00.000Z'))).toBe('2026-09-26');
  });
  test('DT-02 claim ativo até 4h, expirado depois', () => {
    const o = emAt(FAB, '2026-09-25T11:00:01.000Z');
    expect(V.claimAtivo(o, AGORA)).toBe(true);
    expect(V.claimAtivo(emAt(FAB, '2026-09-25T11:00:00.000Z'), AGORA)).toBe(false);
  });
});
