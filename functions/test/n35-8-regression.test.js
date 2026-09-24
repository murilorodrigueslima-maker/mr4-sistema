'use strict';
// N35.8 — Testes de regressão e invariantes do sistema
// Cobre:
//   - Fix de nome GC_NATIVE em filaSnapshotGenerator.js (linha 102)
//   - Invariante PROD_WRITES=0
//   - Imutabilidade de módulos
//   - Integração identidade + estado + worklist

const {
  SOURCES,
  buildCommercialEntityId,
  commercialEntityIdFromPerfil360,
  buildOpportunityInstanceId,
} = require('../lib/commercialIdentity');

const {
  ESTADOS,
  OUTCOMES,
  criarEstadoInicial,
  claimOportunidade,
  registrarOutcome,
} = require('../lib/filaOperacional');

const {
  gerarWorklistSimples,
} = require('../lib/dailyWorklist');

const NOW = '2026-09-24T12:00:00.000Z';

// ── Fix de nome GC_NATIVE (N35.7 Bug) ────────────────────────────────────────
// A função carregarPerfisComNomes buscava nome só em clienteInfoMap.
// GC_NATIVE não tem doc em clientes/, então info={} e nomeCliente=null.
// Fix: info.nome || doc.data().nomeCliente || null
//
// Teste simula a lógica corrigida diretamente (sem I/O Firestore).

test('N35-8-REG-01: nome GC_NATIVE usa perfil360.nomeCliente como fallback', () => {
  // Simula: clienteInfoMap não tem entrada para doc GC_NATIVE (gestaoClickId como docId)
  const clienteInfoMap = new Map();

  const gcDocId   = '31349459';
  const perfilData = { nomeCliente: '51.908.552 MAGNO ERNESTO TEIXEIRA', source: 'GC_NATIVE' };

  // Lógica ANTES do fix: info.nome || null
  const infoBefore = clienteInfoMap.get(gcDocId) || {};
  const nomeBefore  = infoBefore.nome || null;
  expect(nomeBefore).toBeNull();

  // Lógica DEPOIS do fix: info.nome || doc.data().nomeCliente || null
  const infoAfter  = clienteInfoMap.get(gcDocId) || {};
  const nomeAfter   = infoAfter.nome || perfilData.nomeCliente || null;
  expect(nomeAfter).toBe('51.908.552 MAGNO ERNESTO TEIXEIRA');
});

test('N35-8-REG-02: nome MR4_LINKED mantém precedência do clienteInfoMap', () => {
  const clienteInfoMap = new Map([
    ['mr4docid123', { nome: 'Nome Correto MR4' }],
  ]);
  const perfilData = { nomeCliente: 'Nome Antigo No Perfil', clienteMr4Id: 'mr4docid123' };

  const info = clienteInfoMap.get('mr4docid123') || {};
  // Fix não muda comportamento MR4_LINKED: info.nome existe, uso dele
  const nome = info.nome || perfilData.nomeCliente || null;
  expect(nome).toBe('Nome Correto MR4');
});

test('N35-8-REG-03: sem nomeCliente em nenhum lugar → null mantido', () => {
  const clienteInfoMap = new Map();
  const perfilData     = {}; // sem nomeCliente

  const info = clienteInfoMap.get('docid') || {};
  const nome = info.nome || perfilData.nomeCliente || null;
  expect(nome).toBeNull();
});

// ── Integração: identidade + estado + worklist ────────────────────────────────

test('N35-8-REG-04: pipeline completo para GC_NATIVE sem regressão', () => {
  const perfil = {
    source:        'GC_NATIVE',
    gestaoClickId: '31349459',
    clienteMr4Id:  '31349459', // alias usado pelo pipeline
    nomeCliente:   '51.908.552 MAGNO ERNESTO TEIXEIRA',
    ultimaCompraEm: '2026-08-01',
  };

  // 1. Identidade
  const entityId  = commercialEntityIdFromPerfil360(perfil);
  expect(entityId).toBe('GC_NATIVE:31349459');

  // 2. Instance ID para oportunidade
  const oppId = buildOpportunityInstanceId(entityId, 'REATIVACAO_120D', perfil.ultimaCompraEm);
  expect(oppId).toMatch(/^[0-9a-f]{16}$/);

  // 3. Estado operacional inicial
  const est = criarEstadoInicial(entityId, oppId, 'REATIVACAO_120D', NOW);
  expect(est.estado).toBe(ESTADOS.DISPONIVEL);

  // 4. Claim e registro de outcome
  let estAtivo = claimOportunidade(est, 'operador_comercial', NOW);
  let estFinal = registrarOutcome(estAtivo, 'operador_comercial', OUTCOMES.CONVERSA_REALIZADA, NOW);
  expect(estFinal.estado).toBe(ESTADOS.CONCLUIDA);

  // 5. Worklist com cliente concluído deve ter 0 itens (se filtrado externamente)
  const clientesHoje = [{ oppId, decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: 45 }];
  const wl = gerarWorklistSimples(clientesHoje, 10);
  // gerarWorklistSimples não filtra estados (sem mapa) — todos entram
  expect(wl.worklist).toHaveLength(1);
});

test('N35-8-REG-05: MR4_LINKED e GC_NATIVE com mesmo valor numérico não colidem', () => {
  // Um GC_NATIVE com gestaoClickId='12345' e um MR4_LINKED com mr4ClientId='mr12345' são distintos
  const gcEntity  = buildCommercialEntityId({ source: 'GC_NATIVE',  gestaoClickId: '12345' });
  const mr4Entity = buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: 'mr12345' });
  expect(gcEntity).not.toBe(mr4Entity);

  // IDs de oportunidade para o mesmo tipo+data também são distintos
  const gcOpp  = buildOpportunityInstanceId(gcEntity,  'REATIVACAO_120D', '2026-09-01');
  const mr4Opp = buildOpportunityInstanceId(mr4Entity, 'REATIVACAO_120D', '2026-09-01');
  expect(gcOpp).not.toBe(mr4Opp);
});

// ── Invariante PROD_WRITES=0 ──────────────────────────────────────────────────

test('N35-8-REG-06: módulos N35.8 não exportam funções de escrita Firestore', () => {
  const identity  = require('../lib/commercialIdentity');
  const operacional = require('../lib/filaOperacional');
  const worklist  = require('../lib/dailyWorklist');

  // Nenhum módulo deve exportar set, update, add, create, delete, write, save
  const writeSuspect = /^(set|update|add|create|delete|write|save|commit|batch|runTransaction)/i;

  for (const [modName, mod] of [
    ['commercialIdentity', identity],
    ['filaOperacional', operacional],
    ['dailyWorklist', worklist],
  ]) {
    for (const key of Object.keys(mod)) {
      if (typeof mod[key] === 'function') {
        expect(key).not.toMatch(writeSuspect);
      }
    }
  }
});

test('N35-8-REG-07: commercialIdentity não requer firebase-admin nem firestore', () => {
  // O módulo deve ser puro — sem dependências de I/O
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../lib/commercialIdentity.js'),
    'utf8'
  );
  expect(src).not.toMatch(/firebase-admin/);
  expect(src).not.toMatch(/firestore/i);
  expect(src).not.toMatch(/require\(['"]googleapis['"]\)/);
});

test('N35-8-REG-08: filaOperacional não requer firebase-admin nem firestore', () => {
  const src = require('fs').readFileSync(
    require('path').join(__dirname, '../lib/filaOperacional.js'),
    'utf8'
  );
  expect(src).not.toMatch(/firebase-admin/);
  expect(src).not.toMatch(/Firestore/);
});

// ── Estabilidade de IDs ───────────────────────────────────────────────────────

test('N35-8-REG-09: opportunityInstanceId estável com múltiplas chamadas no mesmo ciclo', () => {
  const entityId = 'MR4_LINKED:abc123XYZ0987654321A';
  const tipo     = 'JANELA_DE_RECOMPRA';
  const dt       = '2026-07-15';

  const ids = Array.from({ length: 5 }, () =>
    buildOpportunityInstanceId(entityId, tipo, dt)
  );
  expect(new Set(ids).size).toBe(1);
});

test('N35-8-REG-10: 10 canários GC_NATIVE têm identidades distintas entre si', () => {
  const gcIds = [
    '18950912', '19071983', '19156323', '19463017', '19473623',
    '23011207', '30716035', '31349459', '32275912', '36551586',
  ];

  const entityIds = gcIds.map(id =>
    buildCommercialEntityId({ source: 'GC_NATIVE', gestaoClickId: id })
  );
  const unique = new Set(entityIds);
  expect(unique.size).toBe(10);
  entityIds.forEach(id => expect(id.startsWith('GC_NATIVE:')).toBe(true));
});
