'use strict';
/**
 * PROTEÇÃO CONTRA RE-RASTREAMENTO de relatórios com DADOS COMERCIAIS REAIS (incidente de privacidade de 24/11/2026).
 * Não depende só do .gitignore: falha se (a) os relatórios ou data/ voltarem a ser rastreados, (b) algum arquivo rastreado de docs/ tiver a "assinatura"
 * desses relatórios, (c) os scripts geradores voltarem a gravar dentro do repositório, (d) algum workflow versionar/publicar docs/ ou esses scripts.
 */
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../..');
const git = c => execSync('git ' + c, { cwd: ROOT, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
let rastreados = null; try { rastreados = git('ls-files').split('\n').filter(Boolean); } catch (_) { /* sem .git (ex.: cópia sem histórico): testes de arquivo abaixo seguem pelos arquivos */ }
const RELATORIOS = ['docs/agente-comercial/LABORATORIO_REGRAS_N22.md', 'docs/agente-comercial/CALIBRACAO_COMERCIAL.md', 'docs/agente-comercial/CALIBRACAO_COMERCIAL_VINCULADOS.md'];
const GERADORES = ['scripts/laboratorio-regras-n22.js', 'scripts/calibrar-agente-comercial.js', 'scripts/calibrar-agente-comercial-vinculados.js'];
const ler = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
const t = rastreados ? test : test.skip;

t('os 3 relatórios reais e data/ NÃO estão rastreados pelo Git', () => { for (const r of RELATORIOS) expect(rastreados.includes(r)).toBe(false); expect(rastreados.filter(f => f.startsWith('data/'))).toEqual([]); });
t('nenhum arquivo rastreado de docs/ tem a assinatura de relatório com dados reais (FATURAMENTO_TOTAL em R$ / linhas por cliente)', () => {
  const ruins = rastreados.filter(f => /^docs\/.*\.md$/.test(f)).filter(f => { const s = ler(f); return /FATURAMENTO_TOTAL\s*\|\s*R\$\s*\d/.test(s) || /\|\s*C[0-9A-F]{4}\s*\|\s*[SN]\s*\|\s*[SN]\s*\|\s*[\d—]+\s*\|\s*R\$\s*\d/.test(s); });
  expect(ruins).toEqual([]);
});
test('o .gitignore lista os 3 relatórios e a pasta privada', () => { const g = ler('.gitignore'); for (const r of RELATORIOS) expect(g).toContain(r); expect(g).toContain('mr4-relatorios-privados/'); });
test('os scripts geradores gravam FORA do repositório (nunca em docs/)', () => {
  for (const s of GERADORES) { const c = ler(s); expect(c).toMatch(/MR4_RELATORIOS_DIR \|\| path\.join\(require\('os'\)\.homedir\(\), 'mr4-relatorios-privados'\)/); expect(c).not.toMatch(/path\.join\(__dirname,\s*'\.\.',\s*'docs'/); }
});
test('nenhum workflow versiona/publica docs/ nem executa os geradores', () => {
  const dir = path.join(ROOT, '.github/workflows');
  for (const f of fs.readdirSync(dir)) { const w = fs.readFileSync(path.join(dir, f), 'utf8'); expect({ f, g: /docs\/agente-comercial|laboratorio-regras-n22|calibrar-agente-comercial/.test(w) }).toEqual({ f, g: false }); expect({ f, c: /git (add|commit|push)/.test(w) }).toEqual({ f, c: false }); }
});
test('o hook anti-reintrodução existe, é executável, falha fechada e protege os 3 relatórios e data/', () => {
  const h = ler('scripts/ops/anti-reintroducao/pre-push'); expect(h).toMatch(/exit 1/); expect(h).toMatch(/data\//); expect(h).toMatch(/LABORATORIO_REGRAS_N22/); expect(h).toMatch(/lista de bloqueio ausente/);
  expect(fs.statSync(path.join(ROOT, 'scripts/ops/anti-reintroducao/pre-push')).mode & 0o111).not.toBe(0);
  expect(ler('scripts/ops/anti-reintroducao/denylist-commits-antigos.txt').split('\n').filter(Boolean).every(l => /^[0-9a-f]{40}$/.test(l))).toBe(true);
});
