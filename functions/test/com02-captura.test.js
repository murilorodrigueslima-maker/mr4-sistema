'use strict';
// COM-02 — captura mínima (interesse/proposta): máquina de estados, telas e compatibilidade. Puro (sem emulador).
const fs = require('fs'), path = require('path');
const F = require('../lib/filaOperacional');
const W = require('../../modulos/fila-worklist-view.js');
const C = require('../lib/conversaoComercial');

const U = 'u1', T0 = '2026-11-26T13:00:00.000Z', T1 = '2026-11-26T13:05:00.000Z';
const emAtendimento = () => F.claimOportunidade(F.criarEstadoInicial('GC_NATIVE:123456', 'aaaaaaaaaaaaaaaa', 'JANELA_DE_RECOMPRA', T0), U, T0);
const evento = (outcome, meta) => F.registrarOutcome(emAtendimento(), U, outcome, T1, meta).eventos.slice(-1)[0];

describe('normalizarCaptura', () => {
  test('opcional: ausente/nulo não gera campo (nunca vira "NAO")', () => {
    for (const o of Object.values(F.OUTCOMES)) expect(F.normalizarCaptura(o, {})).toEqual({});
    expect(F.normalizarCaptura('CONVERSA_REALIZADA', { interesse: null, proposta: undefined })).toEqual({});
    expect(F.normalizarCaptura('CONVERSA_REALIZADA', undefined)).toEqual({});
  });
  test('valores e compatibilidade com o resultado', () => {
    expect(F.normalizarCaptura('CONVERSA_REALIZADA', { interesse: 'SIM', proposta: 'NAO' })).toEqual({ interesse: 'SIM', proposta: 'NAO' });
    expect(F.normalizarCaptura('SEM_INTERESSE_AGORA', { proposta: 'SIM' })).toEqual({ proposta: 'SIM' });
    expect(() => F.normalizarCaptura('SEM_INTERESSE_AGORA', { interesse: 'SIM' })).toThrow(/não se aplica/);
    expect(() => F.normalizarCaptura('SEM_RESPOSTA', { proposta: 'NAO' })).toThrow(/não se aplica/);
    expect(() => F.normalizarCaptura('CONTATO_INVALIDO', { interesse: 'NAO' })).toThrow(/não se aplica/);
    for (const ruim of [true, 'sim', 'TALVEZ', '', 1]) expect(() => F.normalizarCaptura('CONVERSA_REALIZADA', { interesse: ruim })).toThrow(/SIM ou NAO/);
  });
});

describe('máquina de estados: fluxo atual preservado', () => {
  test('sem captura o evento é idêntico ao de antes (sem meta)', () => {
    expect(evento('CONVERSA_REALIZADA')).toEqual({ tipo: 'OUTCOME_REGISTERED', operadorId: U, outcome: 'CONVERSA_REALIZADA', estadoAntes: 'EM_ATENDIMENTO', estadoDepois: 'CONCLUIDA', timestamp: T1 });
  });
  test('com captura: só acrescenta meta; estado, cooldown e follow-up iguais', () => {
    for (const [o, meta] of [['CONVERSA_REALIZADA', { interesse: 'SIM', proposta: 'SIM' }], ['PEDIU_RETORNO', { interesse: 'NAO', scheduledFor: '2026-12-01' }], ['SEM_INTERESSE_AGORA', { proposta: 'NAO' }]]) {
      const semCampos = { ...meta }; delete semCampos.interesse; delete semCampos.proposta;
      const a = F.registrarOutcome(emAtendimento(), U, o, T1, semCampos), b = F.registrarOutcome(emAtendimento(), U, o, T1, meta);
      expect({ ...b, eventos: null }).toEqual({ ...a, eventos: null });
      expect(b.eventos.slice(-1)[0].meta).toMatchObject(meta);
    }
  });
  test('defesa em profundidade: máquina recusa captura inválida', () => {
    expect(() => evento('SEM_RESPOSTA', { interesse: 'SIM' })).toThrow(/não se aplica/);
    expect(() => evento('CONVERSA_REALIZADA', { proposta: 'x' })).toThrow(/SIM ou NAO/);
  });
  test('o evento gravado é lido pelo funil', () => {
    const est = F.registrarOutcome(emAtendimento(), U, 'CONVERSA_REALIZADA', T1, { interesse: 'SIM', proposta: 'NAO' });
    const t = C.calcularFunil({ estados: [est], vendas: [], opcoes: { dataCorte: '2026-12-31' } }).total;
    expect(t.interesse).toMatchObject({ status: 'MEDIDO', sim: 1, nao: 0 });
    expect(t.proposta).toMatchObject({ status: 'MEDIDO', sim: 0, nao: 1 });
  });
});

describe('telas', () => {
  const crm = fs.readFileSync(path.join(__dirname, '../../modulos/crm.html'), 'utf8');
  const fila = fs.readFileSync(path.join(__dirname, '../../modulos/fila-comercial.html'), 'utf8');
  test('perguntas da tela = regra do servidor, para todos os resultados', () => {
    for (const o of Object.values(F.OUTCOMES)) {
      expect(W.perguntasDoResultado(o).map(q => q.campo).sort()).toEqual(Object.keys(F.CAPTURA_OUTCOMES).filter(c => F.CAPTURA_OUTCOMES[c].includes(o)).sort());
    }
    expect(W.perguntasDoResultado(null)).toEqual([]);
  });
  test('envia só o respondido e aplicável (troca de resultado não vaza resposta antiga)', () => {
    const respostas = { interesse: 'SIM', proposta: 'NAO' };
    expect(W.camposCaptura('CONVERSA_REALIZADA', respostas)).toEqual(respostas);
    expect(W.camposCaptura('SEM_INTERESSE_AGORA', respostas)).toEqual({ proposta: 'NAO' });
    expect(W.camposCaptura('SEM_RESPOSTA', respostas)).toEqual({});
    expect(W.camposCaptura('CONVERSA_REALIZADA', { interesse: '', proposta: null })).toEqual({});
    expect(W.camposCaptura('CONVERSA_REALIZADA', undefined)).toEqual({});
  });
  test('as duas telas usam o auxiliar com proteção para JS antigo em cache; nenhuma pergunta é obrigatória', () => {
    expect(crm).toContain('if (FW.camposCaptura) Object.assign(payload, FW.camposCaptura(sel.resultado, sel));');
    expect(crm).toContain('(opcional)</span>');
    expect(fila).toContain('if (fwv && fwv.camposCaptura) Object.assign(payload, fwv.camposCaptura(modalOutcomeSel, respostasCaptura()));');
    expect(fila).toContain('<option value="">Não informar</option>');
  });
});
