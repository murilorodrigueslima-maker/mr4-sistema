#!/usr/bin/env node
'use strict';
/**
 * Adoção do endereço novo — SOMENTE LEITURA dos logs das Functions (gcloud logging read).
 * Pede apenas data, origem, função e status; não pede nem guarda IP, usuário, corpo ou página.
 *
 *   node scripts/ops/adocao/medir-origem.js [--dias 14] [--json]
 *   node scripts/ops/adocao/medir-origem.js --arquivo linhas.csv      # reprocessa um CSV (timestamp,referer,função,status)
 *
 * Indicador (portão para a virada): nos últimos 5 dias úteis com ponto registrado, nenhuma chamada de registrarPonto
 * veio do endereço antigo. Saída 0 = portão atendido; 3 = ainda não; 2 = não foi possível medir.
 * Limites: não diz quem usa; telas que só leem o Firestore não aparecem; os logs costumam durar 30 dias.
 */
const cp = require('child_process');
const fs = require('fs');

const PROJETO = 'mr4-ponto';
const LIMITE = 100000;
const FILTRO = 'resource.type="cloud_run_revision" AND httpRequest.requestMethod="POST" AND '
  + '(httpRequest.referer:"github.io" OR httpRequest.referer:"web.app" OR httpRequest.referer:"firebaseapp.com")';
const PONTO = 'registrarponto';

function origemDe(referer) {
  let host = ''; try { host = new URL(referer).hostname.toLowerCase(); } catch (_) { return null; }
  if (host.endsWith('.github.io')) return 'antigo';
  if (host === 'mr4-ponto.web.app' || host === 'mr4-ponto.firebaseapp.com') return 'novo';
  return null;                                                                    // pré-visualizações e outros projetos
}
const diaFortaleza = ts => new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date(ts));
const fimDeSemana = d => [0, 6].includes(new Date(d + 'T12:00:00Z').getUTCDay());

function agregar(csv) {
  const porDia = {}, porFuncao = {};
  let linhas = 0, ignoradas = 0;
  for (const l of csv.split('\n')) {
    if (!l.trim()) continue;
    const [ts, referer, funcao, status] = l.split(',').map(x => x.replace(/^"|"$/g, ''));
    const origem = origemDe(referer);
    if (!origem || !funcao || Number.isNaN(Date.parse(ts))) { ignoradas++; continue; }
    linhas++;
    const dia = diaFortaleza(ts), ok = /^2\d\d$/.test(status || '');
    const d = porDia[dia] || (porDia[dia] = { antigo: 0, novo: 0, pontoAntigo: 0, pontoNovo: 0, erroNovo: 0 });
    d[origem]++;
    if (funcao === PONTO) d[origem === 'antigo' ? 'pontoAntigo' : 'pontoNovo']++;
    if (origem === 'novo' && !ok) d.erroNovo++;
    const f = porFuncao[funcao] || (porFuncao[funcao] = { antigo: 0, novo: 0 });
    f[origem]++;
  }
  return { porDia, porFuncao, linhas, ignoradas };
}

function portao(porDia, hoje = diaFortaleza(Date.now()), n = 5) {
  // dias completos (hoje fica de fora), de segunda a sexta, com alguma batida registrada
  const dias = Object.keys(porDia).filter(d => d < hoje && !fimDeSemana(d) && porDia[d].pontoAntigo + porDia[d].pontoNovo > 0).sort().slice(-n);
  const soma = k => dias.reduce((s, d) => s + porDia[d][k], 0);
  const pontoAntigo = soma('pontoAntigo'), pontoNovo = soma('pontoNovo'), antigo = soma('antigo'), novo = soma('novo');
  return {
    atendido: dias.length === n && pontoAntigo === 0,
    diasAvaliados: dias, pontoAntigo, pontoNovo,
    adocaoPontoPct: pontoAntigo + pontoNovo ? Math.round(1000 * pontoNovo / (pontoAntigo + pontoNovo)) / 10 : 0,
    adocaoGeralPct: antigo + novo ? Math.round(1000 * novo / (antigo + novo)) / 10 : 0,
  };
}

function coletar(dias) {
  return cp.execFileSync('gcloud', ['logging', 'read', FILTRO, `--project=${PROJETO}`, `--freshness=${dias}d`, `--limit=${LIMITE}`,
    '--format=csv[no-heading](timestamp,httpRequest.referer,resource.labels.service_name,httpRequest.status)'],
  { encoding: 'utf8', maxBuffer: 1 << 28, stdio: ['ignore', 'pipe', 'pipe'], timeout: 600000 });
}

function principal(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const dias = Math.min(Math.max(parseInt(opt('--dias') || '14', 10) || 14, 1), 30);
  let csv;
  try { csv = opt('--arquivo') ? fs.readFileSync(opt('--arquivo'), 'utf8') : coletar(dias); } catch (_) {
    console.error('Não foi possível ler os logs (confira o login do gcloud e a permissão de leitura de logs).'); return 2;
  }
  const r = agregar(csv), p = portao(r.porDia);
  const truncado = r.linhas + r.ignoradas >= LIMITE;
  if (argv.includes('--json')) console.log(JSON.stringify({ dias, ...r, portao: p, truncado }));
  else {
    console.log(`chamadas contadas: ${r.linhas} (últimos ${dias} dias)${truncado ? '  ATENÇÃO: limite atingido, reduza --dias' : ''}`);
    console.log('dia         antigo   novo | ponto antigo  ponto novo | erros no novo');
    for (const d of Object.keys(r.porDia).sort()) { const x = r.porDia[d]; console.log(`${d}  ${String(x.antigo).padStart(6)} ${String(x.novo).padStart(6)} | ${String(x.pontoAntigo).padStart(12)} ${String(x.pontoNovo).padStart(11)} | ${String(x.erroNovo).padStart(6)}`); }
    console.log('\nfunção                          antigo   novo');
    for (const [f, x] of Object.entries(r.porFuncao).sort((a, b) => b[1].antigo - a[1].antigo)) console.log(`${f.padEnd(30)} ${String(x.antigo).padStart(7)} ${String(x.novo).padStart(6)}`);
    console.log(`\nINDICADOR: ponto no endereço novo = ${p.adocaoPontoPct}% · geral = ${p.adocaoGeralPct}% · dias úteis avaliados: ${p.diasAvaliados.length}/5`);
    console.log(`PORTÃO (5 dias úteis sem ponto no endereço antigo): ${p.atendido ? 'ATENDIDO' : 'NÃO ATENDIDO'}`);
  }
  return p.atendido ? 0 : 3;
}

if (require.main === module) process.exitCode = principal(process.argv.slice(2));   // não cortar a saída em pipes
module.exports = { origemDe, agregar, portao, principal, FILTRO };
