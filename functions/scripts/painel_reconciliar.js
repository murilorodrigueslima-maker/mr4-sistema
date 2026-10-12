#!/usr/bin/env node
'use strict';
// Reconciliação SOMENTE LEITURA: apuração do painel (lib/painelMetricas) × cálculo independente (soma decimal por string) × documento atual.
// Credenciais do Secret Manager, só em memória; nada é gravado. Uso: node scripts/painel_reconciliar.js 2026-10 2026-09 2026-08
const cp = require('child_process');
const M = require('../lib/painelMetricas'); const SY = require('../lib/painelSync');
const sec = n => cp.execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', '--secret=' + n, '--project=mr4-ponto'], { encoding: 'utf8' }).trim();
const tokens = { access: sec('GC_ACCESS_TOKEN'), secret: sec('GC_SECRET_ACCESS_TOKEN') };
const ultimo = m => { const [y, mm] = m.split('-').map(Number); return `${m}-${String(new Date(Date.UTC(y, mm, 0)).getUTCDate()).padStart(2, '0')}`; };
// cálculo independente: separa inteiro/decimal da string e soma em BigInt
const soma = vs => { let c = 0n; vs.forEach(v => { const [i, f = ''] = String(v.valor_total).split('.'); c += BigInt(i) * 100n + BigInt((f + '00').slice(0, 2)); }); return c; };
(async () => {
  const meses = process.argv.slice(2).length ? process.argv.slice(2) : ['2026-10'];
  const linhas = [];
  for (const mes of meses) {
    const hoje = new Date(Date.now() - 3 * 3600e3).toISOString().slice(0, 10);
    const fim = mes === hoje.slice(0, 7) ? hoje : ultimo(mes);
    const c = await SY.buscarVendas({ fetchImpl: fetch, tokens, situacaoId: '3952593', inicio: mes + '-01', fim });
    const k = await SY.buscarVendas({ fetchImpl: fetch, tokens, situacaoId: '3952594', inicio: mes + '-01', fim });
    const r = M.calcular({ vendas: c.vendas.concat(k.vendas), hojeStr: hoje, mes, cfg: { metas: { ademir: 165000, fabiana: 75000 }, metaGeral: 240000 } });
    const ind = soma(c.vendas.filter(v => String(v.data).startsWith(mes)));
    const ids = new Set(c.vendas.map(v => String(v.id)));
    linhas.push({ mes, fim, lidas: c.vendas.length, total_registros_GC: c.totalRegistros, paginacaoIntegra: c.integra, idsUnicos: ids.size,
      painel_centavos: r.centavos.geral, independente_centavos: Number(ind), confere: r.centavos.geral === Number(ind) && r.ok,
      geral: r.geral.totalMes, pedidos: r.geral.pedidosMes, ademir: r.ademir.totalMes, fabiana: r.fabiana.totalMes, outros: r.outros.totalMes, pedidosOutros: r.outros.pedidosMes,
      somaPartes: Math.round((r.centavos.ademir + r.centavos.fabiana + r.centavos.outros)) / 100, canceladas: r.cancelamentos, semVendedor: r.qualidade.vendasSemVendedor, naoMapeados: r.qualidade.vendedoresNaoMapeados, duplicidades: r.qualidade.duplicidadesDetectadas });
  }
  console.log(JSON.stringify(linhas, null, 1));
})().catch(e => { console.log('ERR', e.message); process.exit(1); });
