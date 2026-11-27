#!/usr/bin/env node
'use strict';
// Mede o fluxo do vendedor na TELA REAL (Chrome sem janela, protocolo DevTools), em celular e computador, com dados fictícios.
// Antes (commit base) × depois (árvore de trabalho), com a mesma semente. Também confere o comportamento (falha = saída 1).
// Uso: sh scripts/dev/crm-adocao/rodar.sh /caminho/pasta        → <pasta>/medidas.json e imagens em <pasta>/telas/
//      VARIANTES=antes REDES=sem,4g SEM_CARGA=1 ...              → recorte (SEM_CARGA: só os roteiros; APENAS_CARGA=1: só a carga)
// Os tempos dependem da máquina e da rede até as bibliotecas públicas (Firebase, fontes): compare medianas e faixas.
const fs = require('fs'), path = require('path');
const { PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');
const { abrirChrome, espera } = require('../crm-revisao/chrome');
const { semear, servir } = require('./semente');
const SITE = `http://localhost:${PORTAS.site}`;
const VARIANTES = (process.env.VARIANTES || 'antes,depois').split(',');
const REDES = (process.env.REDES || 'sem,4g,3g').split(',');
const REPETICOES = { sem: 5, '4g': 3, '3g': 1 };   // carga: mediana, alternando antes/depois para a oscilação da máquina e da rede pesar igual
const REDE = {
  sem: { latency: 0, downloadThroughput: -1, uploadThroughput: -1, rotulo: 'sem limitação' },
  '4g': { latency: 150, downloadThroughput: 200000, uploadThroughput: 93750, rotulo: '4G lento (150 ms, 1,6 Mbit/s)' },
  '3g': { latency: 400, downloadThroughput: 50000, uploadThroughput: 50000, rotulo: '3G lento (400 ms, 400 kbit/s)' },
};
const APARELHOS = { celular: { w: 390, h: 844, mobile: true, cpu: 4 }, computador: { w: 1366, h: 700, mobile: false, cpu: 1 } };
const resultados = []; let falhas = 0;
const confere = (nome, ok, extra) => { const l = (ok ? 'OK    ' : 'FALHA ') + nome + (!ok && extra !== undefined ? ' → ' + JSON.stringify(extra) : ''); resultados.push(l); console.log(l); if (!ok) falhas++; };
const mediana = l => { const s = [...l].sort((a, b) => a - b); return s.length ? s[Math.floor(s.length / 2)] : null; };

const card = id => `document.querySelector('.card[data-id="${id}"]')`;
const noCard = (id, sel) => `document.querySelector('.card[data-id="${id}"] ${sel}')`;
const secao = k => `document.querySelector('.sec.${k}')`;
const idsDa = (B, k) => B.js(`Array.from(document.querySelectorAll('.sec.${k} .card')).map(c => c.dataset.id)`);

async function main() {
  const dir = pastaDeTrabalho(process.argv[2]);
  fs.mkdirSync(path.join(dir, 'telas'), { recursive: true });
  const qual = { pasta: 'site-' + VARIANTES[0] };
  let S = await semear(dir); const srv = await servir(dir, qual);
  const M = { geradoEm: new Date().toISOString(), redes: Object.fromEntries(REDES.map(r => [r, REDE[r].rotulo])), aparelhos: APARELHOS, variantes: {} };
  const erros = [], hosts = new Set(); let reaberturas = 0;

  async function sessao(aparelho, conta) {
    const A = APARELHOS[aparelho], B = await abrirChrome(dir);
    const rede = new Map(); let ultimo = Date.now(); const posts = [];
    B.ouvir(m => {
      const p = m.params || {};
      if (m.method === 'Network.requestWillBeSent' && /^https?:/.test(p.request.url)) { rede.set(p.requestId, { url: p.request.url, tipo: p.type, bytes: 0, metodo: p.request.method, t0: p.timestamp }); if (!p.request.url.includes(':' + PORTAS.firestore)) ultimo = Date.now(); if (p.request.method === 'POST' && p.request.url.includes(':' + PORTAS.functions + '/')) posts.push(p.request.url.split('/').pop()); }
      if (m.method === 'Network.dataReceived' && rede.has(p.requestId)) { const r = rede.get(p.requestId); r.parcial = (r.parcial || 0) + p.encodedDataLength; if (!r.url.includes(':' + PORTAS.firestore)) ultimo = Date.now(); }
      if (m.method === 'Network.loadingFinished' && rede.has(p.requestId)) { const r = rede.get(p.requestId); r.bytes = p.encodedDataLength; r.t1 = p.timestamp; if (!r.url.includes(':' + PORTAS.firestore)) ultimo = Date.now(); }
    });
    await B.viewport(A.w, A.h, A.mobile);
    const abrir = async (pagina, expr, rotulo, ms = 240000) => { await B.ir(SITE + pagina); return B.ate(expr, rotulo, ms); };
    await abrir('/login.html', `typeof window.fazerLogin === 'function' && !!document.querySelector('input[type=password]')`, 'login'); await espera(800);
    await B.js(`(() => { const c = ${JSON.stringify(S.contas[conta])}; const e = document.querySelector('input[type=email]'), s = document.querySelector('input[type=password]'); e.value = c.email; s.value = c.password; for (const x of [e, s]) x.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await B.tocar(`document.getElementById('btnEntrar')`, 'entrar'); await B.ate(`!!document.getElementById('logado')`, 'redirecionamento');
    // instrumentação: instante em que o 1º cartão e os indicadores aparecem; links do WhatsApp nunca navegam
    await B.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { window.__t = {}; window.__wa = [];
      new MutationObserver(() => { const t = window.__t; if (!t.cartao && document.querySelector('.card .card-nome, .queue-card')) t.cartao = performance.now();
        if (!t.indicadores) { const k = document.querySelectorAll('.kpi-v')[1]; if (k && /\\d/.test(k.textContent)) t.indicadores = performance.now(); } }).observe(document, { childList: true, subtree: true });
      document.addEventListener('click', e => { const a = e.target.closest && e.target.closest('a[href^="https://wa.me/"]'); if (a) { e.preventDefault(); window.__wa.push(a.getAttribute('href')); } }, true); })()` });
    await B.cmd('Network.setBlockedURLs', { urls: ['*wa.me*', '*whatsapp.com*'] });
    const quieto = async (ms = 3000, max = 240000) => { const fim = Date.now() + max; while (Date.now() - ultimo < ms && Date.now() < fim) await espera(200); };
    const CRM_PRONTO = `!!window.__t && !!window.__t.cartao && !!window.__t.indicadores`;
    // Emulador lento (máquina carregada): a tela não alcança o Firestore a tempo e volta ao login (comportamento atual do app).
    // Reabre a página; o número de reaberturas é informado no fim.
    const abrirTela = async (pagina, pronto, rotulo) => {
      for (let n = 1; ; n++) {
        const antes = B.erros.length;
        let v = null;
        try { v = await abrir(pagina, `(document.getElementById('logado') && 'voltou') || ((${pronto}) && 'ok')`, rotulo); } catch (e) { if (n >= 5) throw e; }
        if (v === 'ok') return;
        if (n >= 5) throw new Error('a tela voltou ao login 5 vezes: ' + rotulo);
        reaberturas++; B.erros.splice(antes); await espera(3000);
      }
    };
    const crm = async () => { await abrirTela('/modulos/crm.html', CRM_PRONTO, 'crm pronto'); await quieto(1500); };
    const carga = async (pagina, redeNome, pronto) => {
      await B.cmd('Network.clearBrowserCache'); await B.cmd('Emulation.setCPUThrottlingRate', { rate: A.cpu });
      await B.cmd('Network.emulateNetworkConditions', { offline: false, ...REDE[redeNome] });
      for (let n = 1; ; n++) {
        await B.ir('about:blank'); rede.clear(); posts.length = 0;
        const antes = B.erros.length, v = await abrir(pagina, `(document.getElementById('logado') && 'voltou') || ((${pronto}) && 'ok')`, 'carga ' + redeNome);
        if (v === 'ok') break;                                       // amostra que voltou ao login é descartada
        if (n >= 5) throw new Error('a tela voltou ao login 5 vezes na carga ' + redeNome);
        reaberturas++; B.erros.splice(antes); await B.cmd('Network.clearBrowserCache');
      }
      await quieto(4000);
      await B.js(`document.fonts.ready.then(() => 1)`); await quieto(1500);   // a fonte grande pode ficar segundos sem evento novo
      const t = await B.js('window.__t');
      const lista = [...rede.values()].filter(r => r.metodo !== 'OPTIONS' && r.tipo !== 'Preflight');
      const grupo = r => r.url.includes(':' + PORTAS.functions) ? 'functions' : r.url.includes(':' + PORTAS.firestore) || r.url.includes(':' + PORTAS.auth) ? 'firebase (dados/login)' : /fonts\.(gstatic|googleapis)/.test(r.url) ? 'fontes' : /www\.gstatic\.com/.test(r.url) ? 'SDK Firebase' : 'site';
      // fim dos downloads, pelo relógio do navegador, contado desde o pedido da página (não inclui a espera do roteiro)
      const inicio = Math.min(...lista.filter(r => r.tipo === 'Document').map(r => r.t0));
      const ate = l => Math.round(Math.max(inicio, ...l.map(r => r.t1 || inicio)) * 1000 - inicio * 1000);
      const icones = ate(lista.filter(r => /fonts\.gstatic\.com/.test(r.url) && !/\/s\/inter\//.test(r.url)));
      const completa = ate(lista.filter(r => !r.url.includes(':' + PORTAS.firestore)));
      const por = {}; for (const r of lista) { const g = grupo(r); por[g] = por[g] || { requisicoes: 0, bytes: 0 }; por[g].requisicoes++; por[g].bytes += r.bytes || r.parcial || 0; }
      const maiores = lista.map(r => ({ url: r.url.replace(/\?.*/, '').slice(0, 110), bytes: r.bytes || r.parcial || 0 })).sort((a, b) => b.bytes - a.bytes).slice(0, 5);
      await B.cmd('Network.emulateNetworkConditions', { offline: false, ...REDE.sem });
      return { requisicoes: lista.length, bytes: lista.reduce((s, r) => s + (r.bytes || r.parcial || 0), 0), por, maiores, primeiroCartaoMs: Math.round(t.cartao || 0), indicadoresMs: Math.round(t.indicadores || 0), iconesProntosMs: icones, paginaCompletaMs: completa };
    };
    const fim = async () => { erros.push(...B.erros); B.hosts.forEach(h => hosts.add(h)); await B.fechar(); };
    return { B, A, abrir, abrirTela, crm, carga, quieto, posts, fim };
  }

  for (const v of VARIANTES) M.variantes[v] = {};
  for (const aparelho of Object.keys(APARELHOS)) for (const v of VARIANTES) M.variantes[v][aparelho] = {};

  // ── Carga da página (V2, lista grande), cache vazio ───────────────────────────────────────────────
  for (const aparelho of process.env.SEM_CARGA ? [] : Object.keys(APARELHOS)) {
    S = await semear(dir);
    const s = await sessao(aparelho, 'v2');
    try {
      for (const v of VARIANTES) { qual.pasta = 'site-' + v; await s.crm(); }          // aquece Functions do emulador antes de medir
      for (const n of REDES) {
        const amostras = {};
        for (let i = 0; i < REPETICOES[n]; i++) for (const v of VARIANTES) {
          qual.pasta = 'site-' + v;
          const c = await s.carga('/modulos/crm.html', n, `!!window.__t && !!window.__t.cartao && !!window.__t.indicadores`);
          (amostras[v] = amostras[v] || []).push(c);
          console.log('carga', v, aparelho, n, i + 1, c.requisicoes, c.bytes, c.primeiroCartaoMs, c.indicadoresMs, c.iconesProntosMs, c.paginaCompletaMs);
        }
        for (const v of VARIANTES) {
          const a = amostras[v], med = k => mediana(a.map(x => x[k]));
          const r = M.variantes[v][aparelho]; r.carga = r.carga || {};
          r.carga[n] = { repeticoes: a.length, requisicoes: med('requisicoes'), bytes: med('bytes'), primeiroCartaoMs: med('primeiroCartaoMs'), indicadoresMs: med('indicadoresMs'), iconesProntosMs: med('iconesProntosMs'), paginaCompletaMs: med('paginaCompletaMs'),
            primeiroCartaoFaixaMs: [Math.min(...a.map(x => x.primeiroCartaoMs)), Math.max(...a.map(x => x.primeiroCartaoMs))], por: a[a.length - 1].por, maiores: a[a.length - 1].maiores };
        }
      }
      if (VARIANTES.includes('antes')) { qual.pasta = 'site-antes'; M.filaAnteriorCarga = M.filaAnteriorCarga || {}; M.filaAnteriorCarga[aparelho] = await s.carga('/modulos/fila-comercial.html', REDES.includes('4g') ? '4g' : REDES[0], `!!window.__t && !!window.__t.cartao`); }
    } catch (e) { confere(`${aparelho}: carga`, false, e.message); await s.B.tela(`falha-carga-${aparelho}`); }
    finally { await s.fim(); }
    fs.writeFileSync(path.join(dir, 'medidas.json'), JSON.stringify(M, null, 2));
  }

  for (const variante of process.env.APENAS_CARGA ? [] : VARIANTES) {
    qual.pasta = 'site-' + variante;
    for (const aparelho of Object.keys(APARELHOS)) {
      const r = M.variantes[variante][aparelho];
      // ── V2 (lista grande): carga, localização, responsividade ───────────────────────────────────────
      S = await semear(dir);
      let s = await sessao(aparelho, 'v2'); let B = s.B;
      try {
        await s.crm(); await B.cmd('Emulation.setCPUThrottlingRate', { rate: s.A.cpu });
        await B.js(`document.fonts.ready.then(() => 1)`); await B.js('window.scrollTo(0,0)'); await espera(400);
        r.tela = await B.js(`(() => { const h = innerHeight, cs = [...document.querySelectorAll('.card')], topo = el => el ? Math.round(el.getBoundingClientRect().top + scrollY) : null;
          const novas = [...document.querySelectorAll('.sec.novas .card')];
          return { cartoesNaPagina: cs.length, elementos: document.getElementsByTagName('*').length, alturaPx: document.documentElement.scrollHeight, telas: +(document.documentElement.scrollHeight / h).toFixed(1),
            primeiroCartaoPx: topo(cs[0]), cartoesInteirosNa1aTela: cs.filter(c => { const b = c.getBoundingClientRect(); return b.top >= 0 && b.bottom <= h; }).length,
            novasPx: topo(document.querySelector('.sec.novas')), novasTelas: +(topo(document.querySelector('.sec.novas')) / h).toFixed(1),
            alturaCartaoMediana: novas.map(c => Math.round(c.getBoundingClientRect().height)).sort((a,b)=>a-b)[Math.floor(novas.length/2)],
            larguraPagina: document.documentElement.scrollWidth, oferta: document.querySelectorAll('.card .oferta').length, atalhos: document.querySelectorAll('[data-a="ir"]').length }; })()`);
        // na tela de antes a largura é só MEDIDA (o cartão de reativação alargava a página no celular); depois é exigida
        if (variante === 'depois') confere(`${variante}/${aparelho}: sem rolagem lateral`, r.tela.larguraPagina <= s.A.w, r.tela.larguraPagina);
        await B.tela(`${variante}-${aparelho}-01-topo`);
        // chegar nas "Novas"
        if (r.tela.atalhos) {
          await B.tocar(`document.querySelector('[data-a="ir"][data-sec="novas"]')`, 'atalho novas'); await espera(500);
          r.irNovas = { toques: 1, visivel: await B.js(`(() => { const c = document.querySelector('.sec.novas .card').getBoundingClientRect(), t = document.querySelector('.topbar').getBoundingClientRect(); return c.top >= t.bottom - 1 && c.top < innerHeight - 80; })()`) };
          confere(`${variante}/${aparelho}: 1 toque leva às Novas, abaixo do cabeçalho`, r.irNovas.visivel);
        } else {
          r.irNovas = { toques: 0, rolagemPx: r.tela.novasPx - 60, rolagensDeDedo: Math.ceil((r.tela.novasPx - 60) / (s.A.h * 0.75)) };
          await B.js(`${secao('novas')}.scrollIntoView(); window.scrollBy(0, -${aparelho === 'celular' ? 110 : 70})`); await espera(300);
        }
        await B.tela(`${variante}-${aparelho}-02-novas`);
        // resposta ao toque (redesenho da lista inteira), CPU do aparelho
        const novas = await idsDa(B, 'novas'); const tempos = [];
        for (let i = 0; i < 5; i++) {
          tempos.push(await B.js(`(async () => { const b = ${noCard(novas[0], '[data-a="registrar"]')}; const t = performance.now(); b.click(); await new Promise(r => requestAnimationFrame(() => setTimeout(r, 0))); return Math.round(performance.now() - t); })()`));
          await B.js(`${noCard(novas[0], '[data-a="fecharReg"]')}.click()`); await espera(200);
        }
        r.respostaAoToqueMs = mediana(tempos);
        await B.cmd('Emulation.setCPUThrottlingRate', { rate: 1 });     // daqui em diante os roteiros medem toques e comportamento
        // "o que oferecer": sem abrir o cliente?
        const semOferta = !r.tela.oferta;
        const alvoOf = novas[1];
        if (semOferta) {
          const t0 = Date.now();
          await B.tocar(noCard(alvoOf, '[data-a="cliente"]'), 'ver cliente'); await B.ate(`!!document.getElementById('c-produtos')`, 'cliente', 60000);
          const ms = Date.now() - t0; await espera(300);
          const d = await B.js(`(() => { const c = document.getElementById('drBody'), p = document.getElementById('c-produtos'); return { px: Math.round(p.getBoundingClientRect().top - c.getBoundingClientRect().top), alturaVisivel: Math.round(c.clientHeight) }; })()`);
          r.oQueOferecer = { toques: 2, descricao: 'Ver cliente + rolar até Produtos + fechar', esperaMs: ms, rolagemDentroDoClientePx: d.px, telasDentroDoCliente: +(d.px / d.alturaVisivel).toFixed(1) };
          await B.js(`document.getElementById('c-produtos').scrollIntoView()`); await espera(250); await B.tela(`${variante}-${aparelho}-03-produtos-no-cliente`);
          await B.tocar(`document.getElementById('drFechar')`, 'fechar');
        } else {
          const q = await B.js(`(() => { const l = [...document.querySelectorAll('.sec.novas .card')]; return { com: l.filter(c => c.querySelector('.oferta')).length, total: l.length, texto: ${noCard(alvoOf, '.oferta')}.innerText }; })()`);
          r.oQueOferecer = { toques: 0, cartoesNovasComProdutos: q.com, deNovas: q.total, exemplo: q.texto };
          confere(`${variante}/${aparelho}: produtos do histórico no próprio cartão`, q.com === q.total && /fictíci/i.test(q.texto), q);
          await B.js(`${card(alvoOf)}.scrollIntoView({block:'center'})`); await espera(250); await B.tela(`${variante}-${aparelho}-03-produtos-no-cartao`);
        }
        // pendentes recolhidos (depois): expandir mostra todos, na mesma ordem
        if (variante === 'depois') {
          const antesN = await idsDa(B, 'pendentes');
          await B.tocar(`document.querySelector('[data-a="mais"][data-sec="pendentes"]')`, 'mostrar mais'); await espera(400);
          const todos = await idsDa(B, 'pendentes');
          r.pendentes = { visiveisAntes: antesN.length, visiveisDepois: todos.length };
          confere(`${variante}/${aparelho}: "mostrar todos" exibe os 142 pendentes na mesma ordem`, todos.length === 142 && antesN.every((id, i) => todos[i] === id), r.pendentes);
          await B.js('window.dispatchEvent(new Event("focus"))'); await B.tocar(`document.getElementById('btnAtualizar')`, 'atualizar'); await s.quieto(1500);
          confere(`${variante}/${aparelho}: expansão se mantém após atualizar`, (await idsDa(B, 'pendentes')).length === 142);
        }
        // Iniciar: o cartão continua à vista?
        const ini = (await idsDa(B, 'novas'))[2];
        await B.js(`${card(ini)}.scrollIntoView({block:'center'})`); await espera(200);
        await B.tocar(noCard(ini, '[data-a="iniciar"]'), 'iniciar');
        await B.ate(`!!(${card(ini)} && ${card(ini)}.closest('.sec.emAtendimento'))`, 'em atendimento', 60000); await espera(900);
        r.aposIniciar = await B.js(`(() => { const b = ${card(ini)}.getBoundingClientRect(); const vis = b.bottom > 60 && b.top < innerHeight; return { cartaoVisivel: vis, distanciaPx: vis ? 0 : Math.round(b.top < 0 ? -b.top : b.top - innerHeight), registroAberto: !!${card(ini)}.querySelector('.reg') }; })()`);
        r.aposIniciar.toquesAteSalvarContato = 1 + (r.aposIniciar.registroAberto ? 2 : 3);
        await B.tela(`${variante}-${aparelho}-04-apos-iniciar`);
        if (variante === 'depois') confere(`${variante}/${aparelho}: depois de Iniciar o cartão continua à vista`, r.aposIniciar.cartaoVisivel, r.aposIniciar);
      } catch (e) { confere(`${variante}/${aparelho}: roteiro V2`, false, e.message); await B.tela(`falha-${variante}-${aparelho}-v2`); }
      finally { await s.fim(); }

      // ── V1: registro por resultado, espera do servidor, contato/WhatsApp ───────────────────────────
      S = await semear(dir);
      s = await sessao(aparelho, 'v1'); B = s.B;
      try {
        await s.crm();
        let toques = 0; const tocar = async (sel, rot) => { toques++; return B.tocar(sel, rot); };
        r.registro = {};
        const novas = await idsDa(B, 'novas');
        const casos = ['CONVERSA_REALIZADA', 'SEM_RESPOSTA', 'PEDIU_RETORNO', 'SEM_INTERESSE_AGORA', 'CONTATO_INVALIDO'];
        for (let i = 0; i < casos.length; i++) {
          const outcome = casos[i], id = novas[i]; toques = 0; let picker = 0;
          await tocar(noCard(id, '[data-a="registrar"]'), 'registrar');
          await tocar(noCard(id, `[data-res="${outcome}"]`), outcome);
          if (i === 0) await B.tela(`${variante}-${aparelho}-05-registro`);
          if (outcome === 'PEDIU_RETORNO') {
            await tocar(noCard(id, 'input[type=date]'), 'campo data'); picker = 2;   // seletor nativo: escolher o dia + confirmar (não automatizável)
            const d = new Date(S.hoje + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + 3);
            await B.js(`(() => { const x = ${noCard(id, 'input[type=date]')}; x.value = ${JSON.stringify(d.toISOString().slice(0, 10))}; x.dispatchEvent(new Event('input', {bubbles:true})); })()`);
          }
          s.posts.length = 0; const t0 = Date.now();
          await tocar(noCard(id, '[data-a="salvar"]'), 'salvar');
          await B.ate(`!(${card(id)} && ${card(id)}.querySelector('.reg')) && (!${card(id)} || !!${card(id)}.closest('.sec.trabalhadasHoje'))`, 'salvo ' + outcome, 90000);
          const ms = Date.now() - t0; await s.quieto(1500);
          const doc = (await S.db.doc('interacoes_fila/' + id).get()).data();
          confere(`${variante}/${aparelho}: ${outcome} gravado pelo servidor`, !!doc && doc.eventos.some(e => e.outcome === outcome));
          const ev = doc.eventos.filter(e => e.outcome === outcome).pop();
          r.registro[outcome] = { toques: toques + picker, toquesNoSeletorDeData: picker, esperaMs: ms, chamadas: s.posts.slice(), camposDoEvento: Object.keys(ev).sort(), meta: Object.keys(ev.meta || {}).sort() };
        }
        // espera do servidor em 4G lento
        const id4 = novas[5];
        await B.tocar(noCard(id4, '[data-a="registrar"]'), 'registrar'); await B.tocar(noCard(id4, '[data-res="CONVERSA_REALIZADA"]'), 'contato');
        await B.cmd('Network.emulateNetworkConditions', { offline: false, ...REDE['4g'] });
        let t0 = Date.now(); await B.tocar(noCard(id4, '[data-a="salvar"]'), 'salvar');
        await B.ate(`!(${card(id4)} && ${card(id4)}.querySelector('.reg')) && (!${card(id4)} || !!${card(id4)}.closest('.sec.trabalhadasHoje'))`, 'salvo 4g', 120000);
        r.registro.esperaContato4gMs = Date.now() - t0;
        await B.cmd('Network.emulateNetworkConditions', { offline: false, ...REDE.sem }); await s.quieto(1500);
        // telefone / WhatsApp (só reativação)
        r.contato = await B.js(`(() => { const c = [...document.querySelectorAll('.card')]; return { cartoes: c.length, comBotaoTelefone: c.filter(x => x.querySelector('[data-a="contato"]')).length }; })()`);
        const re = (await idsDa(B, 'reativacoes'))[0];
        t0 = Date.now(); await B.tocar(noCard(re, '[data-a="contato"]'), 'ver telefone'); await B.ate(`!!${noCard(re, 'a[href^="https://wa.me/"]')}`, 'link do WhatsApp', 60000);
        r.contato.esperaTelefoneMs = Date.now() - t0;
        await B.tocar(noCard(re, 'a[href^="https://wa.me/"]'), 'abrir whatsapp');
        r.contato.toquesAteWhatsApp = 2; r.contato.link = await B.js('window.__wa[0]');
        confere(`${variante}/${aparelho}: WhatsApp abre sem mensagem pronta (link wa.me simples)`, /^https:\/\/wa\.me\/55\d{11}$/.test(r.contato.link), r.contato.link);
        const rasc = (await idsDa(B, 'novas'))[0];
        await B.tocar(noCard(rasc, '[data-a="registrar"]'), 'registrar'); await B.tocar(noCard(rasc, '[data-res="CONVERSA_REALIZADA"]'), 'contato');
        await B.js(`(() => { const t = ${noCard(rasc, 'textarea')}; t.value = 'rascunho fictício'; t.dispatchEvent(new Event('input', {bubbles:true})); document.dispatchEvent(new Event('visibilitychange')); })()`); await espera(500);
        r.contato.voltaSemRecarregar = await B.js(`({ rascunho: ${noCard(rasc, 'textarea')}.value === 'rascunho fictício', telefone: !!${noCard(re, 'a[href^="https://wa.me/"]')} })`);
        await s.crm();
        r.contato.voltaComRecarga = await B.js(`({ rascunho: !!document.querySelector('.reg textarea'), telefone: !!document.querySelector('a[href^="https://wa.me/"]'), rolagemPx: Math.round(scrollY) })`);
        const cli = (await idsDa(B, 'novas'))[0];
        await B.tocar(noCard(cli, '[data-a="cliente"]'), 'cliente'); await B.ate(`!!document.getElementById('c-produtos')`, 'cliente', 60000);
        r.contato.telefoneNoClienteSemReativacao = await B.js(`!!document.querySelector('#drSub [data-a="copiar"]') || !!document.querySelector('#drSub a[href^="https://wa.me/"]')`);
        await B.tocar(`document.getElementById('drFechar')`, 'fechar');
        // retornos rápidos e agenda
        await B.tocar(`document.getElementById('tabAgenda')`, 'agenda'); await espera(500); await B.tela(`${variante}-${aparelho}-06-agenda`);
        await B.tocar(`document.getElementById('tabHoje')`, 'hoje');
        // Fila (versão anterior): toques por contato realizado
        r.filaAnterior = {};
        await s.abrirTela('/modulos/fila-comercial.html', `!!document.querySelector('#listaNovas .btn-claim')`, 'fila'); await s.quieto(1500); toques = 0;
        const fid = await B.js(`document.querySelector('#listaNovas .btn-claim').dataset.oppid`);
        await tocar(`document.querySelector('.btn-claim[data-oppid="${fid}"]')`, 'iniciar');
        await B.ate(`!!document.querySelector('#listaEmAtendimento .queue-card')`, 'em atendimento', 60000); await espera(600);
        await tocar(`document.querySelector('#listaEmAtendimento .queue-card')`, 'abrir');
        await tocar(`document.getElementById('detailOutcomeBtn')`, 'registrar');
        await tocar(`document.querySelector('[data-outcome="CONVERSA_REALIZADA"]')`, 'contato');
        await tocar(`document.getElementById('outcomeOkBtn')`, 'confirmar');
        await B.ate(`!document.getElementById('outcomeModal').classList.contains('open')`, 'confirmado', 60000);
        r.filaAnterior.toquesContato = toques;
      } catch (e) { confere(`${variante}/${aparelho}: roteiro V1`, false, e.message); await B.tela(`falha-${variante}-${aparelho}-v1`); }
      finally { await s.fim(); }
      fs.writeFileSync(path.join(dir, 'medidas.json'), JSON.stringify(M, null, 2));
    }
  }
  // a captura gravada é a mesma antes e depois (nenhum campo novo no evento)
  if (VARIANTES.length === 2 && !process.env.APENAS_CARGA) for (const ap of Object.keys(APARELHOS)) {
    const a = M.variantes.antes[ap].registro, d = M.variantes.depois[ap].registro;
    for (const o of ['CONVERSA_REALIZADA', 'SEM_RESPOSTA', 'PEDIU_RETORNO', 'SEM_INTERESSE_AGORA', 'CONTATO_INVALIDO'])
      confere(`${ap}: ${o} grava os mesmos campos antes e depois`, !!a && !!d && !!a[o] && !!d[o] && JSON.stringify([a[o].camposDoEvento, a[o].meta]) === JSON.stringify([d[o].camposDoEvento, d[o].meta]));
  }
  const externos = [...hosts].filter(h => !/^localhost:|^127\.0\.0\.1:|^fonts\.(googleapis|gstatic)\.com$|^www\.gstatic\.com$/.test(h));
  confere('nenhum acesso a serviço de produção', externos.length === 0, externos);
  confere('console sem erros', erros.length === 0, erros.slice(0, 5));
  srv.close();
  M.verificacoes = resultados; M.falhas = falhas; M.reaberturasPorEmuladorLento = reaberturas;
  fs.writeFileSync(path.join(dir, 'medidas.json'), JSON.stringify(M, null, 2));
  console.log(`\n${resultados.length} verificações, ${falhas} falha(s). Reaberturas por emulador lento: ${reaberturas}. Projeto ${PROJETO}.`);
  process.exit(falhas ? 1 : 0);
}
main().catch(e => { console.error('ERRO:', e.stack || e.message); process.exit(1); });
