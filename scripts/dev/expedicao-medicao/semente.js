#!/usr/bin/env node
'use strict';
// Semeia os emuladores com dados FICTÍCIOS e serve site/ em http://localhost:5350.
// Uso: node scripts/dev/expedicao-medicao/semente.js /caminho/pasta   (fica servindo; Ctrl+C encerra)
// As credenciais de teste são geradas a cada semeadura e gravadas só na pasta de trabalho.
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const { RAIZ, PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORTAS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${PORTAS.auth}`;
process.env.GCLOUD_PROJECT = PROJETO;
const admin = require(path.join(RAIZ, 'functions/node_modules/firebase-admin'));
const M = require(path.join(RAIZ, 'js/expedicao-medicao-core.js'));

const CLIENTES = ['Loja Fictícia Alfa', 'Auto Som Exemplo Beta', 'Acessórios Teste Gama', 'Distribuidora Imaginária Delta', 'Comércio Modelo Épsilon', 'Oficina Inventada Zeta'];
const MIN = 60000, DIA = 86400000;

async function semear(dir) {
  const apagar = async url => { const r = await fetch(url, { method: 'DELETE' }); if (!r.ok) throw new Error('limpeza falhou: ' + r.status); };
  await apagar(`http://127.0.0.1:${PORTAS.firestore}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`);
  await apagar(`http://127.0.0.1:${PORTAS.auth}/emulator/v1/projects/${PROJETO}/accounts`);
  const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: PROJETO });
  const db = app.firestore(), T = ms => admin.firestore.Timestamp.fromMillis(ms);
  const credenciais = {};
  for (const [como, uid, papel] of [['gestor', 'gestor-ficticio', 'gestor'], ['equipe', 'equipe-ficticia', 'funcionario']]) {
    credenciais[como] = { email: como + '.teste@example.test', password: crypto.randomBytes(12).toString('base64url') };
    await app.auth().createUser({ uid, ...credenciais[como] });
    await db.doc('users/' + uid).set({ role: papel, ativo: true });
    await db.doc('sistema_usuarios/' + uid).set({ nome: 'Conta Teste', bloqueado: false, admin: false, modulos: ['expedicao'] });
  }
  fs.writeFileSync(path.join(dir, 'site', 'credencial-teste.json'), JSON.stringify(credenciais), { mode: 0o600 });

  const agora = Date.now(), hoje = M.diaFortaleza(agora);
  const as = (dia, hora) => Date.parse(`${dia}T00:00:00-03:00`) + hora * 3600000;
  const dia = n => M.diaFortaleza(as(hoje, 12) - n * DIA);
  let n = 7000100;
  const pedido = async (coluna, { entrada, envio = null, itens = 3, passos = [] }) => {
    const numero = String(++n), versao = passos.length;
    const ultimo = passos[passos.length - 1];
    await db.doc('expedicao_pedidos/' + numero).set({ numero, data: M.diaFortaleza(entrada), hora: '', ingresadoEm: entrada, movidoEm: ultimo ? ultimo : entrada, criadoEm: T(entrada), vendaCadastradaEm: entrada - 40000,
      coluna, cliente: CLIENTES[n % CLIENTES.length], vendedor: 'Vendedor Teste', itens, valor: 50 + (n % 9) * 37, cidade: 'Cidade Exemplo', envio, saidaEm: coluna === 'de' ? ultimo : null, versao, ultimoEventoId: 'v' + versao, origem: 'sync' });
    const acoes = [['INICIAR_SEPARACAO', 'ag', 'se'], ['MARCAR_SEPARADO', 'se', 'pr'], ['DESPACHAR', 'pr', 'de']];
    for (let i = 0; i < passos.length; i++) await db.doc(`expedicao_pedidos/${numero}/eventos/v${i + 1}`).set({ pedido: numero, acao: acoes[i][0], de: acoes[i][1], para: acoes[i][2], versao: i + 1, em: T(passos[i]), por: 'equipe-ficticia', origem: 'semente' });
    return numero;
  };
  // dois dias anteriores completos (para o acompanhamento ter o que mostrar)
  for (const d of [2, 1]) for (let i = 0; i < 8; i++) {
    const e = as(dia(d), 8 + i * 0.7), ini = e + (20 + i * 4) * MIN, sep = ini + (4 + i) * MIN, saida = sep + (50 + i * 9) * MIN, envio = i % 2 ? 'rota-manha' : 'retirada';
    const num = await pedido('de', { entrada: e, envio, itens: 1 + (i % 5), passos: [ini, sep, saida] });
    await db.doc(`expedicao_medicao/${num}_conf_v2`).set({ pedido: num, tipo: 'CONFERENCIA', versao: 2, em: T(sep + 8 * MIN), por: 'equipe-ficticia' });
    if (i % 2) await db.doc(`expedicao_medicao/${num}_entrega_v3`).set({ pedido: num, tipo: 'ENTREGA', versao: 3, em: T(saida + 55 * MIN), por: 'equipe-ficticia' });
    if (i === 3) await db.doc(`expedicao_medicao/${num}_oc_v2_NAO_LOCALIZADO`).set({ pedido: num, tipo: 'OCORRENCIA', versao: 2, motivo: 'NAO_LOCALIZADO', retrabalho: false, em: T(sep + 3 * MIN), por: 'equipe-ficticia' });
  }
  // quadro de agora
  const ha = m => agora - m * MIN;
  for (let i = 0; i < 5; i++) await pedido('ag', { entrada: ha(90 - i * 12), itens: 1 + i });
  for (let i = 0; i < 2; i++) await pedido('se', { entrada: ha(150 + i), envio: 'rota-tarde', passos: [ha(12 + i * 3)] });
  for (let i = 0; i < 3; i++) await pedido('pr', { entrada: ha(200 + i), envio: i ? 'rota-tarde' : 'retirada', passos: [ha(80), ha(60 - i)] });
  await pedido('de', { entrada: ha(240), envio: 'uber-mr4', passos: [ha(180), ha(170), ha(30)] });
  await pedido('de', { entrada: ha(230), envio: 'retirada', passos: [ha(160), ha(150), ha(20)] });
  await db.doc('expedicao_sync/estado').set({ ultima_ok_ms: agora });
  return { db, hoje, inicio: dia(2) };
}

function servir(dir) {
  const site = path.join(dir, 'site');
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.json': 'application/json', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const alvo = path.join(site, rel);
    if (!alvo.startsWith(site + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { res.writeHead(404); return res.end('nao encontrado'); }
    res.writeHead(200, { 'Content-Type': tipos[path.extname(alvo)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(alvo).pipe(res);
  });
  return new Promise((ok, falha) => { srv.on('error', falha); srv.listen(PORTAS.site, '127.0.0.1', () => ok(srv)); });
}

if (require.main === module) {
  const dir = pastaDeTrabalho(process.argv[2]);
  semear(dir).then(() => servir(dir)).then(() => console.log(`pronto: http://localhost:${PORTAS.site}/  (Ctrl+C encerra)`))
    .catch(e => { console.error(e); process.exit(1); });
}
module.exports = { semear, servir };
