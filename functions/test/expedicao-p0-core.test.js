'use strict';
// Expedição P0 — núcleo da máquina de estados (js/expedicao-core.js), sem emulador. Fixtures sintéticas.
const fs = require('fs'), path = require('path');
const C = require('../../js/expedicao-core.js');

const ctx = (o = {}) => ({ uid: 'u1', papel: 'funcionario', agoraMs: 1_700_000_000_000, origem: 't', serverTimestamp: () => '__TS__', ...o });
const ped = (coluna, o = {}) => ({ numero: '1000001', coluna, versao: 3, envio: null, saidaEm: null, ...o });
const COLS = ['ag', 'se', 'pr', 'de', 'cancelado'];

describe('tabela de transições (fluxo normal)', () => {
  test('matriz 5×5 exata: só ag→se, se→pr, pr→de e ag|se|pr→cancelado', () => {
    const permitidas = new Set(['ag>se', 'se>pr', 'pr>de', 'ag>cancelado', 'se>cancelado', 'pr>cancelado']);
    for (const de of COLS) for (const para of COLS) expect(C.isValidExpeditionTransition(de, para)).toBe(permitidas.has(de + '>' + para));
  });
  test('pulos proibidos: ag→pr, ag→de, se→de; regressões proibidas; despachado e cancelado terminais', () => {
    for (const [de, para] of [['ag', 'pr'], ['ag', 'de'], ['se', 'de'], ['se', 'ag'], ['pr', 'se'], ['pr', 'ag'], ['de', 'pr'], ['de', 'se'], ['de', 'ag'], ['de', 'cancelado'], ['cancelado', 'ag'], ['cancelado', 'se'], ['cancelado', 'pr'], ['cancelado', 'de']])
      expect(C.isValidExpeditionTransition(de, para)).toBe(false);
  });
  test('as Rules espelham a mesma tabela (texto da função isValidExpeditionTransition)', () => {
    const rules = fs.readFileSync(path.join(__dirname, '../../modulos/firestore.rules'), 'utf8');
    const f = rules.slice(rules.indexOf('function isValidExpeditionTransition'), rules.indexOf('function expEnvioValido'));
    expect(f).toMatch(/de == 'ag' && para == 'se'/); expect(f).toMatch(/de == 'se' && para == 'pr'/); expect(f).toMatch(/de == 'pr' && para == 'de'/);
    expect(f).toMatch(/de in \['ag', 'se', 'pr'\] && para == 'cancelado'/);
    expect((f.match(/para ==/g) || []).length).toBe(4);
  });
});

describe('planejarTransicao', () => {
  test('STALE_STATE: a tela acredita "se", o servidor tem "de" → nada planejado, devolve a verdade', () => {
    try { C.planejarTransicao(ped('de'), 'se', 'MARCAR_SEPARADO', {}, ctx()); throw new Error('não lançou'); }
    catch (e) { expect(e.codigo).toBe('STALE_STATE'); expect(e.atual.coluna).toBe('de'); }
  });
  test('ação fora do estado (mesmo com a tela "certa") → TRANSICAO_INVALIDA', () => {
    for (const [col, acao] of [['de', 'INICIAR_SEPARACAO'], ['de', 'MARCAR_SEPARADO'], ['de', 'DESPACHAR'], ['de', 'CANCELAR'], ['cancelado', 'INICIAR_SEPARACAO'], ['cancelado', 'REABRIR'], ['ag', 'MARCAR_SEPARADO'], ['ag', 'DESPACHAR'], ['se', 'DESPACHAR']]) {
      expect(() => C.planejarTransicao(ped(col), col, acao, { envio: 'retirada', motivo: 'motivo ok' }, ctx({ papel: 'gestor' }))).toThrow('TRANSICAO_INVALIDA');
    }
  });
  test('campos da transição: versão+1, evento v{versão}, carimbo do servidor, só os campos necessários', () => {
    const p = C.planejarTransicao(ped('pr'), 'pr', 'DESPACHAR', { envio: 'rota-tarde' }, ctx());
    expect(p.update).toEqual({ coluna: 'de', versao: 4, ultimoEventoId: 'v4', atualizadoEm: '__TS__', atualizadoPor: 'u1', movidoEm: 1_700_000_000_000, envio: 'rota-tarde', saidaEm: 1_700_000_000_000 });
    expect(p.eventoId).toBe('v4');
    expect(p.evento).toEqual({ pedido: '1000001', de: 'pr', para: 'de', acao: 'DESPACHAR', versao: 4, em: '__TS__', por: 'u1', origem: 't' });
    expect(C.planejarTransicao(ped('se', { versao: undefined }), 'se', 'MARCAR_SEPARADO', {}, ctx()).update.versao).toBe(1);   // documento antigo sem versão
  });
  test('REABRIR: só gestor, motivo 5–200, zera envio/saída e registra quem/por quê', () => {
    expect(() => C.planejarTransicao(ped('de'), 'de', 'REABRIR', { motivo: 'cliente devolveu' }, ctx())).toThrow('SEM_PERMISSAO');
    expect(() => C.planejarTransicao(ped('de'), 'de', 'REABRIR', { motivo: 'x' }, ctx({ papel: 'gestor' }))).toThrow('DADOS_INVALIDOS');
    const p = C.planejarTransicao(ped('de', { envio: 'retirada', saidaEm: 1 }), 'de', 'REABRIR', { motivo: '  cliente devolveu  ' }, ctx({ papel: 'gestor' }));
    expect(p.update).toMatchObject({ coluna: 'ag', envio: null, saidaEm: null, reabertura: { motivo: 'cliente devolveu', por: 'u1', em: '__TS__' } });
    expect(p.evento).toMatchObject({ acao: 'REABRIR', de: 'de', para: 'ag', motivo: 'cliente devolveu' });
  });
  test('envio obrigatório e da lista em INICIAR_SEPARACAO/DESPACHAR', () => {
    expect(() => C.planejarTransicao(ped('ag'), 'ag', 'INICIAR_SEPARACAO', {}, ctx())).toThrow('DADOS_INVALIDOS');
    expect(() => C.planejarTransicao(ped('pr'), 'pr', 'DESPACHAR', { envio: 'drone' }, ctx())).toThrow('DADOS_INVALIDOS');
  });
});

describe('executarAcao (adaptador falso)', () => {
  function banco(inicial) {
    const docs = { '1000001': { ...inicial } }, eventos = [];
    return { docs, eventos, adapter: { transacao: async fn => { const w = []; const r = await fn({ ler: async n => (docs[n] ? { ...docs[n] } : null), atualizar: (n, c) => w.push(() => { docs[n] = { ...docs[n], ...c }; }), criarEvento: (n, id, d) => w.push(() => eventos.push({ n, id, d })) }); w.forEach(f => f()); return r; } } };
  }
  test('sucesso: exatamente 1 atualização + 1 evento', async () => {
    const b = banco(ped('ag', { versao: 0 }));
    const r = await C.executarAcao(b.adapter, '1000001', 'INICIAR_SEPARACAO', 'ag', { envio: 'retirada' }, ctx());
    expect(r).toEqual({ de: 'ag', para: 'se', versao: 1, eventoId: 'v1' }); expect(b.docs['1000001'].coluna).toBe('se'); expect(b.eventos).toHaveLength(1);
  });
  test('recusa (stale/terminal): nenhuma escrita e nenhum evento', async () => {
    const b = banco(ped('de'));
    await expect(C.executarAcao(b.adapter, '1000001', 'MARCAR_SEPARADO', 'se', {}, ctx())).rejects.toMatchObject({ codigo: 'STALE_STATE' });
    await expect(C.executarAcao(b.adapter, '1000001', 'INICIAR_SEPARACAO', 'de', { envio: 'retirada' }, ctx())).rejects.toMatchObject({ codigo: 'TRANSICAO_INVALIDA' });
    expect(b.docs['1000001'].coluna).toBe('de'); expect(b.eventos).toHaveLength(0);
  });
});

describe('escopo da tela', () => {
  test('noBoard: ativos sempre; despachado só hoje (Fortaleza); cancelado nunca', () => {
    const agora = Date.parse('2026-09-29T15:00:00Z');   // 12:00 em Fortaleza
    const ini = C.inicioDoDiaFortaleza(agora);
    expect(new Date(ini).toISOString()).toBe('2026-09-29T03:00:00.000Z');
    expect(C.noBoard({ coluna: 'se' }, agora)).toBe(true);
    expect(C.noBoard({ coluna: 'de', saidaEm: ini + 1 }, agora)).toBe(true);
    expect(C.noBoard({ coluna: 'de', saidaEm: ini - 1 }, agora)).toBe(false);
    expect(C.noBoard({ coluna: 'cancelado', saidaEm: ini + 1 }, agora)).toBe(false);
  });
});
