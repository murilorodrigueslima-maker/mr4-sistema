'use strict';
// DIA_SEM_INTERVALO: jornada contínua em DIA ÚTIL reconhecida só por autorização individual (funcionário + data). Motor puro; dados sintéticos.
const fs = require('fs'), path = require('path'), vm = require('vm');
const { M } = require('../lib/pontoBanco');                       // motor do servidor (cópia)
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8') + ';this.calcDia=calcDia;this.calcTotal=calcTotal;', ctx);   // motor do front-end
const MOTORES = { frontend: ctx, servidor: M };
const H = (data, e, sa, ra, s) => [['entrada', e], ['saida_almoco', sa], ['retorno_almoco', ra], ['saida', s]].filter(x => x[1]).map(([tipo, h]) => ({ data, tipo, hora: h }));
const D = '2026-10-14';                                            // quarta-feira
const MARCAS = ['08:39:12', '17:30:07', '17:30:23', '17:30:39'];   // o padrão real: almoço batido por engano junto da saída
const aut = (...datas) => ({ id: 'F', jornada: 8, sabadosCorrigidos: Object.fromEntries(datas.map(d => [d, true])) });
const F = { id: 'F', jornada: 8 };
const calc = (m, f, data, marcas) => m.calcDia(f, data, H(data, ...marcas), null, []);

describe.each(Object.entries(MOTORES))('DIA_SEM_INTERVALO — motor do %s', (_, m) => {
  test('SEM autorização o dia segue incompleto (regra geral intacta)', () => {
    expect(calc(m, F, D, MARCAS)).toMatchObject({ status: 'incompleto', trabalhadoMin: null });
    expect(calc(m, { ...F, sabadosCorrigidos: {} }, D, MARCAS).status).toBe('incompleto');
    expect(calc(m, { ...F, sabadosCorrigidos: { [D]: false } }, D, MARCAS).status).toBe('incompleto');
  });
  test('COM autorização para o dia: 8h51 (531 min), saldo +51, ocorrência explícita; batidas originais continuam expostas', () => {
    const r = calc(m, aut(D), D, MARCAS);
    expect(r).toMatchObject({ status: 'ok', trabalhadoMin: 531, saldoMin: 51, entrada: '08:39', saidaAlmoco: '17:30', retornoAlmoco: '17:30', saida: '17:30', ocorrencia: 'Jornada contínua — sem intervalo (autorizado)' });
  });
  test('autorização vale SÓ para a data: outro dia útil do mesmo funcionário continua incompleto', () => {
    const f = aut(D);
    for (const d of ['2026-10-13', '2026-10-15', '2026-11-03']) expect(calc(m, f, d, MARCAS).status).toBe('incompleto');
  });
  test('autorização de outro funcionário (objeto distinto) não vaza', () => {
    const outro = { id: 'G', jornada: 8, sabadosCorrigidos: {} }; aut(D);
    expect(calc(m, outro, D, MARCAS).status).toBe('incompleto');
  });
  test('NÃO altera sábado nem domingo (mesmo com autorização na data)', () => {
    expect(calc(m, aut('2026-10-17'), '2026-10-17', MARCAS)).not.toMatchObject({ ocorrencia: 'Jornada contínua — sem intervalo (autorizado)' });
    expect(calc(m, aut('2026-10-18'), '2026-10-18', MARCAS).ocorrencia).not.toBe('Jornada contínua — sem intervalo (autorizado)');
  });
  test('dias com intervalo normal: resultado IDÊNTICO com e sem autorização em OUTRAS datas', () => {
    const marcas = ['08:00:00', '12:00:00', '13:00:00', '17:00:00'];
    expect(calc(m, aut(D), '2026-10-15', marcas)).toEqual(calc(m, F, '2026-10-15', marcas));
    expect(calc(m, aut(D), '2026-10-15', marcas)).toMatchObject({ status: 'ok', trabalhadoMin: 480 });
  });
  test('regras de intervalo continuam valendo: >6h sem almoço (2 batidas), sa==ra e ordem invertida seguem incompletos sem autorização', () => {
    expect(calc(m, F, '2026-10-15', ['08:00', null, null, '17:00']).status).toBe('incompleto');
    expect(calc(m, F, '2026-10-15', ['08:00', '12:00', '12:00', '17:00']).status).toBe('incompleto');
    expect(calc(m, F, '2026-10-15', ['08:00', '13:00', '12:00', '17:00']).status).toBe('incompleto');
  });
  test('mesmo com autorização: dia sem saída, ou saída antes da entrada, continua inválido (DEC-12 e pendência)', () => {
    expect(calc(m, aut(D), D, ['08:39:12', '17:30:07', '17:30:23', null]).status).not.toBe('ok');
    expect(calc(m, aut(D), D, ['17:30:00', null, null, '08:00:00']).status).not.toBe('ok');
  });
  test('MISUSO conhecido (documentado): autorização aplicada a dia COM almoço real ignoraria o almoço — por isso o executor exige o padrão de batidas coladas', () => {
    const r = calc(m, aut('2026-10-15'), '2026-10-15', ['08:00:00', '12:00:00', '13:00:00', '17:00:00']);
    expect(r.trabalhadoMin).toBe(540);                              // 9h (sem descontar 1h) — NÃO usar em dia com intervalo real
  });
  test('Home Office e feriados: autorização não cria crédito nem muda status sem batidas', () => {
    expect(m.calcDia(aut(D), D, [], null, []).status).toBe('falta');
  });
});

test('os dois motores dão o mesmo resultado em todos os cenários', () => {
  const casos = [[aut(D), D, MARCAS], [F, D, MARCAS], [aut(D), '2026-10-17', MARCAS], [aut(D), '2026-10-15', ['08:00', '12:00', '13:00', '17:00']], [aut(D), D, ['08:39', null, null, '17:30']]];
  for (const [f, d, mc] of casos) expect(calc(ctx, f, d, mc)).toEqual(calc(M, f, d, mc));
});

test('banco de horas: com autorização o dia entra com as horas efetivamente trabalhadas (+51 min); o registro trabalhista não é lido pelo motor', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8');
  expect(src).not.toMatch(/ponto_intervalos_nao_usufruidos/);
});
