'use strict';
/**
 * F1 — Política: usuário BLOQUEADO não acessa informações nem executa operações, independentemente do cargo.
 * (a) gcQuery, criarContaFuncionario e registrarPonto (que só checavam users.ativo/role) agora negam `sistema_usuarios.bloqueado === true`;
 * (b) registro estático de TODAS as callables/onRequest do index.js: cada uma precisa de evidência de guarda de bloqueio (ou IAM privado);
 *     callable nova sem classificação FALHA o teste (impede reintroduzir a lacuna).
 * Executar: firebase emulators:exec --only firestore,auth "npx jest test/f1-bloqueado-functions.test.js"
 */
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';
process.env.GC_ACCESS_TOKEN = 'mock-access-token-test'; process.env.GC_SECRET_ACCESS_TOKEN = 'mock-secret-token-test';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const { _gcQueryHandler, _criarContaFuncionarioHandler, _registrarPontoHandler } = require('../index');
const { exigirNaoBloqueado } = require('../lib/usuarioOperacional');

const P = {
  gestorOk:         { u: { role: 'gestor', ativo: true }, s: { admin: true, modulos: [], bloqueado: false } },
  gestorBloq:       { u: { role: 'gestor', ativo: true }, s: { admin: true, modulos: ['compras'], bloqueado: true } },
  gestorSemPerfil:  { u: { role: 'gestor', ativo: true } },
  gestorInativo:    { u: { role: 'gestor', ativo: false }, s: { admin: true, modulos: [], bloqueado: false } },
  funcBloq:         { u: { role: 'funcionario', ativo: true, funcionarioId: 'F1' }, s: { admin: false, modulos: ['expedicao', 'compras', 'garantia'], bloqueado: true } },
  funcOk:           { u: { role: 'funcionario', ativo: true }, s: { admin: false, modulos: ['expedicao'], bloqueado: false } },     // sem funcionarioId: para na checagem seguinte
  funcSemPerfil:    { u: { role: 'funcionario', ativo: true } },
};
const uid = n => 'f1-' + n;
beforeAll(async () => {
  for (const [n, p] of Object.entries(P)) { await db.collection('users').doc(uid(n)).set(p.u); if (p.s) await db.collection('sistema_usuarios').doc(uid(n)).set(p.s); }
});
const req = (n, data = {}) => ({ auth: { uid: uid(n) }, data });
const BLOQ = /Conta bloqueada/;
async function msg(fn) { try { await fn(); return 'OK'; } catch (e) { return `${e.code}|${e.message}`; } }

describe('gcQuery', () => {
  test('gestor BLOQUEADO (admin=true) ⇒ permission-denied "Conta bloqueada" (antes consultava o GestãoClick)', async () => { const r = await msg(() => _gcQueryHandler(req('gestorBloq', { operacao: 'LISTAR_PRODUTOS' }))); expect(r).toMatch(/permission-denied/); expect(r).toMatch(BLOQ); });
  test('funcionário BLOQUEADO com módulo expedicao ⇒ negado', async () => { const r = await msg(() => _gcQueryHandler(req('funcBloq', { operacao: 'LISTAR_VENDAS' }))); expect(r).toMatch(BLOQ); });
  test('gestor ativo NÃO bloqueado passa pela guarda (falha só adiante: operação desconhecida)', async () => { const r = await msg(() => _gcQueryHandler(req('gestorOk', { operacao: 'NAO_EXISTE' }))); expect(r).not.toMatch(BLOQ); expect(r).toMatch(/invalid-argument/); });
  test('gestor SEM perfil em sistema_usuarios segue passando (igual às Rules)', async () => { const r = await msg(() => _gcQueryHandler(req('gestorSemPerfil', { operacao: 'NAO_EXISTE' }))); expect(r).not.toMatch(BLOQ); });
  test('gestor INATIVO continua negado pela checagem anterior', async () => { const r = await msg(() => _gcQueryHandler(req('gestorInativo', { operacao: 'NAO_EXISTE' }))); expect(r).toMatch(/permission-denied/); expect(r).not.toMatch(BLOQ); });
  test('sem autenticação continua unauthenticated', async () => { expect(await msg(() => _gcQueryHandler({ auth: null, data: {} }))).toMatch(/unauthenticated/); });
});
describe('criarContaFuncionario', () => {
  const payload = { email: 'x@y.z', senha: '123', funcId: 'A', funcNome: 'B' };    // senha curta: se passar da guarda, falha em invalid-argument (sem criar nada)
  test('gestor BLOQUEADO ⇒ negado ANTES de qualquer criação', async () => { const r = await msg(() => _criarContaFuncionarioHandler(req('gestorBloq', payload))); expect(r).toMatch(/permission-denied/); expect(r).toMatch(BLOQ); });
  test('gestor ativo NÃO bloqueado passa pela guarda (para na validação do payload)', async () => { const r = await msg(() => _criarContaFuncionarioHandler(req('gestorOk', payload))); expect(r).not.toMatch(BLOQ); expect(r).toMatch(/invalid-argument/); });
  test('funcionário (BLOQUEADO ou não) continua sem poder criar contas', async () => { expect(await msg(() => _criarContaFuncionarioHandler(req('funcBloq', payload)))).toMatch(/Somente gestores/); });
});
describe('registrarPonto', () => {
  test('funcionário BLOQUEADO ⇒ negado (não registra ponto)', async () => { const r = await msg(() => _registrarPontoHandler(req('funcBloq', { requestId: 'r1', tipoEsperado: 'entrada' }))); expect(r).toMatch(/permission-denied/); expect(r).toMatch(BLOQ); });
  test('funcionário NÃO bloqueado passa pela guarda (para na checagem de vínculo)', async () => { const r = await msg(() => _registrarPontoHandler(req('funcOk', { requestId: 'r2', tipoEsperado: 'entrada' }))); expect(r).not.toMatch(BLOQ); });
  test('funcionário comum SEM perfil administrativo segue podendo registrar (não há bloqueio a respeitar)', async () => { const r = await msg(() => _registrarPontoHandler(req('funcSemPerfil', { requestId: 'r3', tipoEsperado: 'entrada' }))); expect(r).not.toMatch(BLOQ); });
});
describe('exigirNaoBloqueado (unidade)', () => {
  test('FAIL CLOSED: erro ao ler sistema_usuarios ⇒ permission-denied (não presume "não bloqueado")', async () => {
    const dbQuebrado = { collection: () => ({ doc: () => ({ get: async () => { throw new Error('UNAVAILABLE'); } }) }) };
    await expect(exigirNaoBloqueado(dbQuebrado, 'x')).rejects.toMatchObject({ code: 'permission-denied' });
  });
  test('bloqueado=true ⇒ nega; false/ausente/sem doc ⇒ permite', async () => {
    const mk = d => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: d !== undefined, data: () => d }) }) }) });
    await expect(exigirNaoBloqueado(mk({ bloqueado: true }), 'x')).rejects.toMatchObject({ code: 'permission-denied' });
    await expect(exigirNaoBloqueado(mk({ bloqueado: false }), 'x')).resolves.toBeTruthy();
    await expect(exigirNaoBloqueado(mk({}), 'x')).resolves.toBeTruthy();
    await expect(exigirNaoBloqueado(mk(undefined), 'x')).resolves.toBeNull();
  });
  test('"bloqueado" truthy mas não booleano true NÃO bloqueia (mesma semântica das Rules: != true)', async () => {
    const mk = d => ({ collection: () => ({ doc: () => ({ get: async () => ({ exists: true, data: () => d }) }) }) });
    await expect(exigirNaoBloqueado(mk({ bloqueado: 'true' }), 'x')).resolves.toBeTruthy();
  });
});

describe('registro estático: TODA callable/onRequest do index.js tem guarda de bloqueio (ou IAM privado)', () => {
  const ROOT = path.resolve(__dirname, '..'); const idx = fs.readFileSync(path.join(ROOT, 'index.js'), 'utf8');
  const lib = f => fs.readFileSync(path.join(ROOT, f), 'utf8');
  const EVID = {   // callable → [arquivo, regex que prova a guarda]
    registrarPonto: ['index.js', /exigirNaoBloqueado\(db, uid\);\s*\/\/ F1\n\s*const funcId/], criarContaFuncionario: ['index.js', /exigirNaoBloqueado\(db, uid\);\s*\/\/ F1: gestor bloqueado/], gcQuery: ['index.js', /exigirNaoBloqueado\(db, uid\);\s*\/\/ F1: bloqueado não consulta/],
    claimOpportunity: ['lib/canaryCallable.js', /sys\.bloqueado === true/], registerOutcome: ['lib/canaryCallable.js', /sys\.bloqueado === true/], releaseOpportunity: ['lib/canaryCallable.js', /sys\.bloqueado === true/],
    crmConsulta: ['lib/crmConsulta.js', /sys\.bloqueado === true/], aiAgente: ['lib/crmConsulta.js', /sys\.bloqueado === true/],   // aiAgente autoriza por CRM.perfilDeAcesso
    crmReativacaoGestao: ['lib/carteiraOwnership.js', /s\.data\(\)\.bloqueado === true/], crmContatoReativacao: ['lib/contatoReativacao.js', /s\.data\(\)\.bloqueado === true/],
    crmAtribuicaoRevisao: ['lib/atribuicaoRevisao.js', /OWN\.autorizarRevisor\(store, request\.auth\.uid\)/],   // guarda de bloqueio dentro de autorizarRevisor
    pontoBancoCompensar: ['lib/pontoBanco.js', /s\.data\(\)\.bloqueado === true/], pontoBancoEstornar: ['lib/pontoBanco.js', /s\.data\(\)\.bloqueado === true/], pontoBancoLancamento: ['lib/pontoBanco.js', /s\.data\(\)\.bloqueado === true/],
    pontoPendenciaDecidir: ['lib/pontoBanco.js', /s\.data\(\)\.bloqueado === true/], pontoEscalaDefinir: ['lib/pontoBanco.js', /s\.data\(\)\.bloqueado === true/], pontoBancoFolga: ['lib/pontoBanco.js', /s\.data\(\)\.bloqueado === true/], pontoBancoExcecao: ['lib/pontoBanco.js', /s\.data\(\)\.bloqueado === true/], pontoJustificativaDecidir: ['lib/pontoBanco.js', /s\.data\(\)\.bloqueado === true/],
    ...Object.fromEntries(['gestaoComprasDados', 'gestaoComprasParametrosSalvar', 'gestaoComprasPendenciaConfirmar', 'gestaoComprasOrigemConfirmar'].map(n => [n, ['lib/comprasGestao.js', /await exigirNaoBloqueado\(db, uid\)/]])),   // guarda dentro de autorizar()
    comprasSyncManual: ['index.js', /invoker:\s+'private'/],    // onRequest sem chamada de usuário final: só IAM
  };
  const exportadas = [...idx.matchAll(/^exports\.(\w+)\s*=\s*(onCall|onRequest)\(/gm)].map(m => m[1]);
  test('o index.js exporta callables e todas estão classificadas', () => { expect(exportadas.length).toBeGreaterThanOrEqual(19); expect(exportadas.filter(n => !EVID[n])).toEqual([]); });
  test('cada guarda declarada existe no arquivo indicado', () => { for (const n of exportadas) { const [f, re] = EVID[n]; expect({ n, ok: re.test(lib(f)) }).toEqual({ n, ok: true }); } });
});
