'use strict';
// Semeia os emuladores Firestore (8320) e Auth (9320) com um mundo 100 % FICTÍCIO: as coleções de Compras gravadas pelo próprio
// snapshot do sistema, cadastros de fornecedor, confirmações e origem. A base do planejamento NÃO é semeada: a tela a gera pela
// função planejamentoComprasAtualizar (o mesmo caminho do dono).
const admin = require('firebase-admin');
const fx = require('../fixtures/compras-estoque-f0');
const { somarDias } = require('../../lib/compras/canonico');
const Snap = require('../../lib/compras/snapshot');
const usuarios = require('./usuarios.json');

const PROJETO = 'demo-mr4-sim14';
const HOJE = '2026-11-26';
const AGORA = new Date(HOJE + 'T15:00:00Z');
let semente = 7;
const sorte = () => { semente = (Math.imul(semente, 1103515245) + 12345) >>> 0; return semente / 4294967296; };

/** Dados brutos fictícios no formato do ERP. */
function mundo(n = 72) {
  semente = 7;
  const fornecedores = ['FT-A', 'FT-B', 'FT-C', 'FT-D', 'FT-E'];
  const categorias = ['Categoria Alfa', 'Categoria Beta', 'Categoria Gama', 'Categoria Delta'];
  const produtos = [], vendas = [], compras = [];
  for (let i = 1; i <= n; i++) {
    const id = 'PT-' + String(i).padStart(3, '0'), forn = fornecedores[i % fornecedores.length];
    const porDia = i % 9 === 0 ? 3 + sorte() * 5 : i % 4 === 0 ? 0.8 + sorte() * 1.5 : 0.05 + sorte() * 0.6;
    const custo = Math.round((3 + sorte() * sorte() * 120) * 100) / 100, preco = Math.round(custo * (1.25 + sorte() * 1.1) * 100) / 100;
    const estoque = i % 5 === 0 ? 0 : Math.round(porDia * sorte() * 55);
    produtos.push({ ...fx.produto(id, { estoque, cadastrado_em: '2024-01-01 10:00:00', valor_custo: custo.toFixed(2), valor_venda: preco.toFixed(2), grupo_id: 'GT-' + (i % categorias.length) }), nome: `Produto fictício ${String(i).padStart(3, '0')}`, nome_grupo: categorias[i % categorias.length] });
    const passo = Math.max(1, Math.round(1 / Math.min(1, porDia) * (1 + sorte())));
    for (let d = 395, k = 0; d >= 1; d -= passo, k++) {
      const grande = k % 9 === 4 ? 4 : 1;                          // de vez em quando um pedido grande de distribuidor
      vendas.push(fx.venda(somarDias(HOJE, -d), [[id, Math.max(1, Math.round(porDia * passo * (0.4 + sorte() * 1.3) * grande * (grande > 1 ? 1 : 0.75))), preco]], { id: `VT-${id}-${d}` }));
    }
    for (const d of [200 + (i % 30), 110 + (i % 20), 35 + (i % 25)]) compras.push(fx.compra(somarDias(HOJE, -d), [[id, 10 * (1 + (i % 6)), custo]], { id: `CT-${id}-${d}`, fornecedor_id: i % 17 === 0 ? '2026204' : forn }));
  }
  compras.push(fx.compra(somarDias(HOJE, -200), [['PT-009', 400, 10], ['PT-018', 120, 10]], { id: 'CT-ANTIGA', fornecedor_id: 'FT-A', situacao: 'A receber' }));
  compras.push(fx.compra(somarDias(HOJE, -4), [['PT-036', 40, 10]], { id: 'CT-RECENTE', fornecedor_id: 'FT-B', situacao: 'A receber' }));
  const nomesForn = Object.fromEntries([...fornecedores, '2026204'].map((f, i) => [f, { nome: f === '2026204' ? 'Compra própria (fictícia)' : `Fornecedor fictício ${'ABCDE'[i]}` }]));
  const cadastros = {
    compras_fornecedor_parametros: {
      'FT-A': { prazoMedioDias: 12, prazoMaxDias: 20, valorMinimoCents: 80000, multiploPadrao: 6, confiabilidadePrazo: 'MEDIA', origem: 'NACIONAL', frequenciaReposicaoDias: 7, condicoesPagamento: '28 dias (fictício)', fontes: { prazoMedioDias: 'MANUAL', valorMinimoCents: 'MANUAL', multiploPadrao: 'MANUAL' } },
      'FT-B': { origem: 'IMPORTADO', qtdMinima: 40, confiabilidadePrazo: 'BAIXA', fontes: { qtdMinima: 'ESTIMADO' } },
      'FT-C': { prazoMedioDias: 9, valorMinimoCents: 150000, qtdMinimaPorProduto: { 'PT-012': 24 }, multiplosPorProduto: { 'PT-012': 12 }, fontes: { prazoMedioDias: 'ESTIMADO' } },
    },
    compras_pendencias_confirmacao: { 'CT-ANTIGA': { status: 'AGUARDANDO_CONFERENCIA' } },
    compras_origem: { 'CT-PT-027-37': { usar_em_decisao_automatica: false }, 'CT-PT-017-52': { usar_em_decisao_automatica: false } },
  };
  return { produtos, vendas, compras, nomesForn, cadastros };
}

async function gravar(db, m = mundo(), agora = AGORA) {
  const snap = Snap.montarSnapshot({ brutosProdutos: m.produtos, brutosVendas: m.vendas, brutosCompras: m.compras, agora });
  await Snap.persistirSnapshot(db, snap);
  await db.collection('compras_n0_fornecedores').doc('nomes').set({ fornecedores: m.nomesForn });
  for (const [c, docs] of Object.entries(m.cadastros)) for (const [id, v] of Object.entries(docs)) await db.collection(c).doc(id).set(v);
  return { produtos: m.produtos.length, vendas: m.vendas.length, compras: m.compras.length };
}

async function principal() {
  if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8320' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9320') {
    console.error('RECUSADO: a semeadura só roda contra os emuladores locais 127.0.0.1:8320 e 127.0.0.1:9320.'); process.exit(1);
  }
  admin.initializeApp({ projectId: PROJETO });
  const db = admin.firestore(), auth = admin.auth();
  for (const chave of ['gestor', 'funcionario']) {
    const u = usuarios[chave], uid = 'teste-' + chave;
    try { await auth.createUser({ uid, email: u.email, password: u.senha, displayName: u.nome }); } catch (e) { if (!/exists/.test(e.code || '')) throw e; }
    await db.collection('users').doc(uid).set(u.perfil);
    await db.collection('sistema_usuarios').doc(uid).set(u.sistema);
  }
  console.log('semeado (dados fictícios):', JSON.stringify(await gravar(db)));
}
module.exports = { HOJE, AGORA, mundo, gravar };
if (require.main === module) principal().then(() => process.exit(0)).catch(e => { console.error(e.message || e); process.exit(1); });
