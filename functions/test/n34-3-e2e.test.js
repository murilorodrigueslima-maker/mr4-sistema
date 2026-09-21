'use strict';

/**
 * N34.3 — Teste E2E: Pipeline → Snapshot → Firestore Emulator
 *
 * Prova o caminho completo de dados sintéticos:
 *   Dados sintéticos → processarClientesParaFila() → construirSnapshot()
 *   → assertSnapshotSeguro() → escreverSnapshotFila(db emulador) → leitura
 *
 * INVARIANTES:
 *   OPENAI_CALLS=0         (provider=null, sem LLM)
 *   PROD_WRITES=0          (db aponta para emulador localhost:8080)
 *   REAL_CUSTOMER_DATA=NO  (apenas dados sintéticos N34-3-SYNT-*)
 *   PRODUCTION_SYNC_CONNECTED=NO (pipeline não está conectado ao sync real)
 *
 * Pré-requisito:
 *   firebase emulators:start --only firestore
 *   (porta padrão: 8080)
 *
 * Executar:
 *   cd functions && npm run test:e2e
 *   ou: npm test -- --testPathPattern=n34-3-e2e
 */

// !! DEVE ser definido ANTES de qualquer require do firebase-admin !!
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT           = 'mr4-ponto';

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mr4-ponto' });
}
const db = admin.firestore();

const { processarClientesParaFila, PIPELINE_VERSION } = require('../lib/filaComercialPipeline');
const { construirSnapshot, assertSnapshotSeguro }     = require('../lib/filaComercialWriter');
const { escreverSnapshotFila, COLLECTION, DOCUMENT }  = require('../lib/filaComercialFirestoreWriter');
const { verificarCamposBloqueados }                   = require('../lib/filaComercialUtils');

// ─── Dados sintéticos — SEM DADOS REAIS DE CLIENTE ────────────────────────────
// Todos os clienteMr4Id começam com N34-3-SYNT- para não colidir com produção.
// Datas calculadas a partir de 2026-09-21 (dataReferencia do teste).

const DATA_REFERENCIA = '2026-09-21';

// Cliente 1: compras regulares a ~30 dias, última há ~150 dias → REATIVACAO_120D
const CLIENTE_REATIVACAO = {
  clienteMr4Id: 'N34-3-SYNT-001',
  nomeCliente:  'Cliente Sintético Reativação',
  vendas: [
    { id: 'v001a', data: '2026-04-24', valor_total: 500.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
    { id: 'v001b', data: '2026-03-25', valor_total: 480.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
    { id: 'v001c', data: '2026-02-23', valor_total: 520.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
    { id: 'v001d', data: '2026-01-24', valor_total: 490.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
    { id: 'v001e', data: '2025-12-25', valor_total: 510.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
  ],
};

// Cliente 2: compras regulares a ~30 dias, última há ~25 dias → PROGRAMAR_CICLO
const CLIENTE_PROXIMOS = {
  clienteMr4Id: 'N34-3-SYNT-002',
  nomeCliente:  'Cliente Sintético Próximos',
  vendas: [
    { id: 'v002a', data: '2026-08-27', valor_total: 300.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
    { id: 'v002b', data: '2026-07-28', valor_total: 310.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
    { id: 'v002c', data: '2026-06-28', valor_total: 295.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
    { id: 'v002d', data: '2026-05-29', valor_total: 305.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
  ],
};

// Cliente 3: apenas 1 compra antiga → NAO_AGIR (histórico insuficiente)
const CLIENTE_UNICA_COMPRA = {
  clienteMr4Id: 'N34-3-SYNT-003',
  nomeCliente:  'Cliente Sintético Único',
  vendas: [
    { id: 'v003a', data: '2025-01-10', valor_total: 200.00, nome_situacao: 'Concluída', vendedor_id: 'v-sint', nome_vendedor: 'Vendedor Sintético' },
  ],
};

const CLIENTES_SINTETICOS = [CLIENTE_REATIVACAO, CLIENTE_PROXIMOS, CLIENTE_UNICA_COMPRA];

// ─── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Limpa documentos de testes anteriores no emulador
  try {
    await db.collection(COLLECTION).doc(DOCUMENT).delete();
    await db.collection(COLLECTION).doc('snapshot-n34-3-test').delete();
  } catch (_) {
    // documento pode não existir, ok
  }
});

// ─── E2E-01: Pipeline executa sem erros ───────────────────────────────────────

let clientesBrutos;

test('E2E-01: processarClientesParaFila retorna array não vazio', async () => {
  clientesBrutos = await processarClientesParaFila(CLIENTES_SINTETICOS, {
    dataReferencia: DATA_REFERENCIA,
  });
  expect(Array.isArray(clientesBrutos)).toBe(true);
  expect(clientesBrutos.length).toBe(CLIENTES_SINTETICOS.length);
}, 30000);

// ─── E2E-02: OPENAI_CALLS=0 — campos LLM ausentes ────────────────────────────

test('E2E-02: OPENAI_CALLS=0 — comoAbordar ausente em todos os clientesBrutos', () => {
  expect(clientesBrutos).toBeDefined();
  for (const c of clientesBrutos) {
    expect(c).not.toHaveProperty('comoAbordar');
    expect(c.sellerAssist).not.toHaveProperty('comoAbordar');
  }
});

// ─── E2E-03: Campos obrigatórios do clienteBruto ──────────────────────────────

test('E2E-03: cada clienteBruto tem campos obrigatórios', () => {
  expect(clientesBrutos).toBeDefined();
  for (const c of clientesBrutos) {
    expect(c).toHaveProperty('clienteMr4Id');
    expect(c).toHaveProperty('nomeCliente');
    expect(c).toHaveProperty('decisaoAcaoComercial');
    expect(['AGIR_AGORA', 'PROGRAMAR_CICLO', 'NAO_AGIR']).toContain(c.decisaoAcaoComercial);
    expect(c).toHaveProperty('sellerAssist');
    expect(typeof c.sellerAssist).toBe('object');
  }
});

// ─── E2E-04: diasAteProximoCiclo presente no clienteBruto ────────────────────

test('E2E-04: diasAteProximoCiclo presente (não undefined) em clientesBrutos', () => {
  expect(clientesBrutos).toBeDefined();
  for (const c of clientesBrutos) {
    expect('diasAteProximoCiclo' in c).toBe(true);
    // pode ser null (AGIR_AGORA/NAO_AGIR) ou number (PROGRAMAR_CICLO)
    if (c.decisaoAcaoComercial === 'PROGRAMAR_CICLO') {
      expect(typeof c.diasAteProximoCiclo).toBe('number');
    }
  }
});

// ─── E2E-05: prioridade mapeada de prioridadeFinal ───────────────────────────

test('E2E-05: prioridade presente nos clientes com oportunidade principal', () => {
  expect(clientesBrutos).toBeDefined();
  const comOportunidade = clientesBrutos.filter(c => c.tipoOportunidade !== null);
  for (const c of comOportunidade) {
    expect('prioridade' in c).toBe(true);
  }
});

// ─── E2E-06: construirSnapshot executa sem erros ──────────────────────────────

let snapshot;

test('E2E-06: construirSnapshot retorna objeto com estrutura correta', () => {
  expect(clientesBrutos).toBeDefined();
  snapshot = construirSnapshot(clientesBrutos, {
    pipelineVersion: PIPELINE_VERSION,
    timestamp: new Date('2026-09-21T12:00:00Z'),
  });
  expect(snapshot).toHaveProperty('schemaVersion', 'v1');
  expect(snapshot).toHaveProperty('pipelineVersion', PIPELINE_VERSION);
  expect(Array.isArray(snapshot.clientesHoje)).toBe(true);
  expect(Array.isArray(snapshot.clientesProximos)).toBe(true);
  expect(snapshot).toHaveProperty('metadata');
  expect(snapshot.metadata).toHaveProperty('totalProcessados', CLIENTES_SINTETICOS.length);
});

// ─── E2E-07: assertSnapshotSeguro passa (sem CAMPOS_BLOQUEADOS) ───────────────

test('E2E-07: assertSnapshotSeguro não lança erro (CAMPOS_BLOQUEADOS ausentes)', () => {
  expect(snapshot).toBeDefined();
  expect(() => assertSnapshotSeguro(snapshot)).not.toThrow();
});

// ─── E2E-08: Nenhum campo bloqueado no snapshot ───────────────────────────────

test('E2E-08: verificarCamposBloqueados retorna [] para todo o snapshot', () => {
  expect(snapshot).toBeDefined();
  const bloqueados = verificarCamposBloqueados(snapshot);
  expect(bloqueados).toEqual([]);
});

// ─── E2E-09: escreverSnapshotFila persiste no emulador ───────────────────────

test('E2E-09: escreverSnapshotFila escreve em fila_comercial/snapshot no emulador', async () => {
  expect(snapshot).toBeDefined();
  await expect(escreverSnapshotFila(db, snapshot)).resolves.not.toThrow();
}, 15000);

// ─── E2E-10: Documento existe no emulador após escrita ───────────────────────

let docLido;

test('E2E-10: documento fila_comercial/snapshot existe e tem estrutura correta', async () => {
  const docRef = db.collection(COLLECTION).doc(DOCUMENT);
  docLido = await docRef.get();
  expect(docLido.exists).toBe(true);
  const data = docLido.data();
  expect(data).toHaveProperty('schemaVersion', 'v1');
  expect(Array.isArray(data.clientesHoje)).toBe(true);
  expect(Array.isArray(data.clientesProximos)).toBe(true);
  expect(data).toHaveProperty('metadata');
  expect(data).toHaveProperty('escritoEm');
}, 10000);

// ─── E2E-11: CAMPOS_BLOQUEADOS ausentes no documento persistido ───────────────

test('E2E-11: CAMPOS_BLOQUEADOS ausentes no documento persistido no Firestore', async () => {
  expect(docLido).toBeDefined();
  const data = docLido.data();
  const bloqueados = verificarCamposBloqueados(data);
  expect(bloqueados).toEqual([]);
});

// ─── E2E-12: clienteMr4Id ausente no VIEW MODEL (campo bloqueado) ─────────────

test('E2E-12: clienteMr4Id ausente nos clientesHoje e clientesProximos', async () => {
  expect(docLido).toBeDefined();
  const data = docLido.data();
  for (const c of [...data.clientesHoje, ...data.clientesProximos]) {
    expect(c).not.toHaveProperty('clienteMr4Id');
  }
});

// ─── E2E-13: comoAbordar ausente no VIEW MODEL ────────────────────────────────

test('E2E-13: comoAbordar ausente em todos os clientes no documento persistido', async () => {
  expect(docLido).toBeDefined();
  const data = docLido.data();
  for (const c of [...data.clientesHoje, ...data.clientesProximos]) {
    expect(c).not.toHaveProperty('comoAbordar');
    if (c.sellerAssist) {
      expect(c.sellerAssist).not.toHaveProperty('comoAbordar');
    }
  }
});

// ─── E2E-14: PRODUCTION_SYNC_CONNECTED=NO ────────────────────────────────────

test('E2E-14: PRODUCTION_SYNC_CONNECTED=NO — pipeline importa somente módulos determinísticos', () => {
  // Verifica que filaComercialPipeline.js não importa módulos de produção sync
  // Garantia estática: não há require de sync-dados, functions/index, ou webhook
  const src = require('fs').readFileSync(
    require('path').resolve(__dirname, '../lib/filaComercialPipeline.js'),
    'utf8'
  );
  expect(src).not.toMatch(/sync-dados/);
  expect(src).not.toMatch(/functions\/index/);
  expect(src).not.toMatch(/mr4-webhook/);
  expect(src).not.toMatch(/sendWhatsApp/);
  expect(src).not.toMatch(/sendEmail/);
  expect(src).not.toMatch(/OPENAI_API_KEY/);
});
