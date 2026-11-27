'use strict';
// Chrome sem janela pelo protocolo DevTools (extraído do roteiro do harness COM-02), sem dependências.
const fs = require('fs'), path = require('path'), { spawn } = require('child_process');
const CHROME = process.env.CHROME_BIN || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
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
  let seq = 0; const pend = new Map(), erros = [], hosts = new Set(), pedidos = new Map(), ouvintes = [];
  ws.onmessage = ev => {
    const m = JSON.parse(ev.data);
    if (m.id) { const p = pend.get(m.id); pend.delete(m.id); return m.error ? p.erro(new Error(m.error.message)) : p.ok(m.result); }
    for (const f of ouvintes) f(m);                                // eventos brutos para quem mede (peso, requisições)
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
      const topo = document.elementFromPoint(x, y), v = window.visualViewport;   // página mais larga que o celular desloca a área visível
      return { x: (x - (v ? v.offsetLeft : 0)) * (v ? v.scale : 1), y: (y - (v ? v.offsetTop : 0)) * (v ? v.scale : 1), livre: !!topo && (topo === el || el.contains(topo)) }; })()`);
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
  const ouvir = f => ouvintes.push(f);
  return { cmd, js, ate, tocar, tela, viewport, ir, erros, hosts, pedidos, ouvir, fechar };
}

module.exports = { abrirChrome, espera };
