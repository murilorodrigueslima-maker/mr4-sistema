#!/usr/bin/env node
'use strict';
// Semeia os emuladores com dados FICTÍCIOS e serve site/ em http://localhost:5240.
// Uso: node scripts/dev/com-funil/semente.js /caminho/pasta   (fica servindo; Ctrl+C encerra)
// A credencial de teste é gerada a cada semeadura e gravada em <pasta>/credencial-teste.json.
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const { RAIZ, PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORTAS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${PORTAS.auth}`;
process.env.GCLOUD_PROJECT = PROJETO;
const dep = n => require(path.join(RAIZ, 'functions/node_modules', n));
const admin = dep('firebase-admin');
const { diaComercial } = require(path.join(RAIZ, 'functions/lib/crmTimeline'));

const UID = 'vendedora-ficticia';
const NOMES = ['Loja Fictícia Alfa', 'Auto Som Exemplo Beta', 'Acessórios Teste Gama', 'Distribuidora Imaginária Delta', 'Comércio Modelo Épsilon', 'Oficina Inventada Zeta'];
const opp = i => 'c0f0' + String(i + 1).padStart(12, '0');
const somar = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function semear(dir) {
  const apagar = async url => { const r = await fetch(url, { method: 'DELETE' }); if (!r.ok) throw new Error('limpeza falhou: ' + r.status); };
  await apagar(`http://127.0.0.1:${PORTAS.firestore}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`);
  await apagar(`http://127.0.0.1:${PORTAS.auth}/emulator/v1/projects/${PROJETO}/accounts`);
  const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: PROJETO });
  const db = app.firestore();
  const credencial = { email: 'vendedora.teste@example.test', password: crypto.randomBytes(12).toString('base64url') };
  await app.auth().createUser({ uid: UID, ...credencial });
  fs.writeFileSync(path.join(dir, 'credencial-teste.json'), JSON.stringify(credencial), { mode: 0o600 });
  const hoje = diaComercial(new Date().toISOString());
  await db.doc('users/' + UID).set({ role: 'funcionario', ativo: true });
  await db.doc('sistema_usuarios/' + UID).set({ nome: 'Vendedora Teste', bloqueado: false, modulos: ['fila-comercial-operar'], carteiraComercial: { gestaoClickVendedorId: '9001' } });
  const itens = NOMES.map((nomeCliente, i) => ({ opportunityInstanceId: opp(i), commercialEntityId: 'GC_NATIVE:' + (99000001 + i), tipoOportunidade: 'JANELA_DE_RECOMPRA', nomeCliente,
    contextoComercial: { versao: 'V1', rotuloTipo: 'Janela de recompra', motivo: 'Dado fictício: perto da data habitual de recompra.', historico: { ultimaCompraEm: somar(hoje, -20 - i), pedidosTotal: 3 + i } } }));
  await db.doc('fila_comercial/worklist').set({ schemaVersion: 'worklist-v2', dataReferencia: hoje, versao: 1, geradoEm: new Date().toISOString(), cap: 10,
    vendedores: { [UID]: { novas: itens, followUps: [], emAtendimento: [], pendentes: [] } }, vendedoresAtivos: [UID], vendedoresRotulos: { [UID]: 'Vendedora Teste' },
    atribuicoes: Object.fromEntries(itens.map(x => [x.opportunityInstanceId, { uid: UID, commercialEntityId: x.commercialEntityId, tipoOportunidade: x.tipoOportunidade, nomeCliente: x.nomeCliente }])) });
  await db.doc('fila_comercial/snapshot').set({ clientesHoje: [], clientesProximos: [], clientesProspeccao: [] });
  for (let i = 0; i < NOMES.length; i++) await db.doc('vendas_gc/' + (7000001 + i)).set({ id: String(7000001 + i), cliente_id: String(99000001 + i), data: somar(hoje, -20 - i),
    nome_situacao: 'Concretizada', valor_total: '100.00', vendedor_id: '9001', nome_vendedor: 'Vendedora Teste', produtos: [] });
  return { db, uid: UID, hoje, credencial, opps: itens.map(x => x.opportunityInstanceId), nomes: NOMES };
}

function servir(dir) {
  const site = path.join(dir, 'site');
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const alvo = path.join(site, rel);
    if (!alvo.startsWith(site + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { res.writeHead(404); return res.end('nao encontrado'); }
    res.writeHead(200, { 'Content-Type': tipos[path.extname(alvo)] || 'application/octet-stream', 'Cache-Control': 'no-store' });
    fs.createReadStream(alvo).pipe(res);
  });
  return new Promise((ok, erro) => { srv.once('error', erro); srv.listen(PORTAS.site, '127.0.0.1', () => ok(srv)); });
}

module.exports = { semear, servir, UID };
if (require.main === module) (async () => {
  const dir = pastaDeTrabalho(process.argv[2]);
  await semear(dir); await servir(dir);
  console.log(`dados fictícios prontos. Abra http://localhost:${PORTAS.site}/login.html (credencial em ${path.join(dir, 'credencial-teste.json')}) e depois /modulos/crm.html ou /modulos/fila-comercial.html`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
