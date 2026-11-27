'use strict';
/**
 * E0 — a tela do funcionário PUBLICADA não conseguia assinar: o script clássico chamava setDoc/doc/db/serverTimestamp,
 * que só existem no <script type="module">. Aqui a PÁGINA REAL roda contra o emulador (Rules reais). Dados fictícios.
 *   node scripts/testes/rodar.js -- test/ponto-e0
 */

const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const crypto = require('crypto'), vm = require('vm');
const { abrirPagina, assentar, ler, REF_TELAS_ANTIGAS } = require('./helpers/ponto-pagina');
jest.setTimeout(60000);

const [HOST, PORT] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
if (!['localhost', '127.0.0.1'].includes(HOST)) throw new Error('Só roda no emulador local.');
const RULES = ler('modulos/firestore.rules');
const M = {}; vm.createContext(M); vm.runInContext(ler('modulos/ponto-regras.js'), M);
const UID = 'e0-func', F = 'e0-fx', MES = '2026-09';
let env;
const ler1 = async p => { let d; await env.withSecurityRulesDisabled(async c => { const s = await c.firestore().doc(p).get(); d = s.exists ? s.data() : null; }); return d; };

beforeAll(async () => { env = await initializeTestEnvironment({ projectId: 'demo-ponto-e0', firestore: { rules: RULES, host: HOST, port: Number(PORT) } }); });
afterAll(async () => { if (env) { await env.clearFirestore(); await env.cleanup(); } });
beforeEach(async () => {
  await env.clearFirestore();
  await env.withSecurityRulesDisabled(async c => {
    const d = c.firestore();
    await d.doc('users/' + UID).set({ role: 'funcionario', ativo: true, funcionarioId: F });
    const func = { nome: 'Pessoa Fictícia', cargo: 'Teste', jornada: '8', inicioBancoHoras: '2026-10-01' };   // setembro fora do período: sem pendências
    await d.doc('funcionarios/' + F).set(func);
    const snap = M.buildEspelhoSnapshot({ id: F, ...func }, [], [], [], MES, '2026-11-26');
    snap.geradoEm = '2026-10-01T12:00:00.000Z'; snap.funcId = F;
    const hash = crypto.createHash('sha256').update(M.canonicalizarSnapshot(snap)).digest('hex');
    await d.doc('espelhos/e0-esp').set({ id: 'e0-esp', funcId: F, mes: MES, versao: 1, versaoAnteriorId: null, assinado: false, snapshot: JSON.parse(JSON.stringify(snap)), hashSnapshot: hash });
  });
});

async function assinar(ref) {
  const p = await abrirPagina('ponto-func.html', { db: env.authenticatedContext(UID).firestore(), uid: UID, ref });
  await p.run(`abrirAssinar('e0-esp','${F}','${MES}','Setembro/2026')`); await assentar();
  p.run('iniciarCanvas()');
  let erro = null; await p.run('confirmarAssinatura()').catch(e => { erro = e; });
  await assentar();
  return { p, erro, doc: await ler1('espelhos/e0-esp') };
}

test('REPRODUÇÃO: a tela publicada falha com ReferenceError e o espelho continua sem assinatura', async () => {
  const r = await assinar(REF_TELAS_ANTIGAS);
  expect(r.p.avisos.join('|')).not.toMatch(/desatualizado|pendente/i);
  expect(String(r.erro && r.erro.message)).toMatch(/setDoc is not defined/);
  expect(r.doc.assinado).toBe(false);
});

test('CORRIGIDO: a tela assina o próprio espelho, com hora do servidor e hash do documento visto', async () => {
  const r = await assinar(undefined);
  expect(r.erro).toBeNull();
  expect(r.p.avisos.join('|')).toMatch(/assinado com sucesso/);
  expect(r.doc).toMatchObject({ assinado: true, status: 'assinado', assinadoPor: 'Pessoa Fictícia' });
  expect(r.doc.hashAssinado).toBe(r.doc.hashSnapshot);
  expect(typeof r.doc.assinadoEm.toMillis).toBe('function');
});

test('CORRIGIDO: recusa das Rules vira aviso na tela (sem "sucesso" falso)', async () => {
  const p = await abrirPagina('ponto-func.html', { db: env.authenticatedContext(UID).firestore(), uid: UID });
  await p.run(`abrirAssinar('e0-esp','${F}','${MES}','Setembro/2026')`); await assentar();
  p.run('iniciarCanvas()');
  await env.withSecurityRulesDisabled(c => c.firestore().doc('espelhos/e0-esp').update({ hashSnapshot: 'outra-versao' }));
  await p.run('confirmarAssinatura()'); await assentar();
  expect(p.avisos.join('|')).toMatch(/Não foi possível assinar/);
  expect(p.avisos.join('|')).not.toMatch(/sucesso/);
  expect((await ler1('espelhos/e0-esp')).assinado).toBe(false);
});
