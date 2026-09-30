'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Fase 0 · data comercial em America/Fortaleza, independente do fuso da máquina.
const { execFileSync } = require('child_process');
const path = require('path');
jest.setTimeout(60000);
const LIB = path.resolve(__dirname, '../lib/compras'), FIX = path.resolve(__dirname, 'fixtures/compras-estoque-f0');
function rodar(tz, instante) {
  const code = `
    const S = require(${JSON.stringify(LIB + '/snapshot')}); const X = require(${JSON.stringify(FIX)});
    const c = X.cenario();
    // venda exatamente em 28/09 e em 29/09 (dia seguinte) para o mesmo produto
    c.vendas.push(X.venda('2026-09-29', [['PX-ZEROALTO', 7]]));
    const s = S.montarSnapshot({ brutosProdutos: c.produtos, brutosVendas: c.vendas, brutosCompras: c.compras, agora: new Date(${JSON.stringify(instante)}), politica: require(${JSON.stringify(LIB + '/politica')}).POLITICA_1_0 });
    const z = s.operacional.find(x => x.product_id === 'PX-ZEROALTO');
    process.stdout.write(JSON.stringify({ data: s.resumo.data_comercial, snap: s.snapshotEstoque.data_comercial, pv: s.snapshotEstoque.policy_version, tz: s.snapshotEstoque.timezone, u7: z.units[7], nunca: z.never_sold, listas: s.resumo.listas, sug: s.operacional.map(m => [m.product_id, m.suggestion.suggested_qty, m.suggestion.priority]) }));`;
  return JSON.parse(execFileSync(process.execPath, ['-e', code], { env: { ...process.env, TZ: tz } }).toString());
}
describe.each([
  ['23:30 em Fortaleza (02:30Z do dia 29)', '2026-09-29T02:30:00Z', '2026-09-28', 0, true],
  ['00:30 em Fortaleza do dia 29 (03:30Z)', '2026-09-29T03:30:00Z', '2026-09-29', 7, false],
])('%s', (_, instante, data, u7, nunca) => {
  test('UTC = America/Fortaleza = Asia/Tokyo (mesma data comercial e mesmas classificações)', () => {
    const utc = rodar('UTC', instante), fort = rodar('America/Fortaleza', instante), tokyo = rodar('Asia/Tokyo', instante);
    expect(utc.data).toBe(data); expect(utc.snap).toBe(data); expect(utc.pv).toBe('1.0'); expect(utc.tz).toBe('America/Fortaleza'); expect(utc.u7).toBe(u7); expect(utc.nunca).toBe(nunca);
    expect(fort).toEqual(utc); expect(tokyo).toEqual(utc);
  });
});
