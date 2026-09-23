'use strict';
// N34.5 — Testes do Gerador de Snapshot da Fila Comercial
//
// INVARIANTES VERIFICADAS AQUI:
//   OPENAI_CALLS=0          — nenhuma dependência de LLM
//   PROD_WRITES=0           — db mock; sem emulador obrigatório
//   SELLER_ASSIST=NO        — comoAbordar ausente no output
//   PII_IN_LOGS=NO          — logs contêm apenas contagens
//   MAIN_SYNC_UNTOUCHED=YES — writes apenas em fila_comercial/snapshot
//   FUNCTION_DEPLOYED=NO    — teste local, não deploy

const { calcularPerfil360 }    = require('../lib/perfil360');
const { executarGeracaoFilaSnapshot, calcularDataReferencia, carregarPerfisComNomes }
                                = require('../lib/filaSnapshotGenerator');
const { processarPerfilParaFila, processarPerfisParaFila, PIPELINE_VERSION }
                                = require('../lib/filaComercialPipeline');
const { CAMPOS_BLOQUEADOS, verificarCamposBloqueados } = require('../lib/filaComercialUtils');

// ── Fixtures ────────────────────────────────────────────────────────────────

const DR = '2026-09-21';

function mkVenda(id, data, valor, clienteId) {
  return { id, data, nome_situacao: 'Concretizada', valor_total: valor, cliente_id: clienteId, produtos: [] };
}

// REATIVACAO_120D: última compra 150 dias antes da dataReferencia (ciclo ~30d)
const VENDAS_REATIVACAO = [
  mkVenda('r1', '2026-04-24', 500, 'gc-r01'),
  mkVenda('r2', '2026-03-25', 480, 'gc-r01'),
  mkVenda('r3', '2026-02-23', 520, 'gc-r01'),
  mkVenda('r4', '2026-01-24', 490, 'gc-r01'),
];

// PROGRAMAR_CICLO dentro da janela de 7d: última compra 25d antes, ciclo ~30d → diasAte ≈ 5
const VENDAS_PROXIMOS_7D = [
  mkVenda('p1', '2026-08-27', 300, 'gc-p01'),
  mkVenda('p2', '2026-07-28', 310, 'gc-p01'),
  mkVenda('p3', '2026-06-28', 295, 'gc-p01'),
  mkVenda('p4', '2026-05-29', 305, 'gc-p01'),
];

// PROGRAMAR_CICLO além de 7d: última compra 10d antes, ciclo ~30d → diasAte ≈ 20 (não entra em proximos)
const VENDAS_PROXIMOS_ALEM = [
  mkVenda('q1', '2026-09-11', 400, 'gc-q01'),
  mkVenda('q2', '2026-08-12', 390, 'gc-q01'),
  mkVenda('q3', '2026-07-13', 410, 'gc-q01'),
];

// NAO_AGIR: compra única recente → sem ciclo calculável → diasEntreComprasMediana=null → NAO_AGIR
const VENDAS_NAO_AGIR = [
  mkVenda('n1', '2026-09-20', 200, 'gc-n01'),
];

// Pré-computa perfis (usa calcularPerfil360 com dataReferencia fixa)
const PERFIL_REATIVACAO = calcularPerfil360({ clienteMr4Id: 'MR4-SYNT-R01', vendas: VENDAS_REATIVACAO, dataReferencia: DR });
const PERFIL_PROXIMOS_7D = calcularPerfil360({ clienteMr4Id: 'MR4-SYNT-P01', vendas: VENDAS_PROXIMOS_7D, dataReferencia: DR });
const PERFIL_PROXIMOS_ALEM = calcularPerfil360({ clienteMr4Id: 'MR4-SYNT-Q01', vendas: VENDAS_PROXIMOS_ALEM, dataReferencia: DR });
const PERFIL_NAO_AGIR   = calcularPerfil360({ clienteMr4Id: 'MR4-SYNT-N01', vendas: VENDAS_NAO_AGIR,    dataReferencia: DR });

const TODOS_PERFIS = [PERFIL_REATIVACAO, PERFIL_PROXIMOS_7D, PERFIL_PROXIMOS_ALEM, PERFIL_NAO_AGIR];

// ── Mock db factory ─────────────────────────────────────────────────────────

/**
 * Cria um db mock para testes. Não require Firebase Admin.
 *
 * @param {object[]} perfis360  — perfis que simulam docs de perfis_360
 * @param {object[]} clientes   — docs que simulam a collection clientes (cada um precisa de {id, nome})
 * @param {object}   opts       — { failWrite?: Error }
 */
function makeMockDb(perfis360 = [], clientes = [], opts = {}) {
  const store  = {};
  const writes = [];

  return {
    collection(name) {
      return {
        async get() {
          let rawDocs;
          if (name === 'perfis_360') {
            rawDocs = perfis360.map(p => ({ id: p.clienteMr4Id, data: () => p }));
          } else if (name === 'clientes') {
            rawDocs = clientes.map(c => ({ id: c.id, data: () => c }));
          } else {
            rawDocs = [];
          }
          return { docs: rawDocs };
        },
        doc(docId) {
          return {
            async set(data) {
              if (opts.failWrite) throw opts.failWrite;
              store[`${name}/${docId}`] = data;
              writes.push({ collection: name, doc: docId, data });
            },
            async get() {
              const d = store[`${name}/${docId}`];
              return { exists: !!d, data: () => d || null };
            },
          };
        },
      };
    },
    _writes: writes,
    _store:  store,
  };
}

function makeDefaultDb(opts = {}) {
  const clientes = [
    { id: 'MR4-SYNT-R01', nome: 'Cliente Reativação' },
    { id: 'MR4-SYNT-P01', nome: 'Cliente Próximos 7d' },
    { id: 'MR4-SYNT-Q01', nome: 'Cliente Próximos Além' },
    { id: 'MR4-SYNT-N01', nome: 'Cliente Não Agir' },
  ];
  return makeMockDb(TODOS_PERFIS, clientes, opts);
}

// ── Grupo A — Happy path ─────────────────────────────────────────────────────

describe('A — Happy path: snapshot completo', () => {
  let snapshot;
  let db;

  beforeAll(async () => {
    db = makeDefaultDb();
    snapshot = await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
  });

  test('A-01: executarGeracaoFilaSnapshot resolve sem erro', () => {
    expect(snapshot).toBeDefined();
  });

  test('A-02: snapshot contém clientesHoje e clientesProximos como arrays', () => {
    expect(Array.isArray(snapshot.clientesHoje)).toBe(true);
    expect(Array.isArray(snapshot.clientesProximos)).toBe(true);
  });

  test('A-03: clientesHoje inclui cliente com REATIVACAO_120D', () => {
    const tipos = snapshot.clientesHoje.map(c => c.tipoOportunidade);
    expect(tipos).toContain('REATIVACAO_120D');
  });

  test('A-04: clientesProximos inclui cliente com diasAte <= 7', () => {
    const dentroJanela = snapshot.clientesProximos.filter(
      c => c.decisaoAcaoComercial === 'PROGRAMAR_CICLO' && c.diasAteProximoCiclo <= 7
    );
    expect(dentroJanela.length).toBeGreaterThan(0);
  });

  test('A-05: snapshot.metadata.totalProcessados == número de perfis', () => {
    expect(snapshot.metadata.totalProcessados).toBe(TODOS_PERFIS.length);
  });

  test('A-06: snapshot escrito em fila_comercial/snapshot', () => {
    const write = db._writes.find(w => w.collection === 'fila_comercial' && w.doc === 'snapshot');
    expect(write).toBeDefined();
  });

  test('A-07: snapshot escrito contém escritoEm (filaComercialFirestoreWriter)', () => {
    const written = db._store['fila_comercial/snapshot'];
    expect(written).toBeDefined();
    expect(written.escritoEm).toBeDefined();
  });

  test('A-08: sem escrita em coleções não autorizadas', () => {
    const proibidas = ['perfis_360', 'vendas_gc', 'sync_state', 'clientes', 'display_metrics'];
    for (const col of proibidas) {
      const write = db._writes.find(w => w.collection === col);
      expect(write).toBeUndefined();
    }
  });
});

// ── Grupo B — Campos bloqueados ─────────────────────────────────────────────

describe('B — Campos bloqueados ausentes no snapshot', () => {
  let snapshot;

  beforeAll(async () => {
    const db = makeDefaultDb();
    snapshot = await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
  });

  test('B-01: snapshot não contém nenhum campo bloqueado', () => {
    const encontrados = verificarCamposBloqueados(snapshot);
    expect(encontrados).toEqual([]);
  });

  test('B-02: nenhum cliente em clientesHoje tem comoAbordar', () => {
    for (const c of snapshot.clientesHoje) {
      expect(c).not.toHaveProperty('comoAbordar');
    }
  });

  test('B-03: nenhum cliente em clientesProximos tem comoAbordar', () => {
    for (const c of snapshot.clientesProximos) {
      expect(c).not.toHaveProperty('comoAbordar');
    }
  });

  test('B-04: clienteMr4Id não aparece no view model dos clientes', () => {
    for (const c of [...snapshot.clientesHoje, ...snapshot.clientesProximos]) {
      expect(c).not.toHaveProperty('clienteMr4Id');
    }
  });

  test('B-05: CAMPOS_BLOQUEADOS verificados — lista completa intacta', () => {
    const esperados = ['comoAbordar', 'scoreTotal', 'scoreClassificacao', 'score',
      'classificacao', 'prioridade', 'clienteMr4Id', 'gc_id',
      'faturamento30d', 'faturamento60d', 'faturamentoTotal',
      'llmStatus', 'versaoPrompt', 'mockMode', 'aiMode',
      'trace', 'auditoria', 'grounding', 'llmUsed'];
    for (const campo of esperados) {
      expect(CAMPOS_BLOQUEADOS).toContain(campo);
    }
  });
});

// ── Grupo C — Snapshot vazio válido ─────────────────────────────────────────

describe('C — Snapshot vazio válido (sem perfis ou todos NAO_AGIR)', () => {
  test('C-01: snapshot com db vazio resolve sem erro', async () => {
    const db = makeMockDb([], []);
    const snap = await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(snap).toBeDefined();
  });

  test('C-02: snapshot vazio tem clientesHoje: [] e clientesProximos: []', async () => {
    const db = makeMockDb([], []);
    const snap = await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(snap.clientesHoje).toEqual([]);
    expect(snap.clientesProximos).toEqual([]);
  });

  test('C-03: snapshot vazio ainda é escrito em fila_comercial/snapshot', async () => {
    const db = makeMockDb([], []);
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    const write = db._writes.find(w => w.collection === 'fila_comercial' && w.doc === 'snapshot');
    expect(write).toBeDefined();
  });

  test('C-04: snapshot só com NAO_AGIR produz clientesHoje vazio', async () => {
    const db = makeMockDb([PERFIL_NAO_AGIR], [{ id: 'MR4-SYNT-N01', nome: 'Nenhum' }]);
    const snap = await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(snap.clientesHoje).toEqual([]);
  });

  test('C-05: perfil sem clienteMr4Id é filtrado antes do pipeline', async () => {
    const perfilSemId = { ...PERFIL_NAO_AGIR, clienteMr4Id: undefined };
    const db = makeMockDb([perfilSemId], []);
    const snap = await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(snap.metadata.totalProcessados).toBe(0);
  });
});

// ── Grupo D — Last-known-good: falha na escrita ──────────────────────────────

describe('D — Last-known-good: falha na escrita não corrompe snapshot anterior', () => {
  test('D-01: falha em set() faz executarGeracaoFilaSnapshot rejeitar', async () => {
    const err = new Error('Firestore write failed (simulado)');
    const db  = makeDefaultDb({ failWrite: err });
    await expect(executarGeracaoFilaSnapshot({ db, dataReferencia: DR })).rejects.toThrow('Firestore write failed');
  });

  test('D-02: após falha, nenhuma escrita persiste em fila_comercial', async () => {
    const err = new Error('Falha de escrita');
    const db  = makeDefaultDb({ failWrite: err });
    try { await executarGeracaoFilaSnapshot({ db, dataReferencia: DR }); } catch (_) {}
    expect(db._writes.filter(w => w.collection === 'fila_comercial')).toHaveLength(0);
  });

  test('D-03: falha ANTES de set() não toca o store — last-known-good preservado', async () => {
    const err = new Error('Sem espaço em disco');
    const db  = makeDefaultDb({ failWrite: err });
    const snapshotAnterior = { clientesHoje: [{ nomeCliente: 'Anterior' }] };
    db._store['fila_comercial/snapshot'] = snapshotAnterior;
    try { await executarGeracaoFilaSnapshot({ db, dataReferencia: DR }); } catch (_) {}
    expect(db._store['fila_comercial/snapshot']).toEqual(snapshotAnterior);
  });
});

// ── Grupo E — Reutilização de pipeline / sem Seller Assist ──────────────────

describe('E — Pipeline reusado, sem Seller Assist, sem LLM', () => {
  test('E-01: processarPerfilParaFila é exportado de filaComercialPipeline', () => {
    expect(typeof processarPerfilParaFila).toBe('function');
  });

  test('E-02: processarPerfisParaFila é exportado de filaComercialPipeline', () => {
    expect(typeof processarPerfisParaFila).toBe('function');
  });

  test('E-03: processarPerfilParaFila retorna shape idêntico a processarCliente', async () => {
    const resultado = await processarPerfilParaFila(PERFIL_REATIVACAO, 'Teste', { dataReferencia: DR });
    expect(resultado).toHaveProperty('clienteMr4Id');
    expect(resultado).toHaveProperty('decisaoAcaoComercial');
    expect(resultado).toHaveProperty('sellerAssist');
    expect(resultado.sellerAssist).toHaveProperty('situacao');
    expect(resultado.sellerAssist).toHaveProperty('quando');
    expect(resultado.sellerAssist).toHaveProperty('sinais');
  });

  test('E-04: output de processarPerfilParaFila não contém comoAbordar', async () => {
    const resultado = await processarPerfilParaFila(PERFIL_REATIVACAO, 'Teste', { dataReferencia: DR });
    expect(resultado).not.toHaveProperty('comoAbordar');
    expect(JSON.stringify(resultado)).not.toContain('comoAbordar');
  });

  test('E-05: filaComercialPipeline.js não importa sellerAssistService (static)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../lib/filaComercialPipeline.js'), 'utf8'
    );
    expect(src).not.toMatch(/sellerAssistService/);
    expect(src).not.toMatch(/calcularSellerAssist/);
  });

  test('E-06: filaSnapshotGenerator.js não importa sellerAssistService nem OpenAI (static)', () => {
    const src = require('fs').readFileSync(
      require('path').join(__dirname, '../lib/filaSnapshotGenerator.js'), 'utf8'
    );
    expect(src).not.toMatch(/sellerAssistService/);
    expect(src).not.toMatch(/calcularSellerAssist/);
    expect(src).not.toMatch(/require\s*\(\s*['"].*openai/i);
  });

  test('E-07: PIPELINE_VERSION exportado de filaComercialPipeline', () => {
    expect(typeof PIPELINE_VERSION).toBe('string');
    expect(PIPELINE_VERSION.length).toBeGreaterThan(0);
  });
});

// ── Grupo F — Isolamento do sync principal ─────────────────────────────────

describe('F — Isolamento do sync principal (sync360 intocado)', () => {
  test('F-01: gerador não escreve em vendas_gc', async () => {
    const db = makeDefaultDb();
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(db._writes.find(w => w.collection === 'vendas_gc')).toBeUndefined();
  });

  test('F-02: gerador não escreve em perfis_360', async () => {
    const db = makeDefaultDb();
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(db._writes.find(w => w.collection === 'perfis_360')).toBeUndefined();
  });

  test('F-03: gerador não escreve em sync_state', async () => {
    const db = makeDefaultDb();
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(db._writes.find(w => w.collection === 'sync_state')).toBeUndefined();
  });

  test('F-04: gerador não escreve em display_metrics', async () => {
    const db = makeDefaultDb();
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(db._writes.find(w => w.collection === 'display_metrics')).toBeUndefined();
  });

  test('F-05: único write é em fila_comercial/snapshot', async () => {
    const db = makeDefaultDb();
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    const writesValidos = db._writes.filter(
      w => w.collection === 'fila_comercial' && w.doc === 'snapshot'
    );
    expect(db._writes.length).toBe(1);
    expect(writesValidos.length).toBe(1);
  });
});

// ── Grupo G — Observabilidade (logs PII-free) ────────────────────────────────

describe('G — Observabilidade: logs PII-free', () => {
  let logLines;

  beforeAll(async () => {
    logLines = [];
    const mockLogger = { log: (msg) => logLines.push(msg), error: () => {} };
    const db = makeDefaultDb();
    await executarGeracaoFilaSnapshot({ db, logger: mockLogger, dataReferencia: DR });
  });

  test('G-01: evento fila_snapshot_start é logado', () => {
    const start = logLines.find(l => {
      try { return JSON.parse(l).event === 'fila_snapshot_start'; } catch { return false; }
    });
    expect(start).toBeDefined();
  });

  test('G-02: evento fila_snapshot_success é logado', () => {
    const success = logLines.find(l => {
      try { return JSON.parse(l).event === 'fila_snapshot_success'; } catch { return false; }
    });
    expect(success).toBeDefined();
  });

  test('G-03: fila_snapshot_start inclui dataReferencia mas sem nome de cliente', () => {
    const startLog = logLines.find(l => {
      try { return JSON.parse(l).event === 'fila_snapshot_start'; } catch { return false; }
    });
    const parsed = JSON.parse(startLog);
    expect(parsed.dataReferencia).toBe(DR);
    expect(JSON.stringify(parsed)).not.toMatch(/Cliente|Reativação|Próximos/);
  });

  test('G-04: fila_snapshot_success tem profilesConsidered, todayCount, upcomingCount, durationMs', () => {
    const successLog = logLines.find(l => {
      try { return JSON.parse(l).event === 'fila_snapshot_success'; } catch { return false; }
    });
    const parsed = JSON.parse(successLog);
    expect(typeof parsed.profilesConsidered).toBe('number');
    expect(typeof parsed.todayCount).toBe('number');
    expect(typeof parsed.upcomingCount).toBe('number');
    expect(typeof parsed.durationMs).toBe('number');
  });

  test('G-05: logs não contêm IDs de cliente MR4', () => {
    for (const line of logLines) {
      expect(line).not.toMatch(/MR4-SYNT/);
    }
  });
});

// ── Grupo H — Schema do snapshot ────────────────────────────────────────────

describe('H — Schema e estrutura do snapshot', () => {
  let snapshot;

  beforeAll(async () => {
    const db = makeDefaultDb();
    snapshot = await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
  });

  test('H-01: schemaVersion === "v2" (N34.6 bump)', () => {
    expect(snapshot.schemaVersion).toBe('v2'); // N34.6: v1→v2 (clientesProspeccao added)
  });

  test('H-02: pipelineVersion está presente e é string', () => {
    expect(typeof snapshot.pipelineVersion).toBe('string');
    expect(snapshot.pipelineVersion.length).toBeGreaterThan(0);
  });

  test('H-03: timestamp é instância de Date', () => {
    expect(snapshot.timestamp).toBeInstanceOf(Date);
  });

  test('H-04: metadata contém totalHoje, totalProximos, totalProcessados, windowDays', () => {
    expect(typeof snapshot.metadata.totalHoje).toBe('number');
    expect(typeof snapshot.metadata.totalProximos).toBe('number');
    expect(typeof snapshot.metadata.totalProcessados).toBe('number');
    expect(typeof snapshot.metadata.windowDays).toBe('number');
  });

  test('H-05: snapshot.metadata.totalHoje === snapshot.clientesHoje.length', () => {
    expect(snapshot.metadata.totalHoje).toBe(snapshot.clientesHoje.length);
  });

  test('H-06: snapshot.metadata.totalProximos === snapshot.clientesProximos.length', () => {
    expect(snapshot.metadata.totalProximos).toBe(snapshot.clientesProximos.length);
  });
});

// ── Grupo I — Escrita atômica ────────────────────────────────────────────────

describe('I — Escrita atômica em fila_comercial/snapshot', () => {
  test('I-01: exatamente uma chamada set() por execução', async () => {
    const db = makeDefaultDb();
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(db._writes).toHaveLength(1);
    expect(db._writes[0].collection).toBe('fila_comercial');
    expect(db._writes[0].doc).toBe('snapshot');
  });

  test('I-02: snapshot escrito contém todos os campos do schema', () => {
    const db = makeDefaultDb();
    return executarGeracaoFilaSnapshot({ db, dataReferencia: DR }).then(() => {
      const written = db._store['fila_comercial/snapshot'];
      expect(written).toHaveProperty('schemaVersion');
      expect(written).toHaveProperty('clientesHoje');
      expect(written).toHaveProperty('clientesProximos');
      expect(written).toHaveProperty('metadata');
      expect(written).toHaveProperty('escritoEm');
    });
  });

  test('I-03: segunda execução sobrescreve a primeira (set, não update)', async () => {
    const db = makeDefaultDb();
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    await executarGeracaoFilaSnapshot({ db, dataReferencia: DR });
    expect(db._writes).toHaveLength(2);
    expect(db._store['fila_comercial/snapshot']).toBeDefined();
  });
});

// ── Grupo J — calcularDataReferencia ────────────────────────────────────────

describe('J — calcularDataReferencia', () => {
  test('J-01: retorna string YYYY-MM-DD', () => {
    const dr = calcularDataReferencia(new Date('2026-09-21T12:00:00Z'));
    expect(dr).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  test('J-02: valor está no intervalo plausível', () => {
    const dr = calcularDataReferencia(new Date('2026-09-21T12:00:00Z'));
    expect(dr >= '2026-09-20').toBe(true);
    expect(dr <= '2026-09-21').toBe(true);
  });

  test('J-03: carregarPerfisComNomes filtra perfis sem clienteMr4Id', async () => {
    const perfilInvalido = { diasSemComprar: 30 };
    const db = makeMockDb([perfilInvalido, PERFIL_REATIVACAO], []);
    const perfis = await carregarPerfisComNomes(db);
    expect(perfis.every(p => !!p.perfil360.clienteMr4Id)).toBe(true);
    expect(perfis.length).toBe(1);
  });

  test('J-04: carregarPerfisComNomes mapeia nome correto para cada clienteMr4Id', async () => {
    const clientes = [{ id: 'MR4-SYNT-R01', nome: 'Zé da Silva' }];
    const db = makeMockDb([PERFIL_REATIVACAO], clientes);
    const perfis = await carregarPerfisComNomes(db);
    const match = perfis.find(p => p.perfil360.clienteMr4Id === 'MR4-SYNT-R01');
    expect(match?.nomeCliente).toBe('Zé da Silva');
  });

  test('J-05: carregarPerfisComNomes retorna nomeCliente=null quando cliente não está em clientes/', async () => {
    const db = makeMockDb([PERFIL_REATIVACAO], []);
    const perfis = await carregarPerfisComNomes(db);
    expect(perfis[0].nomeCliente).toBeNull();
  });
});
