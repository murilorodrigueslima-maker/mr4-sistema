'use strict';
// N34 Phase E — Testes do snapshot builder (filaComercialWriter.js)
// PURAMENTE unitários: sem Firebase, sem emulador, sem network.
//
// Garante:
//   SELLER_ASSIST_SENT_TO_FRONTEND=NO  (campos bloqueados ausentes no snapshot)
//   DATA_CAMPOSBLOCK_IN_SNAPSHOT=NO    (verificado por assertSnapshotSeguro)
//   UPSTREAM_STRIPPED_BEFORE_WRITE=YES (prepararDadosUI() chamado antes de persistir)

const { construirSnapshot, assertSnapshotSeguro, SCHEMA_VERSION } = require('../lib/filaComercialWriter');
const { CAMPOS_BLOQUEADOS, UPCOMING_WINDOW_DAYS }                  = require('../lib/filaComercialUtils');

// ── Fixtures sintéticas (sem dados reais de cliente) ──────────────────────────
// Nenhum campo contém CPF, CNPJ, telefone, nome real, ID real do Firestore ou GestãoClick.

const BRUTO_AGIR_REATIVACAO = {
  clienteMr4Id:     'SYNTH_001',
  nomeCliente:      'Cliente Sintético A',
  decisaoAcaoComercial: 'AGIR_AGORA',
  tipoOportunidade: 'REATIVACAO_120D',
  prioridade:       90,
  scoreTotal:       87.4,
  comoAbordar:      'Mencione os produtos X e Y na abertura.',
  diasSemComprar:   145,
  diasEntreComprasMediana: 28,
  diasAteProximoCiclo: null,
  tendencia:        'CAINDO',
  sellerAssist: {
    situacao: 'Sem compras há 145 dias. Ciclo habitual: 28 dias.',
    quando:   'Ação recomendada neste ciclo.',
    comoAbordar: 'Mencione os produtos X e Y.',
    sinais:   { diasSemComprar: 145, cicloMedianoDias: 28, tendencia: 'CAINDO' },
  },
  trace:    { runId: 'run-123' },
  auditoria: { usuario: 'gestor-id' },
  aiMode:   'SHADOW',
  mockMode: false,
  llmStatus: 'success',
};

const BRUTO_AGIR_JANELA = {
  clienteMr4Id:     'SYNTH_002',
  nomeCliente:      'Cliente Sintético B',
  decisaoAcaoComercial: 'AGIR_AGORA',
  tipoOportunidade: 'JANELA_DE_RECOMPRA',
  prioridade:       70,
  scoreTotal:       61.0,
  diasSemComprar:   32,
  diasEntreComprasMediana: 28,
  diasAteProximoCiclo: null,
  tendencia:        'ESTAVEL',
  sellerAssist: {
    situacao: 'Na janela de recompra. Última compra há 32 dias; ciclo: 28 dias.',
    quando:   'Ação recomendada neste ciclo.',
    sinais:   { diasSemComprar: 32, cicloMedianoDias: 28, tendencia: 'ESTAVEL' },
  },
  gc_id:      'GC_999',
  grounding:  { vendas: [] },
};

const BRUTO_PROGRAMAR_CICLO_3D = {
  clienteMr4Id:     'SYNTH_003',
  nomeCliente:      'Cliente Sintético C',
  decisaoAcaoComercial: 'PROGRAMAR_CICLO',
  tipoOportunidade: null,
  prioridade:       null,
  scoreTotal:       null,
  diasSemComprar:   25,
  diasEntreComprasMediana: 28,
  diasAteProximoCiclo: 3,
  tendencia:        'SUBINDO',
  sellerAssist: {
    situacao: 'Dentro do ciclo habitual.',
    quando:   'Próximo ciclo em 3 dias.',
    sinais:   null,
  },
};

const BRUTO_PROGRAMAR_CICLO_HOJE = {
  clienteMr4Id:     'SYNTH_004',
  nomeCliente:      'Cliente Sintético D',
  decisaoAcaoComercial: 'PROGRAMAR_CICLO',
  tipoOportunidade: null,
  prioridade:       null,
  diasSemComprar:   28,
  diasEntreComprasMediana: 28,
  diasAteProximoCiclo: 0,
  tendencia:        'ESTAVEL',
  sellerAssist: {
    situacao: 'Ciclo de recompra hoje.',
    quando:   'Próximo ciclo hoje.',
    sinais:   null,
  },
};

const BRUTO_PROGRAMAR_FORA_JANELA = {
  clienteMr4Id:     'SYNTH_005',
  nomeCliente:      'Cliente Sintético E',
  decisaoAcaoComercial: 'PROGRAMAR_CICLO',
  tipoOportunidade: null,
  prioridade:       null,
  diasSemComprar:   10,
  diasEntreComprasMediana: 20,
  diasAteProximoCiclo: 10,   // > 7 → excluído de PRÓXIMOS
  tendencia:        'ESTAVEL',
  sellerAssist: null,
};

const BRUTO_NAO_AGIR = {
  clienteMr4Id:     'SYNTH_006',
  nomeCliente:      'Cliente Sintético F',
  decisaoAcaoComercial: 'NAO_AGIR',
  tipoOportunidade: null,
  prioridade:       null,
  scoreTotal:       10.0,
  diasSemComprar:   5,
  diasEntreComprasMediana: 28,
  diasAteProximoCiclo: null,
  tendencia:        null,
  sellerAssist: null,
};

const BRUTO_PROSPECT = {
  clienteMr4Id:     'SYNTH_007',
  nomeCliente:      'Prospect Sintético G',
  decisaoAcaoComercial: 'AGIR_AGORA',
  tipoOportunidade: 'PROSPECT_VINCULADO',
  prioridade:       50,
  scoreTotal:       55.0,
  diasSemComprar:   null,
  diasEntreComprasMediana: null,
  diasAteProximoCiclo: null,
  tendencia:        null,
  sellerAssist: null,
};

const TODOS_CLIENTES = [
  BRUTO_AGIR_REATIVACAO,
  BRUTO_AGIR_JANELA,
  BRUTO_PROGRAMAR_CICLO_3D,
  BRUTO_PROGRAMAR_CICLO_HOJE,
  BRUTO_PROGRAMAR_FORA_JANELA,
  BRUTO_NAO_AGIR,
  BRUTO_PROSPECT,
];

// ── Seção A: Estrutura do snapshot ────────────────────────────────────────────
describe('A — Estrutura do snapshot', () => {
  let snap;
  beforeAll(() => {
    snap = construirSnapshot(TODOS_CLIENTES);
  });

  test('A-01: construirSnapshot retorna objeto com clientesHoje, clientesProximos, metadata', () => {
    expect(snap).toHaveProperty('clientesHoje');
    expect(snap).toHaveProperty('clientesProximos');
    expect(snap).toHaveProperty('metadata');
  });

  test('A-02: schemaVersion é SCHEMA_VERSION exportado', () => {
    expect(snap.schemaVersion).toBe(SCHEMA_VERSION);
  });

  test('A-03: metadata.totalHoje bate com clientesHoje.length', () => {
    expect(snap.metadata.totalHoje).toBe(snap.clientesHoje.length);
  });

  test('A-04: metadata.totalProximos bate com clientesProximos.length', () => {
    expect(snap.metadata.totalProximos).toBe(snap.clientesProximos.length);
  });

  test('A-05: metadata.windowDays é UPCOMING_WINDOW_DAYS por padrão', () => {
    expect(snap.metadata.windowDays).toBe(UPCOMING_WINDOW_DAYS);
  });

  test('A-06: timestamp é instância de Date quando não informado', () => {
    expect(snap.timestamp).toBeInstanceOf(Date);
  });

  test('A-07: timestamp customizado é respeitado', () => {
    const t = new Date('2026-09-20T03:00:00Z');
    const s = construirSnapshot([], { timestamp: t });
    expect(s.timestamp).toBe(t);
  });

  test('A-08: pipelineVersion null por padrão', () => {
    expect(snap.pipelineVersion).toBeNull();
  });

  test('A-09: pipelineVersion customizado é passado para snapshot', () => {
    const s = construirSnapshot([], { pipelineVersion: 'N33.6' });
    expect(s.pipelineVersion).toBe('N33.6');
  });
});

// ── Seção B: Filtragem — HOJE e PRÓXIMOS ─────────────────────────────────────
describe('B — Filtragem', () => {
  let snap;
  beforeAll(() => {
    snap = construirSnapshot(TODOS_CLIENTES);
  });

  test('B-01: clientesHoje inclui AGIR_AGORA + tipos V1 (REATIVACAO + JANELA)', () => {
    const nomes = snap.clientesHoje.map(c => c.nomeCliente);
    expect(nomes).toContain('Cliente Sintético A'); // REATIVACAO_120D
    expect(nomes).toContain('Cliente Sintético B'); // JANELA_DE_RECOMPRA
  });

  test('B-02: NAO_AGIR não aparece em nenhuma seção', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    expect(todos.find(c => c.decisaoAcaoComercial === 'NAO_AGIR')).toBeUndefined();
  });

  test('B-03: PROSPECT_VINCULADO não aparece em clientesHoje', () => {
    expect(snap.clientesHoje.find(c => c.nomeCliente === 'Prospect Sintético G')).toBeUndefined();
  });

  test('B-04: PROGRAMAR_CICLO ≤ 7d aparece em clientesProximos', () => {
    const nomes = snap.clientesProximos.map(c => c.nomeCliente);
    expect(nomes).toContain('Cliente Sintético C'); // diasAte=3
    expect(nomes).toContain('Cliente Sintético D'); // diasAte=0
  });

  test('B-05: PROGRAMAR_CICLO > 7d NÃO aparece em clientesProximos', () => {
    const nomes = snap.clientesProximos.map(c => c.nomeCliente);
    expect(nomes).not.toContain('Cliente Sintético E'); // diasAte=10
  });

  test('B-06: clientesProximos ordenados por diasAteProximoCiclo ASC (Hoje=0 antes de 3)', () => {
    const dias = snap.clientesProximos.map(c => c.diasAteProximoCiclo);
    expect(dias[0]).toBe(0);
    expect(dias[1]).toBe(3);
  });

  test('B-07: clientesHoje ordenados por prioridade DESC (prioridade 90 antes de 70)', () => {
    const priorid = snap.clientesHoje[0];
    expect(priorid.nomeCliente).toBe('Cliente Sintético A'); // prioridade 90
  });
});

// ── Seção C: Segurança — CAMPOS_BLOQUEADOS ausentes no snapshot ───────────────
describe('C — Segurança: CAMPOS_BLOQUEADOS ausentes', () => {
  let snap;
  beforeAll(() => {
    snap = construirSnapshot(TODOS_CLIENTES);
  });

  test('C-01: assertSnapshotSeguro não lança para snapshot válido', () => {
    expect(() => assertSnapshotSeguro(snap)).not.toThrow();
  });

  test('C-02: nenhum item de clientesHoje contém campo comoAbordar', () => {
    snap.clientesHoje.forEach(c => {
      expect(c).not.toHaveProperty('comoAbordar');
      expect(verificarCamposBloqueadosLocal(c, 'comoAbordar')).toBe(false);
    });
  });

  test('C-03: nenhum item contém scoreTotal', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => expect(c).not.toHaveProperty('scoreTotal'));
  });

  test('C-04: nenhum item contém prioridade', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => expect(c).not.toHaveProperty('prioridade'));
  });

  test('C-05: nenhum item contém clienteMr4Id', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => expect(c).not.toHaveProperty('clienteMr4Id'));
  });

  test('C-06: nenhum item contém gc_id', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => expect(c).not.toHaveProperty('gc_id'));
  });

  test('C-07: nenhum item contém trace ou auditoria', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => {
      expect(c).not.toHaveProperty('trace');
      expect(c).not.toHaveProperty('auditoria');
    });
  });

  test('C-08: nenhum item contém aiMode, mockMode ou llmStatus', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => {
      expect(c).not.toHaveProperty('aiMode');
      expect(c).not.toHaveProperty('mockMode');
      expect(c).not.toHaveProperty('llmStatus');
    });
  });

  test('C-09: nenhum item contém grounding ou llmUsed', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => {
      expect(c).not.toHaveProperty('grounding');
      expect(c).not.toHaveProperty('llmUsed');
    });
  });

  test('C-10: TODOS os campos de CAMPOS_BLOQUEADOS ausentes em todos os itens', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => {
      const bloqueados = require('../lib/filaComercialUtils').verificarCamposBloqueados(c);
      expect(bloqueados).toHaveLength(0);
    });
  });

  test('C-11: assertSnapshotSeguro lança quando snapshot contém campo bloqueado', () => {
    const snapCorrupto = { ...snap, clientesHoje: [{ comoAbordar: 'texto secreto' }] };
    expect(() => assertSnapshotSeguro(snapCorrupto)).toThrow('SECURITY VIOLATION');
  });
});

// ── Seção D: VIEW MODEL fields presentes ──────────────────────────────────────
describe('D — Campos do VIEW MODEL presentes', () => {
  let snap;
  beforeAll(() => {
    snap = construirSnapshot(TODOS_CLIENTES);
  });

  test('D-01: cada item de clientesHoje tem nomeCliente', () => {
    snap.clientesHoje.forEach(c => expect(c.nomeCliente).toBeTruthy());
  });

  test('D-02: item AGIR_AGORA tem tipoOportunidade', () => {
    const a = snap.clientesHoje.find(c => c.nomeCliente === 'Cliente Sintético A');
    expect(a.tipoOportunidade).toBe('REATIVACAO_120D');
  });

  test('D-03: item AGIR_AGORA tem labelOp (seller-facing)', () => {
    const a = snap.clientesHoje.find(c => c.nomeCliente === 'Cliente Sintético A');
    expect(a.labelOp).toBe('Retomar contato');
  });

  test('D-04: item tem situacao (de sellerAssist.situacao)', () => {
    const a = snap.clientesHoje.find(c => c.nomeCliente === 'Cliente Sintético A');
    expect(a.situacao).toBeTruthy();
  });

  test('D-05: item tem quando (de sellerAssist.quando)', () => {
    const a = snap.clientesHoje.find(c => c.nomeCliente === 'Cliente Sintético A');
    expect(a.quando).toBeTruthy();
  });

  test('D-06: sinaisVisiveis tem máx 3 entradas', () => {
    const todos = [...snap.clientesHoje, ...snap.clientesProximos];
    todos.forEach(c => {
      expect(Array.isArray(c.sinaisVisiveis)).toBe(true);
      expect(c.sinaisVisiveis.length).toBeLessThanOrEqual(3);
    });
  });

  test('D-07: diasAteProximoCiclo presente em PROGRAMAR_CICLO', () => {
    const c = snap.clientesProximos.find(c => c.nomeCliente === 'Cliente Sintético D');
    expect(c.diasAteProximoCiclo).toBe(0);
  });
});

// ── Seção E: Robustez ─────────────────────────────────────────────────────────
describe('E — Robustez e null safety', () => {
  test('E-01: array vazio → snapshot com clientesHoje=[] e clientesProximos=[]', () => {
    const s = construirSnapshot([]);
    expect(s.clientesHoje).toHaveLength(0);
    expect(s.clientesProximos).toHaveLength(0);
  });

  test('E-02: construirSnapshot lança TypeError para input não-array', () => {
    expect(() => construirSnapshot(null)).toThrow(TypeError);
    expect(() => construirSnapshot('texto')).toThrow(TypeError);
    expect(() => construirSnapshot(42)).toThrow(TypeError);
  });

  test('E-03: windowDays customizado = 3 exclui diasAte=7 de PRÓXIMOS', () => {
    const brutos = [
      { ...BRUTO_PROGRAMAR_CICLO_3D, diasAteProximoCiclo: 7 },
    ];
    const s = construirSnapshot(brutos, { windowDays: 3 });
    expect(s.clientesProximos).toHaveLength(0);
  });

  test('E-04: windowDays customizado = 3 inclui diasAte=3', () => {
    const brutos = [BRUTO_PROGRAMAR_CICLO_3D]; // diasAte=3
    const s = construirSnapshot(brutos, { windowDays: 3 });
    expect(s.clientesProximos).toHaveLength(1);
  });

  test('E-05: metadata.totalProcessados conta todos os brutos incluindo excluídos', () => {
    const s = construirSnapshot(TODOS_CLIENTES);
    expect(s.metadata.totalProcessados).toBe(TODOS_CLIENTES.length);
  });

  test('E-06: SELLER_ASSIST_SENT_TO_FRONTEND=NO verificado via assertSnapshotSeguro', () => {
    // O snapshot NÃO deve conter comoAbordar mesmo quando presente no bruto
    const snap = construirSnapshot([BRUTO_AGIR_REATIVACAO]);
    expect(() => assertSnapshotSeguro(snap)).not.toThrow();
    expect(snap.clientesHoje[0]).not.toHaveProperty('comoAbordar');
  });
});

// ── Helper local ──────────────────────────────────────────────────────────────
function verificarCamposBloqueadosLocal(obj, campo) {
  if (!obj || typeof obj !== 'object') return false;
  if (campo in obj) return true;
  return Object.values(obj).some(v =>
    v && typeof v === 'object' ? verificarCamposBloqueadosLocal(v, campo) : false
  );
}
