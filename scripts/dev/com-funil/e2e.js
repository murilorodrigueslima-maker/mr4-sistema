#!/usr/bin/env node
'use strict';
// Roteiro automatizado no Chrome sem janela (protocolo DevTools), contra os emuladores do harness. Dados fictícios.
// Pré-requisitos: preparar.js executado e emuladores no ar. Uso: node scripts/dev/com-funil/e2e.js /caminho/pasta
// Saída: resultado de cada verificação + imagens em <pasta>/telas/.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const { RAIZ, PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');
const { semear, servir } = require('./semente');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const SITE = `http://localhost:${PORTAS.site}`;
const espera = ms => new Promise(r => setTimeout(r, ms));

async function abrirChrome(dir) {
  const perfil = fs.mkdtempSync(path.join(dir, 'chrome-'));          // perfil novo a cada execução
  const proc = spawn(CHROME, ['--headless=new', '--remote-debugging-port=0', '--user-data-dir=' + perfil, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--use-mock-keychain', '--password-store=basic', 'about:blank'], { stdio: 'ignore' });
  const arq = path.join(perfil, 'DevToolsActivePort');
  for (let i = 0; i < 1200 && !fs.existsSync(arq); i++) await espera(100);   // até 2 min em máquina carregada
  if (!fs.existsSync(arq)) { proc.kill('SIGKILL'); throw new Error('o Chrome não abriu a porta de depuração'); }
  const porta = fs.readFileSync(arq, 'utf8').split('\n')[0];
  const alvo = (await (await fetch(`http://127.0.0.1:${porta}/json/list`)).json()).find(t => t.type === 'page');
  const ws = new WebSocket(alvo.webSocketDebuggerUrl);
  await new Promise((ok, erro) => { ws.onopen = ok; ws.onerror = erro; });
  let seq = 0; const pend = new Map(), erros = [], hosts = new Set(), pedidos = new Map();
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id) { const p = pend.get(m.id); pend.delete(m.id); return m.error ? p.erro(new Error(m.error.message)) : p.ok(m.result); }
    if (m.method === 'Runtime.exceptionThrown') erros.push(m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text);
    if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') erros.push(m.params.args.map(a => a.value || a.description || '').join(' '));
    if (m.method === 'Network.requestWillBeSent' && /^(https?|wss?):/.test(m.params.request.url)) { const u = new URL(m.params.request.url); hosts.add(u.host); pedidos.set(m.params.requestId, u.host + u.pathname); }
    if (m.method === 'Network.loadingFinished' || m.method === 'Network.loadingFailed') pedidos.delete(m.params.requestId);
  };
  const cmd = (method, params = {}) => new Promise((ok, erro) => { const id = ++seq; pend.set(id, { ok, erro }); ws.send(JSON.stringify({ id, method, params })); });
  for (const d of ['Page', 'Runtime', 'Network']) await cmd(d + '.enable');
  const js = async expr => { const r = await cmd('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true }); if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text); return r.result.value; };
  const ate = async (expr, rotulo, ms = 120000) => { const fim = Date.now() + ms; for (;;) { let v = false; try { v = await js(expr); } catch (_) { /* navegando */ } if (v) return v; if (Date.now() > fim) throw new Error('tempo esgotado: ' + rotulo); await espera(150); } };
  /** Toque real (evento de mouse no centro do elemento), conferindo que nada o cobre. */
  const tocar = async (seletorJs, rotulo) => {
    await ate(`!!(${seletorJs})`, rotulo);
    const medir = () => js(`(() => { const el = ${seletorJs}; if (!el) return null; el.scrollIntoView({block:'center'}); const r = el.getBoundingClientRect(), x = r.left + r.width/2, y = r.top + r.height/2;
      const topo = document.elementFromPoint(x, y); return { x, y, livre: !!topo && (topo === el || el.contains(topo)) }; })()`);
    // espera a posição estabilizar (painéis deslizam) e exige que nada cubra o elemento
    let p = null; const fim = Date.now() + 5000;
    for (;;) {
      const antes = await medir(); await espera(120); p = await medir();
      if (p && antes && p.livre && Math.abs(p.x - antes.x) < 1 && Math.abs(p.y - antes.y) < 1) break;
      if (Date.now() > fim) throw new Error('elemento coberto ou fora da tela: ' + rotulo);
    }
    for (const type of ['mousePressed', 'mouseReleased']) await cmd('Input.dispatchMouseEvent', { type, x: p.x, y: p.y, button: 'left', clickCount: 1 });
    return p;
  };
  const tela = async (nome) => { const r = await cmd('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(dir, 'telas', nome + '.png'), Buffer.from(r.data, 'base64')); };
  const viewport = (width, height, mobile) => cmd('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: mobile ? 2 : 1, mobile });
  const ir = async url => { await cmd('Page.navigate', { url }); await espera(300); };
  const fechar = async () => {
    const saiu = new Promise(r => proc.once('exit', r));
    cmd('Browser.close').catch(() => {});
    await Promise.race([saiu, espera(5000)]); proc.kill('SIGKILL'); ws.close();
    try { fs.rmSync(perfil, { recursive: true, force: true, maxRetries: 3 }); } catch (_) { /* limpeza do perfil temporário */ }
  };
  return { cmd, js, ate, tocar, tela, viewport, ir, erros, hosts, pedidos, fechar };
}

async function main() {
  const dir = pastaDeTrabalho(process.argv[2]);
  fs.mkdirSync(path.join(dir, 'telas'), { recursive: true });
  const S = await semear(dir), srv = await servir(dir), B = await abrirChrome(dir);   // a senha de teste nunca é impressa
  const resultados = []; let falhas = 0;
  const confere = (nome, ok, extra) => { resultados.push((ok ? 'OK    ' : 'FALHA ') + nome + (!ok && extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); if (!ok) falhas++; };
  const doc = async i => (await S.db.doc('interacoes_fila/' + S.opps[i]).get()).data();
  const metaDe = async (i, outcome) => { for (const fim = Date.now() + 120000; Date.now() < fim;) { const d = await doc(i); const e = d && d.eventos.slice(-1)[0]; if (e && e.outcome === outcome) { const m = { ...(e.meta || {}) }; delete m.requestId; return m; } await espera(150); } throw new Error('resultado não gravado: ' + i); };
  const igual = (a, b) => JSON.stringify(Object.entries(a).sort()) === JSON.stringify(Object.entries(b).sort());
  // a lista é redesenhada quando chega resposta do servidor; um toque no meio do redesenho se perde → esperar a tela assentar
  const assentar = async () => { let livre = 0; for (const fim = Date.now() + 120000; Date.now() < fim;) { const aberto = [...B.pedidos.values()].some(u => u.startsWith(`localhost:${PORTAS.functions}/`));
    livre = aberto ? 0 : livre + 1; if (livre >= 15) return; await espera(100); } throw new Error('chamadas ao servidor não terminaram'); };
  // Emulador lento (máquina carregada): a tela não alcança o Firestore em 10 s e volta ao login (comportamento atual do app).
  // Reabre a página e descarta o aviso dessa tentativa; o número de reaberturas é informado.
  let reaberturas = 0;
  const abrir = async (pagina, expr, rotulo) => {
    for (let n = 1; ; n++) {
      const antes = B.erros.length;
      await B.ir(SITE + pagina);
      try { return await B.ate(expr, rotulo, 45000); }
      catch (e) { if (n >= 4) throw e; reaberturas++; B.erros.splice(antes); }
    }
  };
  const semRolagemLateral = () => B.js('document.documentElement.scrollWidth <= window.innerWidth + 1');
  try {
    await B.viewport(390, 844, true);
    await B.ir(SITE + '/login.html');
    await B.ate(`document.querySelector('input[type=email]') && document.querySelector('input[type=password]')`, 'login');
    await espera(800);
    await B.js(`(() => { const c = ${JSON.stringify(S.credencial)}; const e = document.querySelector('input[type=email]'), s = document.querySelector('input[type=password]'); e.value = c.email; s.value = c.password;
      for (const x of [e, s]) x.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await B.tocar(`document.getElementById('btnEntrar')`, 'entrar');
    await B.ate(`!!document.getElementById('logado')`, 'redirecionamento após login');
    confere('login no emulador', true);

    // ── CRM (celular) ────────────────────────────────────────────────────────────────────────────
    const card = i => `document.querySelector('article.card[data-id="${S.opps[i]}"]')`;
    const bt = (i, sel) => `${card(i)} && ${card(i)}.querySelector('${sel}')`;
    const perguntas = i => B.js(`Array.from(${card(i)}.querySelectorAll('.cap')).map(x => x.getAttribute('aria-label'))`);
    await abrir('/modulos/crm.html', `!!${card(0)}`, 'cartões do CRM');
    await B.ate(`document.getElementById('vivoStatus').textContent.includes('ao vivo')`, 'sinalizador ao vivo');
    confere('CRM carrega a lista e o ao vivo (merge com o CRM sem polling)', true);
    for (const w of [320, 360, 390]) {
      await B.viewport(w, 740, true); await espera(300);
      confere(`CRM ${w}px: página não fica mais larga que a tela`, await B.js(`document.documentElement.scrollWidth <= ${w}`), await B.js('document.documentElement.scrollWidth'));
    }
    await B.viewport(390, 844, true);
    for (const w of [320, 360, 390]) {
      await B.viewport(w, 844, true); await espera(300);
      console.log('DIAG', w, await B.js(`JSON.stringify({iw: innerWidth, sw: document.documentElement.scrollWidth, vv: [visualViewport.width, visualViewport.height, visualViewport.scale, visualViewport.offsetTop], sy: scrollY, hdr: Array.from(document.querySelector('.topbar').children).map(e => [e.id || e.className, Math.round(e.getBoundingClientRect().left), Math.round(e.getBoundingClientRect().right)])})`));
    }
    await B.viewport(390, 844, true);
    await B.tocar(bt(0, '[data-a="registrar"]'), 'registrar 1');
    await B.tocar(bt(0, '[data-res="CONVERSA_REALIZADA"]'), 'contato realizado');
    confere('CRM: contato realizado mostra as duas perguntas opcionais', (await perguntas(0)).length === 2, await perguntas(0));
    confere('CRM: salvar habilitado sem responder nada', await B.js(`!${card(0)}.querySelector('[data-a="salvar"]').disabled`));
    await B.tocar(bt(0, '[data-campo="interesse"][data-v="SIM"]'), 'interesse sim');
    confere('CRM: foco permanece no botão tocado após redesenhar', await B.js(`document.activeElement && document.activeElement.dataset.campo === 'interesse'`));
    await B.tocar(bt(0, '[data-campo="proposta"][data-v="NAO"]'), 'proposta não');
    await B.js(`(() => { const t = ${card(0)}.querySelector('textarea'); t.value = 'observação fictícia'; t.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await B.tocar(bt(0, '[data-res="PEDIU_RETORNO"]'), 'pediu retorno'); await B.tocar(bt(0, '[data-res="CONVERSA_REALIZADA"]'), 'volta');
    confere('CRM: trocar o resultado preserva respostas e observação', await B.js(`${card(0)}.querySelector('[data-campo="interesse"][data-v="SIM"]').getAttribute('aria-pressed') === 'true' && ${card(0)}.querySelector('textarea').value === 'observação fictícia'`));
    confere('CRM celular: sem rolagem lateral', await semRolagemLateral());
    await B.js(`${card(0)}.querySelector('.reg').scrollIntoView({block:'center'})`); await espera(200); await B.tela('01-crm-celular-perguntas');
    await B.tocar(bt(0, '[data-a="salvar"]'), 'salvar 1');
    let m = await metaDe(0, 'CONVERSA_REALIZADA');
    confere('CRM → servidor: interesse SIM, proposta NAO gravados', igual(m, { interesse: 'SIM', proposta: 'NAO', temNota: true }), m);
    await B.ate(`!!document.querySelector('section.trabalhadasHoje article[data-id="${S.opps[0]}"]')`, 'cartão em Trabalhados hoje');
    confere('CRM: cartão vai para "Trabalhados hoje" após salvar', true);

    await B.tocar(bt(1, '[data-a="registrar"]'), 'registrar 2');
    await B.tocar(bt(1, '[data-res="CONVERSA_REALIZADA"]'), 'contato');
    await B.tocar(bt(1, '[data-campo="interesse"][data-v="SIM"]'), 'sim');
    await B.tocar(bt(1, '[data-res="SEM_RESPOSTA"]'), 'sem resposta');
    confere('CRM: sem resposta não mostra perguntas', (await perguntas(1)).length === 0);
    await B.tocar(bt(1, '[data-a="salvar"]'), 'salvar 2');
    m = await metaDe(1, 'SEM_RESPOSTA');
    confere('CRM: resposta antiga não vaza para resultado incompatível', igual(m, {}), m);

    await assentar();
    await B.tocar(bt(2, '[data-a="registrar"]'), 'registrar 3');
    await B.tocar(bt(2, '[data-res="CONVERSA_REALIZADA"]'), 'contato 3');
    const marcado = () => B.js(`${card(2)}.querySelector('[data-campo="proposta"][data-v="SIM"]').getAttribute('aria-pressed')`);
    await assentar();
    await B.tocar(bt(2, '[data-campo="proposta"][data-v="SIM"]'), 'marca'); confere('CRM: toque marca a resposta', await marcado() === 'true');
    await B.tocar(bt(2, '[data-campo="proposta"][data-v="SIM"]'), 'desmarca'); confere('CRM: segundo toque desmarca', await marcado() === 'false');
    await B.tocar(bt(2, '[data-a="salvar"]'), 'salvar 3');
    m = await metaDe(2, 'CONVERSA_REALIZADA');
    confere('CRM: tocar de novo desmarca; evento sem campos (igual ao anterior)', igual(m, {}), m);

    await assentar();
    await B.viewport(1280, 900, false);
    await B.tocar(bt(3, '[data-a="registrar"]'), 'registrar desktop');
    await B.tocar(bt(3, '[data-res="SEM_INTERESSE_AGORA"]'), 'sem interesse');
    confere('CRM: "sem interesse" pergunta só a proposta', igual((await perguntas(3)).reduce((a, x) => ({ ...a, [x]: 1 }), {}), { 'Enviou orçamento ou proposta?': 1 }), await perguntas(3));
    await B.tela('02-crm-computador-sem-interesse');
    await B.tocar(bt(3, '[data-a="fecharReg"]'), 'cancelar');

    // ── Fila Comercial (celular baixo, como teclado aberto) ──────────────────────────────────────
    await B.viewport(360, 640, true);
    const item = i => `Array.from(document.querySelectorAll('.queue-card')).find(c => c.textContent.includes(${JSON.stringify(S.nomes[i])}))`;
    await abrir('/modulos/fila-comercial.html', `!!(${item(3)})`, 'cartões da fila');
    await B.tocar(`(${item(3)}).querySelector('.btn-claim')`, 'iniciar atendimento');
    await B.ate(`(${item(3)}) && (${item(3)}).textContent.includes('Em atendimento por você')`, 'em atendimento');
    const abrirModal = async i => {
      await B.tocar(`(${item(i)}).querySelector('.card-nome')`, 'abrir detalhe');
      await B.tocar(`Array.from(document.querySelectorAll('#detailBody button')).find(b => /Registrar resultado/i.test(b.textContent))`, 'registrar no detalhe');
      await B.ate(`document.getElementById('outcomeModal').classList.contains('open')`, 'modal');
    };
    const opcao = o => `document.querySelector('[data-outcome="${o}"]')`;
    const campos = () => B.js(`Object.fromEntries(Array.from(document.querySelectorAll('#capturaSection select')).map(s => [s.dataset.campo, s.value]))`);
    await abrirModal(3);
    confere('Fila: modal abre sem perguntas antes de escolher o resultado', igual(await campos(), {}));
    await B.tocar(opcao('PEDIU_RETORNO'), 'pediu retorno');
    await B.js(`(() => { const d = new Date(); d.setDate(d.getDate() + 3); document.getElementById('followupDate').value = d.toISOString().slice(0,10); })()`);
    await B.js(`(() => { for (const [k, v] of [['interesse','SIM'],['proposta','SIM']]) { const s = document.getElementById('cap-' + k); s.value = v; s.dispatchEvent(new Event('change', {bubbles:true})); } })()`);
    await B.tocar(opcao('SEM_RESPOSTA'), 'troca'); confere('Fila: sem resposta esconde as perguntas', igual(await campos(), {}));
    await B.tocar(opcao('PEDIU_RETORNO'), 'volta');
    confere('Fila: trocar o resultado preserva as respostas', igual(await campos(), { interesse: 'SIM', proposta: 'SIM' }), await campos());
    const selects = await B.js(`Array.from(document.querySelectorAll('#capturaSection select')).map(s => [parseFloat(getComputedStyle(s).fontSize), Math.round(s.offsetHeight)])`);   // offsetHeight ignora a animação de escala
    confere('Fila celular: seletores com 16px (sem zoom no iPhone) e área de toque ≥ 44px', selects.length === 2 && selects.every(([f, h]) => f >= 16 && h >= 44), selects);
    confere('Fila celular: modal cabe na tela e rola por dentro', await B.js(`(() => { const r = document.querySelector('.modal-box').getBoundingClientRect(); return r.top >= 0 && r.bottom <= window.innerHeight + 1; })()`));
    confere('Fila celular: sem rolagem lateral', await semRolagemLateral());
    await B.js(`document.getElementById('cap-proposta').scrollIntoView({block:'center'})`); await espera(200); await B.tela('03-fila-celular-modal');
    await B.tocar(`document.getElementById('outcomeOkBtn')`, 'confirmar');
    m = await metaDe(3, 'PEDIU_RETORNO');
    confere('Fila → servidor: retorno + interesse e proposta gravados', m.interesse === 'SIM' && m.proposta === 'SIM' && !!m.scheduledFor, m);
    await B.ate(`!document.getElementById('outcomeModal').classList.contains('open')`, 'modal fechado');
    await B.tocar(`document.getElementById('detailClose')`, 'fechar detalhe');

    await B.tocar(`(${item(4)}).querySelector('.btn-claim')`, 'iniciar 5');
    await B.ate(`(${item(4)}) && (${item(4)}).textContent.includes('Em atendimento por você')`, 'em atendimento 5');
    await abrirModal(4);
    await B.tocar(opcao('CONVERSA_REALIZADA'), 'contato');
    confere('Fila: respostas do atendimento anterior não reaparecem', igual(await campos(), { interesse: '', proposta: '' }), await campos());
    await B.tela('04-fila-celular-sem-resposta-marcada');
    await B.tocar(`document.getElementById('outcomeOkBtn')`, 'confirmar sem responder');
    m = await metaDe(4, 'CONVERSA_REALIZADA');
    confere('Fila: "Não informar" não grava campo', igual(m, {}), m);

    // ── JavaScript antigo em cache + HTML novo: a tela segue como antes ──────────────────────────
    const aux = path.join(dir, 'site/modulos/fila-worklist-view.js'), novo = fs.readFileSync(aux);
    fs.copyFileSync(path.join(dir, 'fila-worklist-view.antigo.js'), aux);
    try {
      await B.viewport(390, 844, true);
      await abrir('/modulos/crm.html', `!!${card(5)}`, 'cartão 6');
      await B.tocar(bt(5, '[data-a="registrar"]'), 'registrar 6');
      await B.tocar(bt(5, '[data-res="CONVERSA_REALIZADA"]'), 'contato 6');
      confere('JS antigo em cache: sem perguntas', (await perguntas(5)).length === 0);
      await B.tocar(bt(5, '[data-a="salvar"]'), 'salvar 6');
      m = await metaDe(5, 'CONVERSA_REALIZADA');
      confere('JS antigo em cache: registro funciona como antes', igual(m, {}), m);
    } finally { fs.writeFileSync(aux, novo); }

    // ── Servidor direto: cliente antigo e payload inválido ───────────────────────────────────────
    const token = (await (await fetch(`http://127.0.0.1:${PORTAS.auth}/identitytoolkit.googleapis.com/v1/accounts:signInWithPassword?key=ficticia`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ ...S.credencial, returnSecureToken: true }) })).json()).idToken;
    const chamar = async (nome, data) => (await fetch(`http://127.0.0.1:${PORTAS.functions}/${PROJETO}/southamerica-east1/${nome}`, { method: 'POST', headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + token }, body: JSON.stringify({ data }) })).json();
    const op = S.opps[2]; await S.db.doc('interacoes_fila/' + op).delete();
    await chamar('claimOpportunity', { opportunityInstanceId: op });
    for (const extra of [{ interesse: 'TALVEZ' }, { proposta: true }, { interesse: '' }, { outcome: 'CONTATO_INVALIDO', proposta: 'SIM' }, { valorProposta: 10 }]) {
      const r = await chamar('registerOutcome', { opportunityInstanceId: op, outcome: 'CONVERSA_REALIZADA', ...extra });
      confere('servidor recusa ' + JSON.stringify(extra), r.error && r.error.status === 'INVALID_ARGUMENT', r);
    }
    confere('após as recusas nada foi gravado', (await doc(2)).estado === 'EM_ATENDIMENTO' && (await doc(2)).eventos.length === 1);
    const antigo = await chamar('registerOutcome', { opportunityInstanceId: op, outcome: 'CONVERSA_REALIZADA' });
    confere('cliente antigo (sem os campos) continua aceito', antigo.result && antigo.result.estado === 'CONCLUIDA', antigo);

    const permitidos = [`localhost:${PORTAS.site}`, `localhost:${PORTAS.firestore}`, `localhost:${PORTAS.auth}`, `localhost:${PORTAS.functions}`, 'www.gstatic.com', 'fonts.googleapis.com', 'fonts.gstatic.com'];
    const fora = [...B.hosts].filter(h => !permitidos.includes(h));
    confere('navegador só falou com emuladores, SDK e fontes públicas', fora.length === 0, fora);
    confere('sem erros de JavaScript no console', B.erros.length === 0, B.erros.slice(0, 5));
  } catch (e) {
    falhas++; resultados.push('FALHA roteiro interrompido: ' + e.message); try { await B.tela('99-falha'); } catch (_) { /* sem tela */ }
    if (B.erros.length) resultados.push('console: ' + JSON.stringify(B.erros.slice(0, 8)));
    resultados.push('pendentes na rede: ' + JSON.stringify([...B.pedidos.values()].slice(0, 12)));
  } finally { await B.fechar(); srv.close(); }
  console.log(resultados.join('\n'));
  if (reaberturas) console.log(`aviso: ${reaberturas} reabertura(s) de página por emulador lento`);
  console.log(`\n${resultados.filter(r => r.startsWith('OK')).length} OK, ${falhas} falha(s). Imagens em ${path.join(dir, 'telas')}`);
  process.exit(falhas ? 1 : 0);
}
main().catch(e => { console.error('ERRO:', e); process.exit(1); });
