#!/usr/bin/env node
'use strict';
// Semeia os emuladores com dados FICTÍCIOS e serve site/ em http://localhost:5370.
// Uso: node scripts/dev/crm-revisao/semente.js /caminho/pasta   (fica servindo; Ctrl+C encerra)
// A credencial de teste é gerada a cada semeadura e gravada em <pasta>/credencial-teste.json.
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto');
const { RAIZ, PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORTAS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${PORTAS.auth}`;
process.env.GCLOUD_PROJECT = PROJETO;
const dep = n => require(path.join(RAIZ, 'functions/node_modules', n));
const admin = dep('firebase-admin');
const { diaComercial } = require(path.join(RAIZ, 'functions/lib/crmTimeline'));

const GESTOR = 'gestora-ficticia', V1 = 'vendedor-ficticio-um', V2 = 'vendedor-ficticio-dois';
const NOMES = ['Loja Fictícia Alfa', 'Auto Som Exemplo Beta', 'Acessórios Teste Gama', 'Distribuidora Imaginária Delta', 'Comércio Modelo Épsilon', 'Oficina Inventada Zeta',
  'Centro Automotivo Hipotético Eta de Nome Bastante Comprido', 'Som e Acessórios Simulados Teta', 'Casa Fictícia Iota', 'Auto Peças Exemplo Capa'];
const opp = i => 'c3d0' + String(i + 1).padStart(12, '0');
const gc = i => 99400001 + i;
const somar = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };

async function semear(dir) {
  const apagar = async url => { const r = await fetch(url, { method: 'DELETE' }); if (!r.ok) throw new Error('limpeza falhou: ' + r.status); };
  await apagar(`http://127.0.0.1:${PORTAS.firestore}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`);
  await apagar(`http://127.0.0.1:${PORTAS.auth}/emulator/v1/projects/${PROJETO}/accounts`);
  const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: PROJETO });
  const db = app.firestore();
  const senha = crypto.randomBytes(12).toString('base64url');
  const contas = { gestor: { email: 'gestora.teste@example.test', password: senha }, vendedor: { email: 'vendedor.teste@example.test', password: senha } };
  await app.auth().createUser({ uid: GESTOR, ...contas.gestor });
  await app.auth().createUser({ uid: V1, ...contas.vendedor });
  fs.writeFileSync(path.join(dir, 'credencial-teste.json'), JSON.stringify(contas), { mode: 0o600 });
  const hoje = diaComercial(new Date().toISOString());
  for (const [uid, role, nome, modulos, vend] of [[GESTOR, 'gestor', 'Gestora Teste', ['fila-comercial']], [V1, 'funcionario', 'Vendedor Teste Um', ['fila-comercial-operar'], '9101'], [V2, 'funcionario', 'Vendedor Teste Dois', ['fila-comercial-operar'], '9102']]) {
    await db.doc('users/' + uid).set({ role, ativo: true });
    await db.doc('sistema_usuarios/' + uid).set({ nome, bloqueado: false, modulos, ...(vend ? { carteiraComercial: { gestaoClickVendedorId: vend } } : {}) });
  }
  const atendimento = async (i, diasAtras, outcome, meta, uid = V1) => {
    const dia = somar(hoje, -diasAtras), t = s => `${dia}T14:0${i % 10}:${s}.000Z`;
    await db.doc('interacoes_fila/' + opp(i)).set({ opportunityInstanceId: opp(i), commercialEntityId: 'GC_NATIVE:' + gc(i), tipoOportunidade: 'JANELA_DE_RECOMPRA', estado: 'CONCLUIDA', nomeCliente: NOMES[i], atualizadoEm: t('08'),
      eventos: [{ tipo: 'CLAIMED', operadorId: uid, timestamp: t('00') }, { tipo: 'OUTCOME_REGISTERED', operadorId: uid, outcome, timestamp: t('08'), ...(meta ? { meta } : {}) }] });
  };
  let n = 0;
  const pedido = (i, diasAtras, valor, vend = '9101', extra = {}) => { const id = String(500100001 + n++), data = somar(hoje, -diasAtras);
    return db.doc('vendas_gc/' + id).set({ id, cliente_id: String(gc(i)), data, cadastrado_em: data + ' 17:40:00', nome_situacao: 'Concretizada', valor_total: valor, vendedor_id: vend,
      nome_vendedor: vend === '9101' ? 'Vendedor Teste Um' : 'Vendedor Teste Dois', produtos: [{ produto_id: '1', nome_produto: 'Produto fictício A', quantidade: '2', valor_total: valor }], ...extra }); };
  await atendimento(0, 30, 'CONVERSA_REALIZADA', { temNota: true }); await pedido(0, 27, '480.00');                              // provável (regra)
  await db.doc(`crm_notas_privadas/${opp(0)}__1`).set({ opportunityInstanceId: opp(0), eventoIndex: 1, operadorId: V1, texto: 'Pediu tabela de preços (observação fictícia).' });
  await atendimento(1, 29, 'CONVERSA_REALIZADA'); await pedido(1, 28, '1250.90', '9102');                                          // outro vendedor
  await atendimento(2, 28, 'SEM_INTERESSE_AGORA'); await pedido(2, 24, '312.00');                                                 // sem interesse e comprou
  await atendimento(3, 27, 'CONVERSA_REALIZADA', { interesse: 'SIM', proposta: 'SIM' }); await pedido(3, 25, '2100.00');           // evidência declarada
  await atendimento(4, 26, 'CONVERSA_REALIZADA'); await pedido(4, 14, '189.50');                                                  // prazo longo
  await atendimento(5, 25, 'CONVERSA_REALIZADA'); await pedido(5, 23, '99.90'); await pedido(5, 19, '640.00');                     // recompra
  await atendimento(6, 24, 'SEM_RESPOSTA'); await pedido(6, 22, '75.00');                                                         // só tentativa
  await atendimento(7, 23, 'CONVERSA_REALIZADA'); await pedido(7, 21, '410.00', '9101', { nome_situacao: 'Em aberto' });           // não concluído
  await atendimento(8, 22, 'CONVERSA_REALIZADA');                                                                                // sem pedido
  await atendimento(9, 21, 'CONVERSA_REALIZADA', undefined, V2); await pedido(9, 21, '520.00', '9102', { cadastrado_em: somar(hoje, -21) + ' 08:10:00' });   // pedido antes do registro
  return { db, hoje, contas, GESTOR };
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

module.exports = { semear, servir, opp, GESTOR, V1 };
if (require.main === module) (async () => {
  const dir = pastaDeTrabalho(process.argv[2]);
  await semear(dir); await servir(dir);
  console.log(`dados fictícios prontos. Abra http://localhost:${PORTAS.site}/login.html (credenciais em ${path.join(dir, 'credencial-teste.json')}) e depois /modulos/crm-atribuicao.html`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
