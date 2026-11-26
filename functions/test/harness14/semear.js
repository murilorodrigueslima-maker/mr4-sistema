'use strict';
// Semeia os emuladores Firestore (8210) e Auth (9210) com um mundo 100 % FICTÍCIO e a sombra 1.4 calculada pelo gerador real.
const admin = require('firebase-admin');
const fx = require('../fixtures/compras-estoque-f0');
const { mapearProduto, somarDias } = require('../../lib/compras/canonico');
const S = require('../../lib/compras/sombra14');
const usuarios = require('./usuarios.json');

const PROJETO = 'demo-mr4-sim14';
if (process.env.FIRESTORE_EMULATOR_HOST !== '127.0.0.1:8210' || process.env.FIREBASE_AUTH_EMULATOR_HOST !== '127.0.0.1:9210') {
  console.error('RECUSADO: a semeadura só roda contra os emuladores locais 127.0.0.1:8210 e 127.0.0.1:9210.'); process.exit(1);
}
const HOJE = '2026-11-26';
let semente = 7;
const sorte = () => { semente = (Math.imul(semente, 1103515245) + 12345) >>> 0; return semente / 4294967296; };

function mundo(n = 72) {
  const fornecedores = ['FT-A', 'FT-B', 'FT-C', 'FT-D', 'FT-E'];
  const categorias = ['Categoria Alfa', 'Categoria Beta', 'Categoria Gama', 'Categoria Delta'];
  const produtos = [], vendas = [], compras = [], nomes = [], marcas = {};
  for (let i = 1; i <= n; i++) {
    const id = 'PT-' + String(i).padStart(3, '0'), forn = fornecedores[i % fornecedores.length];
    const porDia = i % 9 === 0 ? 3 + sorte() * 5 : i % 4 === 0 ? 0.8 + sorte() * 1.5 : 0.05 + sorte() * 0.6;
    const custo = Math.round((3 + sorte() * sorte() * 120) * 100) / 100, preco = Math.round(custo * (1.25 + sorte() * 1.1) * 100) / 100;
    const estoque = i % 5 === 0 ? 0 : Math.round(porDia * sorte() * 55);
    produtos.push({ ...mapearProduto(fx.produto(id, { estoque, cadastrado_em: '2024-01-01 10:00:00', valor_custo: custo.toFixed(2), valor_venda: preco.toFixed(2) })), group_id: 'GT-' + (i % categorias.length) });
    const passo = Math.max(1, Math.round(1 / Math.min(1, porDia) * (1 + sorte())));
    for (let d = 395; d >= 1; d -= passo) vendas.push(fx.venda(somarDias(HOJE, -d), [[id, Math.max(1, Math.round(porDia * passo * (0.4 + sorte() * 1.3))), preco]], { id: `VT-${id}-${d}` }));
    for (const d of [200 + (i % 30), 110 + (i % 20), 35 + (i % 25)]) compras.push(fx.compra(somarDias(HOJE, -d), [[id, 10 * (1 + (i % 6)), custo]], { id: `CT-${id}-${d}`, fornecedor_id: i % 17 === 0 ? '2026204' : forn }).Compra);
    nomes.push({ id, nome: `Produto fictício ${String(i).padStart(3, '0')}`, grupo: categorias[i % categorias.length] });
    marcas[id] = 'Marca fictícia ' + ['Norte', 'Sul', 'Leste'][i % 3];
  }
  compras.push(fx.compra(somarDias(HOJE, -200), [['PT-009', 400, 10], ['PT-018', 120, 10]], { id: 'CT-ANTIGA', fornecedor_id: 'FT-A', situacao: 'A receber' }).Compra);
  compras.push(fx.compra(somarDias(HOJE, -4), [['PT-036', 40, 10]], { id: 'CT-RECENTE', fornecedor_id: 'FT-B', situacao: 'A receber' }).Compra);
  const nomesForn = Object.fromEntries([...fornecedores, '2026204'].map((f, i) => [f, { nome: f === '2026204' ? 'Compra própria (fictícia)' : `Fornecedor fictício ${'ABCDE'[i]}` }]));
  return {
    entradas: { hoje: HOJE, geradoEm: HOJE + 'T12:00:00.000Z', produtos, vendas, compras, snapshots: {}, sugestaoGravada12: new Map(), view: { linhas: nomes }, fornecedores: { nomes: { fornecedores: nomesForn }, unidades: null } },
    config: { marcas, fornecedores: { 'FT-C': { minimo_cents: 150000 } }, origem: { fornecedores_sem_origem: ['2026204'] } },   // exemplo fictício de origem sem prova
  };
}

async function principal() {
  admin.initializeApp({ projectId: PROJETO });
  const db = admin.firestore(), auth = admin.auth();
  for (const chave of ['gestor', 'funcionario']) {
    const u = usuarios[chave], uid = 'teste-' + chave;
    try { await auth.createUser({ uid, email: u.email, password: u.senha, displayName: u.nome }); } catch (e) { if (!/exists/.test(e.code || '')) throw e; }
    await db.collection('users').doc(uid).set(u.perfil);
    await db.collection('sistema_usuarios').doc(uid).set(u.sistema);
  }
  const m = mundo();
  const res = S.calcular(m.entradas, { config: m.config });
  const gravado = await S.persistir(db, res);
  console.log('semeado (dados fictícios):', JSON.stringify({ ...gravado, itens: res.resumo.itens }));
}
module.exports = { mundo };
if (require.main === module) principal().then(() => process.exit(0)).catch(e => { console.error(e.message || e); process.exit(1); });
