'use strict';
// FINANCEIRO Fase 2 · escopo de deploy: Function única e agendada, Rules só no bloco fin_n1, nenhum outro módulo alterado, navegação intacta.
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');
const BASE = 'd6b256f';                       // main aprovado (CRM 2.0 em produção); imutável
const git = cmd => execSync('git ' + cmd, { cwd: ROOT, encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
let temGit = true; try { git('cat-file -e ' + BASE + '^{commit}'); } catch (_) { temGit = false; }
const dt = temGit ? test : test.skip;

test('Function financeiroSync: onSchedule, 3/3 h, Fortaleza, 1 instância, sem retry, só os 2 segredos do ERP, sem HTTP/callable', () => {
  const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  const bloco = idx.slice(idx.indexOf('exports.financeiroSync'), idx.indexOf('exports.financeiroSync') + 700);
  expect(bloco).toMatch(/onSchedule\(\{/); expect(bloco).toMatch(/timeZone:\s+financeiroEntrypoints\.AGENDA\.TIMEZONE/); expect(bloco).toMatch(/secrets:\s+\['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'\]/);
  expect(bloco).toMatch(/retryCount:\s+0/); expect(bloco).toMatch(/maxInstances:\s+1/); expect(bloco).toMatch(/timeoutSeconds:\s+1800/);
  expect(idx).not.toMatch(/exports\.financeiro\w*\s*=\s*(onRequest|onCall)/);
  const E = require('../lib/financeiro/entrypoints'); expect(E.AGENDA).toEqual({ CRON: '40 */3 * * *', TIMEZONE: 'America/Fortaleza', STALE_HORAS: 6 });
});
test('entrypoint usa só variáveis de ambiente do segredo e executa o sync completo (GET-only)', async () => {
  const E = require('../lib/financeiro/entrypoints'); const { gcFalso, dbFalso, massa } = require('./fixtures/financeiro-f2');
  const g = gcFalso(massa({ hoje: new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date()), nPagar: 20, nReceber: 30 })); const db = dbFalso(); const logs = [];
  const fetchImpl = async (url, o) => { g.chamadas.push({ method: o.method }); expect(o.headers['access-token']).toBe('AT'); expect(o.headers['secret-access-token']).toBe('ST'); return (await g.cli.get(new URL(url).pathname + new URL(url).search).then(j => ({ ok: true, json: async () => j }))); };
  // o cliente interno do entrypoint chama fetchImpl com os cabeçalhos dos segredos; aqui só garantimos que o método é GET
  const r = await E.syncAgendadoHandler({ db, env: { GC_ACCESS_TOKEN: 'AT', GC_SECRET_ACCESS_TOKEN: 'ST' }, fetchImpl, pausaMs: 0, log: e => logs.push(e) });
  expect(r.ok).toBe(true); expect(JSON.stringify(logs)).not.toMatch(/"AT"|"ST"/); expect(new Set(g.chamadas.map(c => c.method))).toEqual(new Set(['GET']));
});
dt('Rules: nada fora do bloco fin_n1 mudou em relação ao main aprovado (Ponto, Compras, Expedição, CRM e demais intactos)', () => {
  const nova = fs.readFileSync(path.join(ROOT, 'modulos/firestore.rules'), 'utf8'), antiga = git(`show ${BASE}:modulos/firestore.rules`);
  const ini = nova.indexOf('    // ── AGENTE FINANCEIRO MR4 — Fase 2'), fim = nova.indexOf('    // ── Coleção: painel_cache');
  expect(ini).toBeGreaterThan(0); expect(fim).toBeGreaterThan(ini);
  expect(nova.slice(0, ini) + nova.slice(fim)).toBe(antiga);
  const bloco = nova.slice(ini, fim); expect(bloco).toMatch(/allow list:\s+if false/); expect(bloco).not.toMatch(/allow (create|update|delete|write):\s+if (?!false)/);
});
dt('somente arquivos do Financeiro mudaram em relação ao main aprovado (UNRELATED_FILES=0); navegação (index.html) intacta', () => {
  const mudou = git(`diff --name-only ${BASE}`).split('\n').filter(Boolean);
  const permitido = f => /^functions\/lib\/financeiro\//.test(f) || /^functions\/test\/(financeiro-|fixtures\/financeiro-|helpers\/financeiro-)/.test(f) || ['modulos/financeiro-v2.html', 'modulos/financeiro-view.js', 'modulos/firestore.rules', 'functions/index.js', 'index.html', 'modulos/financeiro.html'].includes(f);
  expect(mudou.filter(f => !permitido(f))).toEqual([]);
  // index.html: UMA linha acrescentada (entrada do Financeiro novo no menu); nada removido. financeiro.html (tela antiga): só o aviso, nenhum número alterado.
  const soAdicoes = f => { const l = git(`diff ${BASE} -- ${f}`).split('\n').filter(x => /^[+-]/.test(x) && !/^(\+\+\+|---)/.test(x)); return { rem: l.filter(x => x[0] === '-'), add: l.filter(x => x[0] === '+') }; };
  if (mudou.includes('index.html')) { const d = soAdicoes('index.html'); expect(d.rem).toEqual([]); expect(d.add.filter(x => /url: '\.\/modulos\/financeiro-v2\.html'/.test(x))).toHaveLength(1); expect(d.add.filter(x => !/^\+\s*\/\//.test(x))).toHaveLength(1); }
  if (mudou.includes('modulos/financeiro.html')) { const d = soAdicoes('modulos/financeiro.html'); expect(d.rem).toEqual([]); expect(d.add.join('\n')).toMatch(/Indicadores financeiros em atualização/); expect(d.add.join('\n')).toMatch(/Esta versão do painel utiliza uma fonte anterior de dados e pode apresentar valores incompletos\. Consulte o novo Financeiro para os dados atualizados\./); }
  const idxDiff = git(`diff ${BASE} -- functions/index.js`); const adicionadas = idxDiff.split('\n').filter(l => /^[+-]/.test(l) && !/^(\+\+\+|---)/.test(l));
  expect(adicionadas.filter(l => l.startsWith('-'))).toEqual([]);                                              // index.js: só acréscimos (nenhuma Function alterada)
});
test('a tela antiga e o cache legado não são tocados nem usados pela nova tela', () => {
  const v2 = fs.readFileSync(path.join(ROOT, 'modulos/financeiro-v2.html'), 'utf8');
  expect(v2).not.toMatch(/financeiro_cache/); expect(fs.readFileSync(path.join(ROOT, 'functions/lib/financeiro', 'sync.js'), 'utf8')).not.toMatch(/financeiro_cache/);
});
