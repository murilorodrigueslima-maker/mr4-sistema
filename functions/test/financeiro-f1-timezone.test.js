'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · a data comercial nasce em America/Fortaleza e NÃO depende do fuso da máquina.
// Executa o mesmo cálculo em processos com TZ diferentes e compara o resultado.
const { execFileSync } = require('child_process');
const path = require('path');
jest.setTimeout(60000);

const LIB = path.resolve(__dirname, '../lib/financeiro');
const FIX = path.resolve(__dirname, 'fixtures/financeiro-f1');
function rodar(tz, instante) {
  const code = `
    const S = require(${JSON.stringify(LIB + '/snapshot')});
    const { FORMAS, titulo, receber } = require(${JSON.stringify(FIX)});
    const pag = ['2026-09-27','2026-09-28','2026-09-29','2026-10-05','2026-10-13','2026-10-28','2026-12-01'].map((d, i) => titulo({ id: 'P' + i, data_vencimento: d }));
    const rec = ['2026-09-28','2026-09-29'].map((d, i) => receber({ id: 'R' + i, data_vencimento: d }));
    const s = S.montarSnapshot({ brutosPagar: pag, brutosReceber: rec, refs: { formasPorId: FORMAS }, agora: new Date(${JSON.stringify(instante)}) });
    process.stdout.write(JSON.stringify({ data: s.resumo.data_comercial, pagar: s.resumo.pagar.buckets_exclusivos, janelas: s.resumo.pagar.janelas_acumuladas_sem_vencidos, receber: s.resumo.receber.buckets_exclusivos, auditoria: s.auditoria.pagar.buckets_exclusivos }));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: tz } }).toString());
}

describe.each([
  ['23:30 em Fortaleza (02:30Z do dia seguinte)', '2026-09-29T02:30:00Z', '2026-09-28'],
  ['00:30 em Fortaleza (03:30Z)', '2026-09-28T03:30:00Z', '2026-09-28'],
  ['meio-dia em Fortaleza', '2026-09-28T15:00:00Z', '2026-09-28'],
])('%s', (_, instante, dataEsperada) => {
  test('UTC_TIMEZONE_TEST = FORTALEZA_TIMEZONE_TEST = Asia/Tokyo (mesmos buckets, mesma data comercial)', () => {
    const utc = rodar('UTC', instante), fort = rodar('America/Fortaleza', instante), tokyo = rodar('Asia/Tokyo', instante);
    expect(utc.data).toBe(dataEsperada);
    expect(fort).toEqual(utc);
    expect(tokyo).toEqual(utc);
    // com hoje = 28/09: 27/09 vencido, 28/09 hoje, 29/09 amanhã
    expect(utc.auditoria.VENCIDO).toEqual(['P0']);
    expect(utc.auditoria.HOJE).toEqual(['P1']);
    expect(utc.auditoria.AMANHA).toEqual(['P2']);
  });
});
