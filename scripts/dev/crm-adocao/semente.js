#!/usr/bin/env node
'use strict';
// Semeia os emuladores com dados FICTÍCIOS na mesma ESTRUTURA/volume descritos na investigação de uso (documento 08, EXEC3):
//   V1: 1 retorno atrasado + 1 de hoje, 50 pendentes, 10 novas, 5 reativações · V2: 142 pendentes, 10 novas, 5 reativações.
// Os contextos comerciais são gerados pelo MESMO código do gerador (contextoComercial), a partir de vendas inventadas.
// Uso manual: node scripts/dev/crm-adocao/semente.js /caminho/pasta [antes|depois]  (fica servindo em http://localhost:5470)
const fs = require('fs'), path = require('path'), http = require('http'), crypto = require('crypto'), zlib = require('zlib');
const { RAIZ, PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');
process.env.FIRESTORE_EMULATOR_HOST = `127.0.0.1:${PORTAS.firestore}`;
process.env.FIREBASE_AUTH_EMULATOR_HOST = `127.0.0.1:${PORTAS.auth}`;
process.env.GCLOUD_PROJECT = PROJETO;
const dep = n => require(path.join(RAIZ, 'functions/node_modules', n));
const lib = n => require(path.join(RAIZ, 'functions/lib', n));
const admin = dep('firebase-admin');
const { diaComercial } = lib('crmTimeline');
const { calcularPerfil360 } = lib('perfil360');
const { calcularTendencia } = lib('tendenciaComercial');
const { buildContextoComercial, separarGestao } = lib('contextoComercial');

const GESTOR = 'gestora-ficticia', V1 = 'vendedor-ficticio-um', V2 = 'vendedor-ficticio-dois';
const PREFIXOS = ['Loja Fictícia', 'Auto Som Exemplo', 'Acessórios Teste', 'Distribuidora Imaginária', 'Comércio Modelo', 'Oficina Inventada', 'Centro Automotivo Hipotético'];
const SUFIXOS = ['Alfa', 'Beta', 'Gama', 'Delta', 'Épsilon', 'Zeta', 'Eta', 'Teta', 'Iota', 'Capa', 'Lambda'];
const PRODUTOS = ['Lâmpada LED fictícia H4 6000K', 'Central multimídia fictícia 9 polegadas', 'Câmera de ré fictícia AHD', 'Alto-falante fictício 6 polegadas',
  'Moldura de painel fictícia 2DIN', 'Sensor de estacionamento fictício', 'Palheta limpadora fictícia 20', 'Antena fictícia amplificada', 'Cabo RCA fictício 5 m', 'Trava elétrica fictícia 4 portas'];
const somar = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const opp = i => 'adc0' + String(i).padStart(12, '0');
const nome = i => `${PREFIXOS[i % PREFIXOS.length]} ${SUFIXOS[i % SUFIXOS.length]} ${String(i).padStart(3, '0')}`;
const TIPOS = ['JANELA_DE_RECOMPRA', 'JANELA_DE_RECOMPRA', 'REATIVACAO_120D', 'QUEDA_DE_COMPRAS'];

function vendasDe(i, hoje) {
  const gc = String(99500000 + i), tipo = TIPOS[i % TIPOS.length];
  const n = 2 + (i % 6), ciclo = 18 + (i % 5) * 7, parado = tipo === 'REATIVACAO_120D' ? 130 + (i % 90) : 20 + (i % 50);
  return Array.from({ length: n }, (_, k) => {
    const id = String(600000000 + i * 10 + k), data = somar(hoje, -(parado + k * ciclo));
    const produtos = [PRODUTOS[i % PRODUTOS.length], PRODUTOS[(i + 3 + (k % 2)) % PRODUTOS.length]].map(p => ({ produto_id: String(PRODUTOS.indexOf(p) + 1), nome_produto: p, quantidade: String(1 + (k % 3)), valor_total: '120.00' }));
    return { id, cliente_id: gc, data, cadastrado_em: data + ' 10:00:00', nome_situacao: 'Concretizada', valor_total: '240.00', vendedor_id: '9101', nome_vendedor: 'Vendedor Teste Um', produtos };
  });
}

async function semear(dir) {
  const apagar = async url => { const r = await fetch(url, { method: 'DELETE' }); if (!r.ok) throw new Error('limpeza falhou: ' + r.status); };
  await apagar(`http://127.0.0.1:${PORTAS.firestore}/emulator/v1/projects/${PROJETO}/databases/(default)/documents`);
  await apagar(`http://127.0.0.1:${PORTAS.auth}/emulator/v1/projects/${PROJETO}/accounts`);
  const app = admin.apps.length ? admin.app() : admin.initializeApp({ projectId: PROJETO });
  const db = app.firestore();
  const senha = crypto.randomBytes(12).toString('base64url');
  const contas = { v1: { email: 'vendedor.um@example.test', password: senha }, v2: { email: 'vendedor.dois@example.test', password: senha } };
  await app.auth().createUser({ uid: V1, ...contas.v1 });
  await app.auth().createUser({ uid: V2, ...contas.v2 });
  fs.writeFileSync(path.join(dir, 'credencial-teste.json'), JSON.stringify(contas), { mode: 0o600 });
  const hoje = diaComercial(new Date().toISOString());
  let lote = db.batch(), n = 0;
  const gravar = async (ref, dados) => { lote.set(db.doc(ref), dados); if (++n % 400 === 0) { await lote.commit(); lote = db.batch(); } };
  for (const [uid, role, nomeU, vend] of [[GESTOR, 'gestor', 'Gestora Teste'], [V1, 'funcionario', 'Vendedor Teste Um', '9101'], [V2, 'funcionario', 'Vendedor Teste Dois', '9102']]) {
    await gravar('users/' + uid, { role, ativo: true });
    await gravar('sistema_usuarios/' + uid, { nome: nomeU, bloqueado: false, modulos: role === 'gestor' ? ['fila-comercial'] : ['fila-comercial-operar'], ...(vend ? { carteiraComercial: { gestaoClickVendedorId: vend } } : {}) });
  }
  const wl = { schemaVersion: 'worklist-v2', dataReferencia: hoje, versao: 1, geradoEm: new Date().toISOString(), cap: 10, vendedores: {}, vendedoresAtivos: [V1, V2], vendedoresRotulos: { [V1]: 'Vendedor Teste Um', [V2]: 'Vendedor Teste Dois' }, atribuicoes: {} };
  let i = 0;
  const item = async (uid, grupo, extra = {}) => {
    const k = ++i, vendas = vendasDe(k, hoje), gc = String(99500000 + k), tipo = TIPOS[k % TIPOS.length];
    for (const v of vendas) await gravar('vendas_gc/' + v.id, v);
    const entidade = 'GC_NATIVE:' + gc;
    const perfil = calcularPerfil360({ clienteMr4Id: gc, gestaoClickId: gc, vendas, dataReferencia: hoje });
    let tendencia = null; try { tendencia = calcularTendencia(perfil).tendencia; } catch (_) { /* sem base */ }
    const base = { opportunityInstanceId: opp(k), commercialEntityId: entidade, tipoOportunidade: tipo, nomeCliente: nome(k), ...(grupo === 'pendentes' ? { atribuidoDesde: somar(hoje, -1 - (k % 40)) } : {}) };
    const op = extra.retorno ? { opportunityInstanceId: opp(k), commercialEntityId: entidade, tipoOportunidade: tipo, nomeCliente: nome(k), estado: 'AGUARDANDO_RETORNO', nextFollowUpAt: extra.retorno, atualizadoEm: somar(hoje, -3) + 'T14:00:00.000Z', claimAtual: null, cooledUntil: null,
      eventos: [{ tipo: 'OUTCOME_REGISTERED', operadorId: uid, outcome: 'PEDIU_RETORNO', timestamp: somar(hoje, -3) + 'T14:00:00.000Z', meta: { scheduledFor: extra.retorno } }] } : null;
    if (op) await gravar('interacoes_fila/' + opp(k), op);
    const ctx = separarGestao(buildContextoComercial({ item: base, perfil, perfilAtual: true, tendenciaCodigo: tendencia, vendas, grupo, estadoOperacional: op, dataReferencia: hoje })).operacional;
    wl.vendedores[uid] = wl.vendedores[uid] || { followUps: [], emAtendimento: [], pendentes: [], novas: [] };
    wl.vendedores[uid][grupo].push({ ...base, contextoComercial: ctx });
    wl.atribuicoes[opp(k)] = { uid, commercialEntityId: entidade, tipoOportunidade: tipo, nomeCliente: nome(k), grupo, desde: hoje };
  };
  await item(V1, 'followUps', { retorno: somar(hoje, -1) }); await item(V1, 'followUps', { retorno: hoje });
  for (let k = 0; k < 50; k++) await item(V1, 'pendentes');
  for (let k = 0; k < 10; k++) await item(V1, 'novas');
  for (let k = 0; k < 142; k++) await item(V2, 'pendentes');
  for (let k = 0; k < 10; k++) await item(V2, 'novas');
  for (const [uid, ini] of [[V1, 900], [V2, 920]]) for (let k = ini; k < ini + 5; k++) {
    const gc = String(99500000 + k);
    for (const v of vendasDe(k, hoje).map(v => ({ ...v, data: somar(v.data, -150) }))) await gravar('vendas_gc/' + v.id, v);
    await gravar('carteira_reativacoes/res' + k, { opportunityInstanceId: opp(k), portfolioId: 'GC:' + gc, destinoUid: uid, estado: 'RESERVADA', tipo: k % 2 ? 'SEM_CARTEIRA' : 'OUTRA_CARTEIRA', chave: 'REATIVE-' + k, nomeCliente: nome(k), liberadoEm: somar(hoje, -2), reservaAte: somar(hoje, 4) });
  }
  await gravar('fila_comercial/worklist', wl);
  await gravar('display_metrics/painel_comercial', { vendedores: [{ nome: 'Vendedor Teste Um', meta: 50000, totalMes: 31000 }, { nome: 'Vendedor Teste Dois', meta: 40000, totalMes: 22000 }] });
  await lote.commit();
  // os gatilhos do sinalizador processam a semeadura em segundo plano: espera assentarem antes de abrir a tela
  for (let anterior = '', iguais = 0, i = 0; i < 90 && iguais < 4; i++) {
    await new Promise(r => setTimeout(r, 1000));
    const d = await db.doc('crm_fila_versao/estado').get(), atual = d.exists ? String(d.data().versao) : '';
    iguais = atual && atual === anterior ? iguais + 1 : 0; anterior = atual;
  }
  return { db, hoje, contas, V1, V2 };
}

/** Servidor do site com compressão (como a hospedagem real). `qual.pasta` troca entre site-antes e site-depois sem reiniciar. */
function servir(dir, qual) {
  const tipos = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8', '.png': 'image/png' };
  const srv = http.createServer((req, res) => {
    const site = path.join(dir, qual.pasta);
    const rel = decodeURIComponent(new URL(req.url, 'http://x').pathname).replace(/^\/+/, '') || 'index.html';
    const alvo = path.join(site, rel);
    if (!alvo.startsWith(site + path.sep) || !fs.existsSync(alvo) || !fs.statSync(alvo).isFile()) { res.writeHead(404); return res.end('nao encontrado'); }
    const tipo = tipos[path.extname(alvo)] || 'application/octet-stream';
    const gz = /text/.test(tipo) && /gzip/.test(req.headers['accept-encoding'] || '');
    const corpo = fs.readFileSync(alvo), saida = gz ? zlib.gzipSync(corpo) : corpo;
    res.writeHead(200, { 'Content-Type': tipo, 'Cache-Control': 'max-age=600', 'Content-Length': saida.length, ...(gz ? { 'Content-Encoding': 'gzip' } : {}) });
    res.end(saida);
  });
  return new Promise((ok, erro) => { srv.once('error', erro); srv.listen(PORTAS.site, '127.0.0.1', () => ok(srv)); });
}

module.exports = { semear, servir, opp, V1, V2 };
if (require.main === module) (async () => {
  const dir = pastaDeTrabalho(process.argv[2]);
  await semear(dir); await servir(dir, { pasta: process.argv[3] === 'antes' ? 'site-antes' : 'site-depois' });
  console.log(`dados fictícios prontos. Abra http://localhost:${PORTAS.site}/login.html (credenciais em ${path.join(dir, 'credencial-teste.json')}) e depois /modulos/crm.html`);
})().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
