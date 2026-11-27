'use strict';
// Isolamento dos testes: nenhuma conexão sai do emulador isolado / servidores do próprio teste; nada de porta fixa de outro projeto.
const net = require('net'), http = require('http'), fs = require('fs'), path = require('path'), cp = require('child_process');
const { destino } = require('./_ambiente/guarda');
const { doBloco, PROIBIDAS } = require('./_ambiente/portas');
const tentar = (porta, host) => new Promise(r => { const s = net.connect({ port: porta, host }); s.once('connect', () => { s.destroy(); r('CONECTOU'); }); s.once('error', e => r(e.code)); });

describe('trava de rede', () => {
  test('porta do outro projeto (8080), outras portas locais e destinos externos são recusados antes de sair', async () => {
    for (const [porta, host] of [[8080, 'localhost'], [8080, '127.0.0.1'], [8080, '::1'], [5173, '127.0.0.1'], [443, 'firestore.googleapis.com'], [443, 'api.gestaoclick.com'], [80, '169.254.169.254']]) {
      expect([porta, host, await tentar(porta, host)]).toEqual([porta, host, 'MR4_GUARDA']);
    }
  });
  test('fetch e http para fora também são recusados', async () => {
    await expect(fetch('https://api.gestaoclick.com/vendas')).rejects.toThrow();
    await expect(fetch('http://127.0.0.1:8080/')).rejects.toThrow();
    const erro = await new Promise(r => http.get('http://example.com/', () => r(null)).on('error', r));
    expect(erro.code).toBe('MR4_GUARDA');
  });
  test('servidor aberto pelo próprio teste continua acessível', async () => {
    const srv = http.createServer((q, s) => s.end('ok'));
    await new Promise(r => srv.listen(0, '127.0.0.1', r));
    try { expect(await (await fetch(`http://127.0.0.1:${srv.address().port}/`)).text()).toBe('ok'); } finally { srv.close(); }
  });
  test('não é possível abrir servidor na porta proibida', () => expect(() => http.createServer().listen(8080)).toThrow(/outro projeto/));
  test('processo filho herda a trava', () => {
    const r = cp.spawnSync(process.execPath, ['-e', "require('net').connect(8080,'127.0.0.1').on('error',e=>{console.log(e.code);process.exit(0)}).on('connect',()=>{console.log('CONECTOU');process.exit(1)})"], { encoding: 'utf8' });
    expect(r.stdout.trim()).toBe('MR4_GUARDA');
  });
  test('leitura do destino cobre as formas de chamada', () => {
    expect(destino([{ port: 8080 }])).toEqual({ host: 'localhost', porta: 8080 });
    expect(destino([[{ port: '443', host: 'x.test' }, () => {}]])).toEqual({ host: 'x.test', porta: 443 });
    expect(destino([9, '10.0.0.1'])).toEqual({ host: '10.0.0.1', porta: 9 });
    expect(destino(['/tmp/s.sock'])).toBeNull();
  });
});

describe('ambiente e arquivos', () => {
  test('credenciais e tokens reais não estão no ambiente; emulador só local', () => {
    expect(Object.keys(process.env).filter(k => /^(GOOGLE_APPLICATION_CREDENTIALS|FIREBASE_TOKEN|GITHUB_TOKEN|GH_TOKEN|GC_|GESTAOCLICK)/.test(k))).toEqual([]);
    for (const k of ['FIRESTORE_EMULATOR_HOST', 'FIREBASE_AUTH_EMULATOR_HOST']) if (process.env[k]) expect(process.env[k]).toMatch(/^127\.0\.0\.1:\d+$/);
  });
  test('blocos de portas não se sobrepõem nem incluem a proibida', () => {
    const todas = [0, 1, 2, 3, 4, 5, 6, 7, 8, 9].flatMap(b => Object.values(doBloco(b)));
    expect(new Set(todas).size).toBe(todas.length);
    expect(todas.filter(p => PROIBIDAS.includes(p))).toEqual([]);
    expect(() => doBloco(10)).toThrow();
  });
  test('nenhum teste, tela ou configuração usa as portas antigas', () => {
    const RAIZ = path.resolve(__dirname, '../..');
    const arquivos = [...fs.readdirSync(__dirname).filter(f => f.endsWith('.test.js') && f !== path.basename(__filename)).map(f => path.join(__dirname, f)),
      ...fs.readdirSync(path.join(RAIZ, 'modulos')).filter(f => /\.(html|js)$/.test(f)).map(f => path.join(RAIZ, 'modulos', f)), path.join(RAIZ, 'login.html'), path.join(RAIZ, 'firebase.json')];
    const ruins = arquivos.filter(a => /(EMULATOR_HOST\s*=\s*['"][^'"]*:\d)|(\bport:\s*8080\b)|((localhost|127\.0\.0\.1)['"]?\s*[,:]\s*(8080|9099)\b)|("port":\s*8080)/.test(fs.readFileSync(a, 'utf8')));
    expect(ruins.map(a => path.relative(RAIZ, a))).toEqual([]);
  });
});
