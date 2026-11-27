'use strict';
// Indicador de adoção por origem (sem dado pessoal): agregação e portão, com linhas sintéticas.
const M = require('../../scripts/ops/adocao/medir-origem.js');

const l = (dia, origem, funcao = 'registrarponto', status = '200') =>
  `${dia}T15:00:00Z,https://${origem === 'antigo' ? 'dono.github.io' : 'mr4-ponto.web.app'}/,${funcao},${status}`;

describe('adoção por origem', () => {
  test('classifica só os endereços do sistema', () => {
    expect(M.origemDe('https://dono.github.io/')).toBe('antigo');
    expect(M.origemDe('https://mr4-ponto.web.app/')).toBe('novo');
    expect(M.origemDe('https://mr4-ponto.firebaseapp.com/')).toBe('novo');
    for (const r of ['https://outro.web.app/', 'https://mr4-ponto--canal.web.app/', 'https://github.io.exemplo.test/', '']) expect(M.origemDe(r)).toBeNull();
  });
  test('agrega por dia de Fortaleza e por função; pede só quatro campos', () => {
    const r = M.agregar([l('2026-11-02', 'antigo'), l('2026-11-02', 'novo', 'crmconsulta', '500'), '2026-11-03T01:00:00Z,https://dono.github.io/,registrarponto,200', 'lixo'].join('\n'));
    expect(r.porDia['2026-11-02']).toEqual({ antigo: 2, novo: 1, pontoAntigo: 2, pontoNovo: 0, erroNovo: 1 });
    expect(r.porFuncao.crmconsulta).toEqual({ antigo: 0, novo: 1 });
    expect(r).toMatchObject({ linhas: 3, ignoradas: 1 });
    expect(M.FILTRO).not.toMatch(/remoteIp|userAgent|email/i);
  });
  test('portão: exige 5 dias úteis completos com ponto e zero no endereço antigo', () => {
    const dias = ['2026-11-02', '2026-11-03', '2026-11-04', '2026-11-05', '2026-11-06'];
    const ok = M.agregar(dias.map(d => l(d, 'novo')).concat(l('2026-11-07', 'antigo')).join('\n'));   // sábado não conta
    expect(M.portao(ok.porDia, '2026-11-09')).toMatchObject({ atendido: true, adocaoPontoPct: 100 });
    expect(M.portao(ok.porDia, '2026-11-06').atendido).toBe(false);                                 // só 4 dias completos
    const nao = M.agregar(dias.map(d => l(d, 'novo')).concat(l('2026-11-04', 'antigo')).join('\n'));
    expect(M.portao(nao.porDia, '2026-11-09')).toMatchObject({ atendido: false, pontoAntigo: 1 });
    expect(M.portao({}, '2026-11-09').atendido).toBe(false);
  });
});
