#!/usr/bin/env node
'use strict';
/**
 * Varredura de privacidade do repositório PÚBLICO: verifica (e reaplica) a anonimização depois de mesclas.
 *
 *   node scripts/ops/privacidade/varredura.js                      # só checagens estruturais (não precisa de lista)
 *   node scripts/ops/privacidade/varredura.js --termos <arquivo>   # também procura os termos da lista PRIVADA
 *   node scripts/ops/privacidade/varredura.js --termos <arquivo> --aplicar   # troca os ERROS pelos fictícios (revise o diff)
 *   ... --aplicar --incluir-avisos                                          # também as abreviações (confira antes)
 *   ... --commits origin/main..HEAD                                         # antes do push: mensagens e linhas novas
 *   opções: --raiz <pasta>   --estrito (avisos também reprovam)   --json
 *
 * A lista privada NUNCA entra no repositório (padrão: ~/mr4-ops/privacidade/termos.json, ou MR4_TERMOS_PRIVADOS).
 * A saída mostra só arquivo, linha e categoria: o trecho encontrado nunca é impresso.
 * Saída: 0 = nada a corrigir; 1 = há ocorrências não excetuadas; 2 = uso/configuração inválidos.
 *
 * Formato da lista: { "permitidos": ["regex de contexto público"],
 *   "termos": [ { "cat": "P1", "valor": "...", "modo": "trecho|palavra|identificador|exato", "novo": "vend1" } ] }
 *   trecho: em qualquer posição (sem acento/caixa) · palavra: delimitado (inclui fronteira camelCase)
 *   identificador: abreviação usada como chave/literal (gera AVISO) · exato: sensível a caixa (UIDs)
 *   numero: número delimitado (ids do ERP)
 */
const fs = require('fs');
const os = require('os');
const path = require('path');
const cp = require('child_process');

const AQUI = 'scripts/ops/privacidade/';
// Listas de hashes: casariam por acaso com abreviações.
const IGNORAR = [/^scripts\/ops\/anti-reintroducao\/denylist-/, /(^|\/)package-lock\.json$/, /\.(png|jpe?g|gif|ico|webp|pdf|woff2?|ttf|zip|gz|dmg|mp3|mp4)$/i];

const letra = c => /\p{L}/u.test(c || '');
const minuscula = c => letra(c) && c === c.toLowerCase() && c !== c.toUpperCase();
const maiuscula = c => letra(c) && c === c.toUpperCase() && c !== c.toLowerCase();
/** Normaliza sem mudar o comprimento (um caractere → um caractere), para as posições continuarem válidas. */
const MAPA_LETRAS = new Map();
const base = c => { let r = MAPA_LETRAS.get(c); if (r === undefined) { r = (c.normalize('NFD')[0] || c).toLowerCase()[0] || c; MAPA_LETRAS.set(c, r); } return r; };
const normalizar = s => /^[\x00-\x7f]*$/.test(s) ? s.toLowerCase() : s.replace(/[\s\S]/g, base);
const esc = s => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

function posicoes(linha, norm, t) {
  const achados = [];
  if (t.modo === 'exato') {
    for (let i = linha.indexOf(t.valor); i >= 0; i = linha.indexOf(t.valor, i + 1)) achados.push([i, i + t.valor.length]);
    return achados;
  }
  if (t.modo === 'numero') {
    const re = new RegExp(`(?<![A-Za-z0-9])${esc(t.valor)}(?![A-Za-z0-9])`, 'g');
    for (const m of linha.matchAll(re)) achados.push([m.index, m.index + t.valor.length]);
    return achados;
  }
  const v = normalizar(t.valor);
  if (t.modo === 'identificador') {
    const e = esc(v);
    const re = new RegExp(`(['"\`])(${e})\\1|(?<![\\p{L}\\d_])(${e})(?=\\s*:(?!:)|@)|\\.(${e})(?![\\p{L}\\d_])`, 'gu');
    for (const m of norm.matchAll(re)) { const g = m[2] || m[3] || m[4]; const i = m.index + m[0].indexOf(g); achados.push([i, i + g.length]); }
    return achados;
  }
  for (let i = norm.indexOf(v); i >= 0; i = norm.indexOf(v, i + 1)) {
    const f = i + v.length;
    if (t.modo === 'palavra') {
      const antes = linha[i - 1], depois = linha[f];
      const iniOk = !letra(antes) || (minuscula(antes) && maiuscula(linha[i]));
      const fimOk = !letra(depois) || (minuscula(linha[f - 1]) && maiuscula(depois));
      if (!iniOk || !fimOk) continue;
    }
    achados.push([i, f]);
  }
  return achados;
}

/** Mantém o estilo de caixa do trecho original. */
function comCaixa(original, novo) {
  if (original.length > 1 && original === original.toUpperCase() && original !== original.toLowerCase()) return novo.toUpperCase();
  if (maiuscula(original[0])) return novo[0].toUpperCase() + novo.slice(1);
  return novo;
}

// ── Checagens estruturais (sem lista) ──────────────────────────────────────────
const cpfValido = d => {
  if (!/^\d{11}$/.test(d) || /^(\d)\1{10}$/.test(d) || /^(123456789|000000|111444777|529982247)/.test(d)) return false;
  const dv = n => { let s = 0; for (let i = 0; i < n; i++) s += Number(d[i]) * (n + 1 - i); const r = (s * 10) % 11; return r === 10 ? 0 : r; };
  return dv(9) === Number(d[9]) && dv(10) === Number(d[10]);
};
const pareceUid = u => {
  if (/sint|ficti|teste|test|fake|exemplo/i.test(u)) return false;
  if ((u.match(/\d/g) || []).length < 2 || !/[a-z]/.test(u) || !/[A-Z]/.test(u)) return false;
  let trocas = 0; for (let i = 1; i < u.length; i++) { const k = c => /\d/.test(c) ? 0 : c === c.toUpperCase() ? 1 : 2; if (k(u[i]) !== k(u[i - 1])) trocas++; }
  return trocas >= 10 && new Set(u).size >= 16;
};
const EMAIL_NEUTRO = /@([\w-]+\.)*(test|teste|exemplo|example|local|invalid|fake|localhost|email|x|a|b|t)(\.[a-z]{2,3})?$|@(exemplo|example|teste|test|empresa|email|dominio|mr4)\.(com|com\.br|org|net)$|gserviceaccount\.com$|^noreply@|@users\.noreply\.github\.com$|^git@github\.com$|\.(png|jpg|js|css|html)$/i;
const ESTRUTURAIS = [
  { cat: 'SEGREDO', nivel: 'erro', re: /\bgh[pousr]_[A-Za-z0-9]{30,}|\bgithub_pat_[A-Za-z0-9_]{40,}|-----BEGIN [A-Z ]*PRIVATE KEY-----|\bAKIA[0-9A-Z]{16}\b/g },
  { cat: 'UID_APARENTE', nivel: 'aviso', re: /(?<![A-Za-z0-9_\-+/=])[A-Za-z0-9]{28}(?![A-Za-z0-9_\-+/=])/g, filtro: pareceUid },
  { cat: 'CPF_VALIDO', nivel: 'aviso', re: /(?<![\d.])\d{3}\.\d{3}\.\d{3}-\d{2}(?!\d)/g, filtro: s => cpfValido(s.replace(/\D/g, '')) },
  { cat: 'EMAIL_APARENTE', nivel: 'aviso', re: /(?<![\w.+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g, filtro: s => !EMAIL_NEUTRO.test(s) },
  { cat: 'META_FIXA', nivel: 'aviso', re: /\bmetas?\s*[:=]\s*\{[^}\n]*[:=]\s*\d{4,}/gi, ignorarTestes: true },
];

function analisar({ raiz, arquivos, lista, excecoes, aplicar = false, incluirAvisos = false }) {
  const termos = (lista && lista.termos || []).filter(t => t && t.valor && t.modo)
    .sort((a, b) => b.valor.length - a.valor.length);
  const permitidos = (lista && lista.permitidos || []).map(r => new RegExp(r, 'gi'));
  const excetuado = (arq, cat) => excecoes.find(x => x.arquivo === arq && x.categorias.includes(cat));
  const achados = []; let trocas = 0; const alterados = [];
  for (const arq of arquivos) {
    if (IGNORAR.some(r => r.test(arq))) continue;
    const abs = path.join(raiz, arq);
    let texto; try { if (fs.lstatSync(abs).isSymbolicLink()) continue; texto = fs.readFileSync(abs, 'utf8'); } catch (_) { continue; }
    if (texto.includes('\u0000')) continue;
    // nome do arquivo também conta
    for (const t of termos) if (t.modo !== 'identificador' && posicoes(arq, normalizar(arq), t).length) achados.push({ arquivo: arq, linha: 0, cat: t.cat, nivel: 'erro', excecao: !!excetuado(arq, t.cat) });
    const linhas = texto.split('\n'); let mudou = false;
    // pré-filtro por arquivo: só os termos presentes no texto são procurados linha a linha
    const normArq = normalizar(texto);
    const doArquivo = termos.filter(t => (t.modo === 'exato' || t.modo === 'numero') ? texto.includes(t.valor) : normArq.includes(normalizar(t.valor)));
    for (let n = 0; n < linhas.length; n++) {
      let linha = linhas[n];
      const publicos = [];
      for (const re of permitidos) for (const m of linha.matchAll(re)) publicos.push([m.index, m.index + m[0].length]);
      const norm = normalizar(linha); const usados = []; const repor = [];
      const livre = (i, f) => !publicos.some(([a, b]) => i >= a && f <= b) && !usados.some(([a, b]) => i < b && f > a);
      for (const t of doArquivo) {
        for (const [i, f] of posicoes(linha, norm, t)) {
          if (!livre(i, f)) continue;
          usados.push([i, f]);
          const ex = !!excetuado(arq, t.cat);
          const nivel = t.modo === 'identificador' ? 'aviso' : 'erro';
          achados.push({ arquivo: arq, linha: n + 1, cat: t.cat, nivel, excecao: ex });
          if (aplicar && !ex && (nivel === 'erro' || incluirAvisos) && t.novo !== undefined && !arq.startsWith(AQUI)) repor.push([i, f, t.modo === 'exato' || t.modo === 'numero' ? t.novo : comCaixa(linha.slice(i, f), t.novo)]);
        }
      }
      for (const c of ESTRUTURAIS) {
        if (c.ignorarTestes && /(^|\/)(test|tests|fixtures)\//.test(arq)) continue;
        for (const m of linha.matchAll(c.re)) {
          if (c.filtro && !c.filtro(m[0])) continue;
          if (!livre(m.index, m.index + m[0].length)) continue;
          achados.push({ arquivo: arq, linha: n + 1, cat: c.cat, nivel: c.nivel, excecao: !!excetuado(arq, c.cat) });
        }
      }
      if (repor.length) {
        repor.sort((a, b) => b[0] - a[0]).forEach(([i, f, novo]) => { linha = linha.slice(0, i) + novo + linha.slice(f); trocas++; });
        linhas[n] = linha; mudou = true;
      }
    }
    if (mudou) { fs.writeFileSync(abs, linhas.join('\n')); alterados.push(arq); }
  }
  return { achados, trocas, alterados };
}

/** Mensagens e linhas ADICIONADAS por commit (o que iria para o histórico público num push). Só categorias de erro. */
function analisarCommits({ raiz, faixa, lista }) {
  const git = (...a) => cp.execFileSync('git', ['-C', raiz, ...a], { encoding: 'utf8', maxBuffer: 1 << 28 });
  const termos = (lista && lista.termos || []).filter(t => t.valor && t.modo !== 'identificador');
  const permitidos = (lista && lista.permitidos || []).map(r => new RegExp(r, 'gi'));
  const achados = [];
  for (const sha of git('rev-list', faixa).split('\n').filter(Boolean)) {
    const mensagem = git('log', '-1', '--format=%B', sha);
    const diff = git('show', '-U0', '--format=', '--no-color', sha);
    const novas = diff.split('\n').filter(l => l.startsWith('+') && !l.startsWith('+++')).join('\n');
    for (const [onde, texto] of [['mensagem', mensagem], ['linhas adicionadas', novas]]) {
      const limpo = permitidos.reduce((s, re) => s.replace(re, ' '), texto);
      const norm = normalizar(limpo);
      const cats = new Set(termos.filter(t => posicoes(limpo, norm, t).length).map(t => t.cat));
      if (cats.size) achados.push({ commit: sha.slice(0, 9), onde, categorias: [...cats].sort() });
    }
  }
  return achados;
}

function principal(argv) {
  const opt = k => { const i = argv.indexOf(k); return i >= 0 ? argv[i + 1] : null; };
  const raiz = path.resolve(opt('--raiz') || path.join(__dirname, '..', '..', '..'));
  const aplicar = argv.includes('--aplicar'), estrito = argv.includes('--estrito');
  const padrao = path.join(os.homedir(), 'mr4-ops', 'privacidade', 'termos.json');
  const pedido = opt('--termos') || process.env.MR4_TERMOS_PRIVADOS || null;
  const caminho = pedido || (fs.existsSync(padrao) ? padrao : null);
  let lista = null;
  if (caminho) {
    const abs = path.resolve(caminho);
    if (abs.startsWith(raiz + path.sep)) { console.error('A lista privada não pode ficar dentro do repositório.'); return 2; }
    try { lista = JSON.parse(fs.readFileSync(abs, 'utf8')); } catch (_) { console.error('Lista privada ausente ou ilegível.'); return 2; }
  }
  if (aplicar && !lista) { console.error('--aplicar exige a lista privada (--termos).'); return 2; }
  const faixa = opt('--commits');
  if (faixa) {
    if (!lista || faixa.startsWith('-')) { console.error('--commits <faixa> exige a lista privada.'); return 2; }
    const c = analisarCommits({ raiz, faixa, lista });
    c.forEach(a => console.log(`  ${a.commit}  ${a.onde}: ${a.categorias.join(', ')}`));
    console.log(`commits com ocorrência: ${new Set(c.map(a => a.commit)).size}`);
    return c.length ? 1 : 0;
  }
  const excecoes = JSON.parse(fs.readFileSync(path.join(__dirname, 'excecoes.json'), 'utf8')).excecoes;
  const arquivos = cp.execFileSync('git', ['-C', raiz, 'ls-files', '-z', '--cached', '--others', '--exclude-standard'], { encoding: 'utf8', maxBuffer: 1 << 26 }).split('\0').filter(Boolean);
  let r = analisar({ raiz, arquivos, lista, excecoes, aplicar, incluirAvisos: argv.includes('--incluir-avisos') });
  if (aplicar) { console.log(`trocas aplicadas: ${r.trocas} em ${r.alterados.length} arquivo(s)`); r.alterados.forEach(a => console.log('  alterado ' + a)); r = analisar({ raiz, arquivos, lista, excecoes }); }
  const pend = r.achados.filter(a => !a.excecao);
  const erros = pend.filter(a => a.nivel === 'erro'), avisos = pend.filter(a => a.nivel === 'aviso');
  if (argv.includes('--json')) console.log(JSON.stringify({ erros, avisos, excetuados: r.achados.length - pend.length }));
  else {
    const agrupar = l => { const g = new Map(); for (const a of l) { const k = a.arquivo + '  ' + a.cat; if (!g.has(k)) g.set(k, []); g.get(k).push(a.linha); } return [...g].map(([k, v]) => `  ${k}  linhas ${v.slice(0, 8).join(',')}${v.length > 8 ? ` (+${v.length - 8})` : ''}`); };
    console.log(`lista privada: ${lista ? 'SIM (' + lista.termos.length + ' termos)' : 'NAO (apenas checagens estruturais)'} · arquivos: ${arquivos.length}`);
    if (erros.length) console.log('ERROS:\n' + agrupar(erros).join('\n'));
    if (avisos.length) console.log('AVISOS (revisar):\n' + agrupar(avisos).join('\n'));
    console.log(`erros=${erros.length} avisos=${avisos.length} excetuados=${r.achados.length - pend.length}`);
  }
  return erros.length || (estrito && avisos.length) ? 1 : 0;
}

if (require.main === module) process.exitCode = principal(process.argv.slice(2));   // não cortar a saída em pipes
module.exports = { analisar, analisarCommits, normalizar, posicoes, comCaixa, pareceUid, cpfValido, principal };
