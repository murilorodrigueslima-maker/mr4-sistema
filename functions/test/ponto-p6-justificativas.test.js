'use strict';
// PONTO — P6: controle de justificativas (evidência obrigatória para batida antiga + alertas). Regras puras (sem emulador).
const fs = require('fs'), path = require('path'), vm = require('vm');
const R = {}; vm.createContext(R); vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8'), R);
const H = '2026-11-16';
const j = (id, data, tipo, hora, extra = {}) => ({ id, funcId: 'F1', data, motivo: 'Ponto não batido — ' + tipo, tipoPonto: tipo, horarioPonto: hora, status: 'aprovado', criadoEm: '2026-11-11T12:20:00.000Z', ...extra });

describe('P6 · evidência para justificativa ANTIGA', () => {
  test('limite: até 3 dias não exige; 4+ dias exige (correção de batida); ocorrência (atestado/home office) nunca', () => {
    expect(R.exigeEvidenciaJustificativa(j('a', '2026-11-13', 'saida', '17:00'), H)).toBe(false);   // 3 dias
    expect(R.exigeEvidenciaJustificativa(j('a', '2026-11-12', 'saida', '17:00'), H)).toBe(true);    // 4 dias
    expect(R.exigeEvidenciaJustificativa({ id: 'x', funcId: 'F1', data: '2026-10-01', motivo: 'Atestado médico', status: 'pendente' }, H)).toBe(false);
    expect(R.exigeEvidenciaJustificativa(j('a', '2026-11-16', 'saida', '17:00'), H)).toBe(false);   // hoje
    expect(R.exigeEvidenciaJustificativa(null, H)).toBe(false); expect(R.exigeEvidenciaJustificativa(j('a', 'x', 'saida', '17:00'), H)).toBe(false);
  });
  test('evidência: descrição ≥ 15 caracteres, anexo ou evidência da gestão; espaços não contam', () => {
    expect(R.temEvidenciaJustificativa({ descricao: 'a'.repeat(14) })).toBe(false);
    expect(R.temEvidenciaJustificativa({ descricao: 'a'.repeat(15) })).toBe(true);
    expect(R.temEvidenciaJustificativa({ descricao: '   ' + 'a'.repeat(10) + '   ' })).toBe(false);
    expect(R.temEvidenciaJustificativa({ anexo: 'data:image/png;base64,AAAA' })).toBe(true);
    expect(R.temEvidenciaJustificativa({ evidenciaGestao: 'gravação das câmeras' })).toBe(true);
    expect(R.temEvidenciaJustificativa({ descricao: '' })).toBe(false); expect(R.temEvidenciaJustificativa(null)).toBe(false);
  });
  test('correção legítima segue possível: a observação do gestor (≥ 15) supre a evidência', () => {
    const velha = j('a', '2026-10-01', 'saida', '17:00', { status: 'pendente' });
    expect(R.evidenciaSuficiente(velha, '')).toBe(false); expect(R.evidenciaSuficiente(velha, 'ok')).toBe(false);
    expect(R.evidenciaSuficiente(velha, 'Conferi com o gerente e as câmeras')).toBe(true);
    expect(R.evidenciaSuficiente({ ...velha, descricao: 'Saí às 17:00 com o gerente presente' }, '')).toBe(true);
  });
});

describe('P6 · alertas (não bloqueiam)', () => {
  const cod = r => r.alertas.map(a => a.codigo);
  test('justificativa antiga sem evidência: alerta ALTO + exigeEvidencia; com descrição: nível médio e sem exigência pendente', () => {
    const a = R.avaliarAlertasJustificativa(j('a', '2026-10-01', 'saida', '17:00', { status: 'pendente' }), { justificativas: [], registros: [], hojeStr: H });
    expect(a).toMatchObject({ exigeEvidencia: true, evidenciaPresente: false, idadeDias: 46 }); expect(a.alertas[0]).toMatchObject({ codigo: 'JUSTIFICATIVA_ANTIGA', nivel: 'alto' });
    const b = R.avaliarAlertasJustificativa(j('a', '2026-10-01', 'saida', '17:00', { status: 'pendente', descricao: 'Saí às 17:00 com o gerente presente' }), { justificativas: [], registros: [], hojeStr: H });
    expect(b.evidenciaPresente).toBe(true); expect(b.alertas[0]).toMatchObject({ codigo: 'JUSTIFICATIVA_ANTIGA', nivel: 'medio' });
  });
  test('horário repetido: ≥ 2 OUTROS dias com o mesmo tipo+horário (rejeitadas não contam; mesmo dia não conta)', () => {
    const base = j('a', '2026-10-21', 'saida_almoco', '13:39', { status: 'pendente' });
    const outras = [j('b', '2026-10-22', 'saida_almoco', '13:39'), j('c', '2026-10-19', 'saida_almoco', '13:39')];
    expect(cod(R.avaliarAlertasJustificativa(base, { justificativas: [base, outras[0]], registros: [], hojeStr: '2026-10-22' }))).not.toContain('HORARIO_REPETIDO');
    const r = R.avaliarAlertasJustificativa(base, { justificativas: [base, ...outras], registros: [], hojeStr: '2026-10-22' });
    expect(cod(r)).toContain('HORARIO_REPETIDO'); expect(r.alertas.find(a => a.codigo === 'HORARIO_REPETIDO').msg).toMatch(/13:39 já foi justificado em 2 outros dias \(19\/10\/2026, 22\/10\/2026\)/);
    expect(cod(R.avaliarAlertasJustificativa(base, { justificativas: [base, { ...outras[0], status: 'rejeitado' }, { ...outras[1], status: 'rejeitado' }], registros: [], hojeStr: '2026-10-22' }))).not.toContain('HORARIO_REPETIDO');
    expect(cod(R.avaliarAlertasJustificativa(base, { justificativas: [base, j('d', '2026-10-21', 'saida_almoco', '13:39'), j('e', '2026-10-21', 'saida_almoco', '13:39')], registros: [], hojeStr: '2026-10-22' }))).not.toContain('HORARIO_REPETIDO');
  });
  test('excesso no mês: quantidade ≥ 8, ou ≥ 3 e ≥ 25% das batidas (inclui pendentes)', () => {
    const regs = Array.from({ length: 12 }, (_, i) => ({ id: 'r' + i, funcId: 'F1', data: '2026-10-' + String(i + 1).padStart(2, '0'), tipo: 'entrada', hora: '08:00:00', ...(i < 4 ? { lancadoPorJustificativa: true } : {}) }));
    const pend = j('p', '2026-10-20', 'saida', '17:00', { status: 'pendente' });
    const r = R.avaliarAlertasJustificativa(pend, { justificativas: [pend], registros: regs, hojeStr: '2026-10-22' });     // 4 aprovadas + 1 pendente = 5 de 13 = 38,5%
    expect(r.resumoMes).toEqual({ porJustificativa: 5, totalBatidas: 13, percentual: 38.5 }); expect(r.alertas.find(a => a.codigo === 'EXCESSO_JUSTIFICATIVAS')).toMatchObject({ nivel: 'alto' });
    const poucas = R.avaliarAlertasJustificativa(pend, { justificativas: [pend], registros: regs.map(x => ({ ...x, lancadoPorJustificativa: undefined })), hojeStr: '2026-10-22' });
    expect(cod(poucas)).not.toContain('EXCESSO_JUSTIFICATIVAS');
    const oito = Array.from({ length: 8 }, (_, i) => j('o' + i, '2026-10-' + String(i + 1).padStart(2, '0'), 'saida', '17:0' + i));
    const grandes = Array.from({ length: 100 }, (_, i) => ({ id: 'g' + i, funcId: 'F1', data: '2026-10-15', tipo: 'entrada', hora: '08:00:00' }));
    expect(cod(R.avaliarAlertasJustificativa(oito[0], { justificativas: oito, registros: grandes, hojeStr: '2026-10-22' }).alertas.length ? R.avaliarAlertasJustificativa(oito[0], { justificativas: oito.map(x => ({ ...x, status: 'pendente' })), registros: grandes, hojeStr: '2026-10-22' }) : { alertas: [] })).toContain('EXCESSO_JUSTIFICATIVAS');
  });
  test('criadas em lote: ≥ 5 no mesmo dia pelo mesmo funcionário', () => {
    const lote = Array.from({ length: 5 }, (_, i) => j('l' + i, '2026-10-0' + (i + 1), 'saida', '17:0' + i));
    expect(cod(R.avaliarAlertasJustificativa(lote[0], { justificativas: lote, registros: [], hojeStr: H }))).toContain('CRIADAS_EM_LOTE');
    expect(cod(R.avaliarAlertasJustificativa(lote[0], { justificativas: lote.slice(0, 4), registros: [], hojeStr: H }))).not.toContain('CRIADAS_EM_LOTE');
  });
  test('almoço sempre 60 min (lançado por justificativa): ≥ 4 dias recentes', () => {
    const pares = [1, 2, 5, 6].flatMap(d => { const dia = '2026-10-0' + d; return [j('s' + d, dia, 'saida_almoco', '12:00'), j('r' + d, dia, 'retorno_almoco', '13:00')]; });
    expect(cod(R.avaliarAlertasJustificativa(pares[0], { justificativas: pares, registros: [], hojeStr: '2026-10-09' }))).toContain('ALMOCO_SEMPRE_60');
    expect(cod(R.avaliarAlertasJustificativa(pares[0], { justificativas: pares.slice(0, 6), registros: [], hojeStr: '2026-10-09' }))).not.toContain('ALMOCO_SEMPRE_60');
  });
  test('função pura: não altera entradas; ignora justificativas de outro funcionário', () => {
    const a = j('a', '2026-10-01', 'saida', '17:00', { status: 'pendente' }); const ctx = { justificativas: [a, { ...j('z', '2026-10-02', 'saida', '17:00'), funcId: 'OUTRO' }], registros: [], hojeStr: H };
    const antes = JSON.stringify([a, ctx]); R.avaliarAlertasJustificativa(a, ctx); expect(JSON.stringify([a, ctx])).toBe(antes);
  });
});

describe('P6 · não altera cálculo de jornada/saldo', () => {
  test('calcDia idêntico com justificativa antiga sem evidência (a regra é de APROVAÇÃO, não de cálculo)', () => {
    const regs = [['entrada', '08:00:00'], ['saida_almoco', '12:00:00'], ['retorno_almoco', '13:00:00'], ['saida', '17:00:00']].map(([t, h]) => ({ funcId: 'F1', data: '2026-10-06', tipo: t, hora: h, lancadoPorJustificativa: t !== 'entrada' }));
    const d = R.calcDia({ id: 'F1', jornada: '8' }, '2026-10-06', regs, null, [j('a', '2026-10-06', 'saida', '17:00')]);
    expect(d).toMatchObject({ status: 'ok', trabalhadoMin: 480, saldoMin: 0 });
  });
});
