'use strict';
// N35.17.1 — Administração da Fila Comercial: preservação de módulos, controles da fila,
// fluxo de vendedor novo (emulador) e regras (vendedor não se auto-configura). PROD_WRITES=0.
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';

const path = require('path');
const { readFileSync } = require('fs');
const L = require(path.join(__dirname, '..', '..', 'modulos', 'admin-usuarios-logic.js'));
const { resolverParticipantes } = require('../lib/dailyWorklist');
const G = require('../lib/worklistGenerator');
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');

// Grade de módulos do admin.html (cópia de MODULOS_DEF — só os ids)
const TELA = ['vendas', 'estoque', 'financeiro', 'catalogo', 'expedicao', 'ponto', 'marketing', 'garantia', 'clientes', 'fila-comercial', 'demandas', 'admin'];
const form = (o = {}) => ({ nome: 'X', cargo: 'Vendedor', email: 'x@t', isAdmin: false, bloqueado: false, idsDaTela: TELA, marcadosNaTela: [], filaOperar: false, filaGestao: false, filaParticipa: false, filaLimite: 10, ...o });
const FAB_DOC = { nome: 'Fabiana', cargo: 'Vendedor', email: 'f@t', admin: false, bloqueado: false, modulos: ['catalogo', 'clientes', 'demandas', 'fila-comercial', 'fila-comercial-operar'], filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } };
const CAMILA_DOC = { nome: 'Camila', cargo: 'Aux. Adm.', email: 'c@t', admin: false, bloqueado: false, modulos: ['catalogo', 'expedicao', 'ponto', 'garantia', 'demandas', 'fila-comercial-gestao'] };
// Reproduz o formulário exatamente como a tela o preenche a partir do documento
function formDe(doc, extra = {}) {
  const e = L.estadoInicialFila(doc);
  return form({ nome: doc.nome, cargo: doc.cargo, email: doc.email, isAdmin: !!doc.admin, bloqueado: !!doc.bloqueado,
    marcadosNaTela: (doc.modulos || []).filter(m => TELA.includes(m)),
    filaOperar: e.podeOperar, filaGestao: e.gestao, filaParticipa: e.participa, filaLimite: e.limite, ...extra });
}
// Lógica ANTIGA do admin.html (antes da N35.17.1), para provar o bug
const salvarAntigo = (doc, marcados) => ({ ...doc, modulos: doc.admin ? TELA : marcados });

describe('Bug anterior (reprodução)', () => {
  test('BUG-01 lógica antiga apaga fila-comercial-operar e módulo futuro ao editar só o nome', () => {
    const doc = { ...FAB_DOC, modulos: ['catalogo', 'clientes', 'fila-comercial-operar', 'MODULO_FUTURO_TESTE'] };
    const antigo = salvarAntigo(doc, doc.modulos.filter(m => TELA.includes(m)));
    expect(antigo.modulos).not.toContain('fila-comercial-operar');
    expect(antigo.modulos).not.toContain('MODULO_FUTURO_TESTE');
    const novo = L.montarPayloadUsuario(doc, formDe(doc, { nome: 'Outro nome' })).dados;
    expect(novo.modulos).toEqual(['catalogo', 'clientes', 'fila-comercial-operar', 'MODULO_FUTURO_TESTE']);
  });
});

describe('ADM-Q — preservação e controles', () => {
  test('ADM-Q-01 módulo desconhecido é preservado', () => {
    const doc = { ...CAMILA_DOC, modulos: [...CAMILA_DOC.modulos, 'MODULO_FUTURO_TESTE'] };
    expect(L.montarPayloadUsuario(doc, formDe(doc)).dados.modulos).toContain('MODULO_FUTURO_TESTE');
  });
  test('ADM-Q-02 fila-comercial-operar preservado em edição não relacionada', () => {
    expect(L.montarPayloadUsuario(FAB_DOC, formDe(FAB_DOC, { cargo: 'Vendedora' })).dados.modulos).toContain('fila-comercial-operar');
  });
  test('ADM-Q-03 fila-comercial-gestao preservado', () => {
    expect(L.montarPayloadUsuario(CAMILA_DOC, formDe(CAMILA_DOC, { nome: 'Camila S.' })).dados.modulos).toContain('fila-comercial-gestao');
  });
  test('ADM-Q-04 adicionar operar funciona', () => {
    const doc = { ...CAMILA_DOC, modulos: ['catalogo'] };
    expect(L.montarPayloadUsuario(doc, formDe(doc, { filaOperar: true })).dados.modulos).toEqual(['catalogo', 'fila-comercial-operar']);
  });
  test('ADM-Q-05 remover operar explicitamente funciona (e preserva a configuração, sem apagar)', () => {
    const r = L.montarPayloadUsuario(FAB_DOC, formDe(FAB_DOC, { filaOperar: false })).dados;
    expect(r.modulos).not.toContain('fila-comercial-operar');
    expect(r.filaComercial).toBeUndefined(); // não grava → config existente fica como está
  });
  test('ADM-Q-06 adicionar gestão funciona', () => {
    expect(L.montarPayloadUsuario(FAB_DOC, formDe(FAB_DOC, { filaGestao: true })).dados.modulos).toContain('fila-comercial-gestao');
  });
  test('ADM-Q-07 remover gestão explicitamente funciona', () => {
    const r = L.montarPayloadUsuario(CAMILA_DOC, formDe(CAMILA_DOC, { filaGestao: false })).dados;
    expect(r.modulos).not.toContain('fila-comercial-gestao');
    expect(r.modulos).toEqual(['catalogo', 'expedicao', 'ponto', 'garantia', 'demandas']);
  });
  test('ADM-Q-08 operar sem distribuição é válido (não cria configuração)', () => {
    const doc = { nome: 'Ademir', modulos: ['fila-comercial', 'fila-comercial-operar'] };
    const r = L.montarPayloadUsuario(doc, formDe(doc));
    expect(r.erro).toBeUndefined();
    expect(r.dados.modulos).toContain('fila-comercial-operar');
    expect(r.dados.filaComercial).toBeUndefined();
  });
  test('ADM-Q-09 distribuição ativa + limite 10 persiste no contrato N35.17', () => {
    const doc = { nome: 'Novo', modulos: [] };
    expect(L.montarPayloadUsuario(doc, formDe(doc, { filaOperar: true, filaParticipa: true, filaLimite: '10' })).dados.filaComercial)
      .toEqual({ ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 });
  });
  test.each([['ADM-Q-10 limite 1 válido', 1], ['ADM-Q-11 limite 30 válido', 30]])('%s', (_, lim) => {
    const r = L.montarPayloadUsuario({ modulos: [] }, form({ filaOperar: true, filaParticipa: true, filaLimite: lim }));
    expect(r.dados.filaComercial.limiteNovasPorDia).toBe(lim);
  });
  test.each([['ADM-Q-12 limite 0 rejeitado', 0], ['ADM-Q-13 limite 31 rejeitado', 31], ['limite decimal rejeitado', 2.5], ['limite vazio rejeitado', ''], ['limite texto rejeitado', 'dez']])('%s', (_, lim) => {
    const r = L.montarPayloadUsuario({ modulos: [] }, form({ filaOperar: true, filaParticipa: true, filaLimite: lim }));
    expect(r.erro).toMatch(/1 e 30|inteiro/);
    expect(r.dados).toBeUndefined();
  });
  test('ADM-Q-14 gestão não recebe distribuição automaticamente (Camila)', () => {
    const r = L.montarPayloadUsuario(CAMILA_DOC, formDe(CAMILA_DOC)).dados;
    expect(r.filaComercial).toBeUndefined();
    expect(L.estadoInicialFila(CAMILA_DOC)).toMatchObject({ gestao: true, podeOperar: false, participa: false });
    // mesmo marcando "participa" (UI desabilitada), sem operar nada é criado
    expect(L.montarPayloadUsuario(CAMILA_DOC, formDe(CAMILA_DOC, { filaParticipa: true })).dados.filaComercial).toBeUndefined();
  });
  test('ADM-Q-15 pausar distribuição preserva a permissão operacional', () => {
    const r = L.montarPayloadUsuario(FAB_DOC, formDe(FAB_DOC, { filaParticipa: false })).dados;
    expect(r.modulos).toContain('fila-comercial-operar');
    expect(r.filaComercial.recebeNovasOportunidades).toBe(false);
    expect(r.filaComercial.ativo).toBe(true); // continua na worklist: mantém follow-ups
  });
  test('ADM-Q-16 pausar distribuição preserva o limite', () => {
    const doc = { ...FAB_DOC, filaComercial: { ...FAB_DOC.filaComercial, limiteNovasPorDia: 7 } };
    expect(L.montarPayloadUsuario(doc, formDe(doc, { filaParticipa: false, filaLimite: 99 })).dados.filaComercial.limiteNovasPorDia).toBe(7);
  });
  test('ADM-Q-17 salvar Fabiana (edição não relacionada) preserva a configuração N35.17', () => {
    const r = L.montarPayloadUsuario(FAB_DOC, formDe(FAB_DOC, { nome: 'Fabiana A.' })).dados;
    expect(r.modulos).toEqual(FAB_DOC.modulos);
    expect(r.filaComercial).toEqual(FAB_DOC.filaComercial);
    expect(r.admin).toBe(false);
  });
  test('ADM-Q-18 salvar Camila preserva todos os módulos e não cria distribuição', () => {
    const r = L.montarPayloadUsuario(CAMILA_DOC, formDe(CAMILA_DOC, { cargo: 'Supervisora' })).dados;
    expect(r.modulos).toEqual(CAMILA_DOC.modulos);
    expect(r.modulos).not.toContain('fila-comercial-operar');
    expect(r.filaComercial).toBeUndefined();
  });
  test('ADM-Q-19 módulo futuro preservado mesmo em admin=true e com várias alterações', () => {
    const doc = { nome: 'Adm', admin: true, modulos: ['vendas', 'MODULO_FUTURO_A', 'fila-comercial', 'MODULO_FUTURO_B'] };
    const r = L.montarPayloadUsuario(doc, formDe(doc, { filaGestao: true })).dados;
    expect(r.modulos).toEqual(expect.arrayContaining(['MODULO_FUTURO_A', 'MODULO_FUTURO_B', 'fila-comercial-gestao', ...TELA]));
    expect(r.modulos).not.toContain('fila-comercial-operar'); // admin não concede operação
  });
  test('ADM-Q-20 usuário sem nenhuma configuração de fila continua funcionando', () => {
    const doc = { nome: 'Gutemberg', cargo: 'estoquista', modulos: ['expedicao', 'garantia', 'demandas'] };
    const r = L.montarPayloadUsuario(doc, formDe(doc, { marcadosNaTela: ['expedicao', 'garantia', 'demandas', 'catalogo'] })).dados;
    expect(r.modulos).toEqual(['expedicao', 'garantia', 'demandas', 'catalogo']);
    expect(r.filaComercial).toBeUndefined();
    expect(L.estadoInicialFila(doc)).toEqual({ podeOperar: false, gestao: false, participa: false, limite: 10, temConfiguracao: false });
  });
  test('ADM-Q-21 usuário novo (sem documento): módulos da grade + fila, sem lixo', () => {
    const r = L.montarPayloadUsuario(null, form({ marcadosNaTela: ['catalogo', 'naoExiste'], filaOperar: true, filaParticipa: true, filaLimite: 10 })).dados;
    expect(r.modulos).toEqual(['catalogo', 'fila-comercial-operar']);
  });
});

// ── Emulador: fluxo real de novo vendedor e pausa ─────────────────────────────
describe('Fluxo administrativo no emulador', () => {
  const admin = require('firebase-admin');
  const app = admin.apps.find(a => a && a.name === 'n3517-1') || admin.initializeApp({ projectId: 'mr4-ponto' }, 'n3517-1');
  const db = app.firestore();
  const UID = 'VENDEDOR_NOVO_TESTE';
  const vendas = [];
  for (let i = 0; i < 20; i++) for (let k = 0; k < 5; k++) {
    const d = new Date(Date.UTC(2026, 2, 5 + i) - k * 20 * 86400000).toISOString().slice(0, 10);
    vendas.push({ id: `a${i}v${k}`, cliente_id: String(22200000 + i), data: d, nome_situacao: 'Concretizada', valor_total: '300', cadastrado_em: d + ' 10:00:00', vendedor_id: '1', produtos: [] });
  }
  async function salvarComoAdmin(formExtra) {
    const snap = await db.doc(`sistema_usuarios/${UID}`).get(); // mesma sequência do admin.html: relê e mescla
    const r = L.montarPayloadUsuario(snap.exists ? snap.data() : null, form({ nome: 'Vendedor Novo', marcadosNaTela: ['catalogo'], ...formExtra }));
    if (r.erro) throw new Error(r.erro);
    await db.doc(`sistema_usuarios/${UID}`).set(r.dados, { merge: true });
    return (await db.doc(`sistema_usuarios/${UID}`).get()).data();
  }
  async function gerar() {
    const sys = await db.collection('sistema_usuarios').get();
    const sistema = new Map(sys.docs.map(d => [d.id, d.data()]));
    const users = new Map([[UID, (await db.doc(`users/${UID}`).get()).data()]]);
    return G.executarGeracaoWorklist({ db: null, now: new Date('2026-09-28T09:00:00.000Z'), mode: 'DRY_RUN', logger: { log() {} }, lookupNome: async gc => 'C' + gc,
      dados: { perfis: [], clientes: [], vendas, estados: new Map(), users, sistema: new Map([[UID, sistema.get(UID)]]) } });
  }
  beforeAll(async () => {
    await db.doc(`users/${UID}`).set({ ativo: true, role: 'funcionario', funcionarioId: 'FUNC_NOVO_TESTE' });
    await db.doc(`sistema_usuarios/${UID}`).delete();
  }, 30000);
  afterAll(async () => { await db.doc(`users/${UID}`).delete(); await db.doc(`sistema_usuarios/${UID}`).delete(); await app.delete(); }, 30000);

  test('NS-01 vendedor novo configurado pela lógica do admin é descoberto pela worklist', async () => {
    const d = await salvarComoAdmin({ filaOperar: true, filaGestao: false, filaParticipa: true, filaLimite: 10 });
    expect(d.modulos).toContain('fila-comercial-operar');
    expect(d.filaComercial).toEqual({ ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 });
    const r = await gerar();
    expect(r.doc.vendedoresAtivos).toEqual([UID]);
    expect(r.doc.vendedores[UID].novas).toHaveLength(10);
  }, 60000);
  test('NS-02 pausa pela tela: 0 novas, permissão e limite preservados', async () => {
    const d = await salvarComoAdmin({ filaOperar: true, filaParticipa: false, filaLimite: 10 });
    expect(d.modulos).toContain('fila-comercial-operar');
    expect(d.filaComercial).toEqual({ ativo: true, recebeNovasOportunidades: false, limiteNovasPorDia: 10 });
    const r = await gerar();
    expect(r.doc.vendedoresAtivos).toEqual([UID]);
    expect(r.doc.vendedores[UID].novas).toHaveLength(0);
  }, 60000);
});

// ── Regras: vendedor não se auto-configura ────────────────────────────────────
describe('Regras do Firestore (sistema_usuarios)', () => {
  let env;
  const SELLER = 'rules-seller', GESTOR = 'rules-gestor';
  beforeAll(async () => {
    env = await initializeTestEnvironment({ projectId: 'mr4-n35171-rules', firestore: { rules: readFileSync(path.resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
    await env.withSecurityRulesDisabled(async ctx => {
      const f = ctx.firestore();
      await f.doc(`users/${SELLER}`).set({ role: 'funcionario', ativo: true, funcionarioId: 'F1' });
      await f.doc(`sistema_usuarios/${SELLER}`).set({ nome: 'S', modulos: ['fila-comercial-operar'], admin: false, bloqueado: false });
      await f.doc(`users/${GESTOR}`).set({ role: 'gestor', ativo: true });
      await f.doc(`sistema_usuarios/${GESTOR}`).set({ nome: 'G', modulos: [], admin: true, bloqueado: false });
    });
  }, 30000);
  afterAll(async () => { await env.clearFirestore(); await env.cleanup(); });
  const sellerDb = () => env.authenticatedContext(SELLER).firestore();
  test('SEC-01 vendedor NÃO habilita a própria distribuição', async () => {
    await assertFails(sellerDb().doc(`sistema_usuarios/${SELLER}`).set({ filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } }, { merge: true }));
  });
  test('SEC-02 vendedor NÃO altera o próprio limite diário', async () => {
    await assertFails(sellerDb().doc(`sistema_usuarios/${SELLER}`).update({ 'filaComercial.limiteNovasPorDia': 30 }));
  });
  test('SEC-03 vendedor NÃO concede a si operar nem gestão', async () => {
    await assertFails(sellerDb().doc(`sistema_usuarios/${SELLER}`).update({ modulos: ['fila-comercial-operar', 'fila-comercial-gestao'] }));
  });
  test('SEC-04 vendedor NÃO altera sistema_usuarios de outro usuário', async () => {
    await assertFails(sellerDb().doc(`sistema_usuarios/${GESTOR}`).update({ modulos: [] }));
  });
  test('SEC-05 gestor autorizado consegue salvar a configuração', async () => {
    await assertSucceeds(env.authenticatedContext(GESTOR).firestore().doc(`sistema_usuarios/${SELLER}`).set({ filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } }, { merge: true }));
  });
  test('SEC-06 vendedor ainda lê o próprio perfil (necessário para a tela da fila)', async () => {
    await assertSucceeds(sellerDb().doc(`sistema_usuarios/${SELLER}`).get());
  });
});
