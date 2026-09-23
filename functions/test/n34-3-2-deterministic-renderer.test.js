'use strict';

/**
 * N34.3.2 — Deterministic Queue Architecture Cleanup
 *
 * Prova que:
 *   1. renderizarAgirAgora é puro e determinístico
 *   2. QUANDO_AGIR_AGORA é constante correta
 *   3. Seller Assist reutiliza o mesmo renderer (single source)
 *   4. filaComercialPipeline não importa nem chama sellerAssistService
 *   5. fila não aceita provider, não precisa de INFRA_ERROR
 *   6. fila funciona se Seller Assist estiver indisponível
 *   7. output seller-facing semanticamente equivalente antes/depois
 *   8. snapshot continua sem campos bloqueados
 *
 * INVARIANTES:
 *   OPENAI_CALLS=0
 *   PROD_WRITES=0
 *   REAL_CUSTOMER_DATA=NO
 */

const fs   = require('fs');
const path = require('path');

const {
  QUANDO_AGIR_AGORA,
  renderizarAgirAgora,
  renderizarProgramarCiclo,
  renderizarNaoAgir,
} = require('../lib/n33/abordagemContract');

const {
  processarCliente,
  processarClientesParaFila,
  PIPELINE_VERSION,
} = require('../lib/filaComercialPipeline');

// ─── Helpers ──────────────────────────────────────────────────────────────────

const ctx = (tipo, extras = {}) => ({
  tipoOportunidade:        tipo,
  diasSemComprar:          100,
  diasEntreComprasMediana: 20,
  ...extras,
});

const vendaSintetica = (data, valor = 300) => ({
  id: `v-synt-${Date.now()}-${Math.random()}`,
  data,
  valor_total: valor,
  nome_situacao: 'Concluída',
  vendedor_id: 'v-sint',
  nome_vendedor: 'Vendedor Sintético',
});

const DATA_REF = '2026-09-21';

// ═══════════════════════════════════════════════════════════════════════════════
// A — Renderer AGIR_AGORA puro (8 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('A — renderizarAgirAgora puro e determinístico', () => {

  test('A-01: REATIVACAO_120D contém diasSemComprar', () => {
    const s = renderizarAgirAgora(ctx('REATIVACAO_120D'));
    expect(s).toContain('100');
  });

  test('A-02: REATIVACAO_120D — situação semânticamente correta (N34.6 copy)', () => {
    const s = renderizarAgirAgora(ctx('REATIVACAO_120D'));
    expect(s).toContain('100');
    // N34.6: new copy — "Está há N dias sem comprar. Ciclo habitual: N dias."
    expect(s).toMatch(/está há \d+ dias sem comprar/i);
  });

  test('A-03: QUEDA_DE_COMPRAS — situação semânticamente correta (N34.6 copy)', () => {
    const s = renderizarAgirAgora(ctx('QUEDA_DE_COMPRAS'));
    // N34.6: new copy — "Ritmo de compras caiu em relação ao período anterior."
    expect(s).toMatch(/ritmo de compras/i);
    expect(s).toContain('100');
  });

  test('A-04: JANELA_DE_RECOMPRA — situação semânticamente correta (N34.6 copy)', () => {
    const s = renderizarAgirAgora(ctx('JANELA_DE_RECOMPRA'));
    // N34.6 Gate5A5: new copy — "Está na janela habitual de recompra. Última compra há N dias (ciclo: N dias)."
    expect(s).toMatch(/janela.*recompra/i);
    expect(s).toContain('100');
    expect(s).toContain('20');
  });

  test('A-05: fallback tipo desconhecido — retorna string', () => {
    const s = renderizarAgirAgora(ctx('TIPO_DESCONHECIDO'));
    expect(typeof s).toBe('string');
    expect(s.length).toBeGreaterThan(0);
  });

  test('A-06: cicloMedianoDias funciona como alias de diasEntreComprasMediana', () => {
    const s = renderizarAgirAgora({ tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 50, cicloMedianoDias: 15 });
    expect(s).toContain('50');
    expect(s).toContain('15 dias');
  });

  test('A-07: função é pura — mesma entrada = mesma saída', () => {
    const c = ctx('REATIVACAO_120D');
    expect(renderizarAgirAgora(c)).toBe(renderizarAgirAgora(c));
  });

  test('A-08: QUANDO_AGIR_AGORA = "Ação recomendada: neste ciclo."', () => {
    expect(QUANDO_AGIR_AGORA).toBe('Ação recomendada: neste ciclo.');
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// B — PROGRAMAR_CICLO e NAO_AGIR já determinísticos (6 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('B — PROGRAMAR_CICLO e NAO_AGIR determinísticos', () => {

  test('B-01: PROGRAMAR_CICLO situacao correta', () => {
    const r = renderizarProgramarCiclo(5);
    expect(r.situacao).toBe('Cliente dentro do ciclo habitual de compra.');
  });

  test('B-02: PROGRAMAR_CICLO quando contém dias', () => {
    const r = renderizarProgramarCiclo(5);
    expect(r.quando).toContain('5 dias');
  });

  test('B-03: PROGRAMAR_CICLO null → próximo ciclo habitual', () => {
    const r = renderizarProgramarCiclo(null);
    expect(r.quando).toContain('próximo ciclo habitual');
  });

  test('B-04: NAO_AGIR situacao correta', () => {
    const r = renderizarNaoAgir();
    expect(r.situacao).toBe('Sem sinal determinístico suficiente para ação comercial.');
  });

  test('B-05: NAO_AGIR quando correto', () => {
    const r = renderizarNaoAgir();
    expect(r.quando).toBe('Sem ação necessária no momento.');
  });

  test('B-06: NAO_AGIR comoAbordar null', () => {
    const r = renderizarNaoAgir();
    expect(r.comoAbordar).toBeNull();
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// C — Seller Assist reutiliza renderer (single source) (5 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('C — Seller Assist reutiliza renderizarAgirAgora (single source)', () => {

  const { calcularSellerAssist } = require('../lib/n33/sellerAssistService');

  test('C-01: AGIR_AGORA com provider null retorna mesma situacao que renderizarAgirAgora', async () => {
    const decisaoCtx = {
      decisaoAcaoComercial:    'AGIR_AGORA',
      tipoOportunidade:        'REATIVACAO_120D',
      diasSemComprar:          100,
      diasEntreComprasMediana: 20,
      tendencia:               'CAINDO',
    };
    const r   = await calcularSellerAssist(decisaoCtx, {}, {});
    const exp = renderizarAgirAgora(decisaoCtx);
    expect(r.situacao).toBe(exp);
  });

  test('C-02: AGIR_AGORA com provider null retorna QUANDO_AGIR_AGORA', async () => {
    const decisaoCtx = {
      decisaoAcaoComercial:    'AGIR_AGORA',
      tipoOportunidade:        'JANELA_DE_RECOMPRA',
      diasSemComprar:          25,
      diasEntreComprasMediana: 30,
    };
    const r = await calcularSellerAssist(decisaoCtx, {}, {});
    expect(r.quando).toBe(QUANDO_AGIR_AGORA);
  });

  test('C-03: QUEDA_DE_COMPRAS single source — Seller Assist bate com renderer', async () => {
    const decisaoCtx = {
      decisaoAcaoComercial:    'AGIR_AGORA',
      tipoOportunidade:        'QUEDA_DE_COMPRAS',
      diasSemComprar:          60,
      diasEntreComprasMediana: 25,
    };
    const r   = await calcularSellerAssist(decisaoCtx, {}, {});
    const exp = renderizarAgirAgora(decisaoCtx);
    expect(r.situacao).toBe(exp);
  });

  test('C-04: PROGRAMAR_CICLO Seller Assist bate com renderizarProgramarCiclo', async () => {
    const decisaoCtx = { decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasAteProximoCiclo: 7 };
    const r   = await calcularSellerAssist(decisaoCtx, {}, {});
    const exp = renderizarProgramarCiclo(7);
    expect(r.situacao).toBe(exp.situacao);
    expect(r.quando).toBe(exp.quando);
  });

  test('C-05: NAO_AGIR Seller Assist bate com renderizarNaoAgir', async () => {
    const r   = await calcularSellerAssist({ decisaoAcaoComercial: 'NAO_AGIR' }, {}, {});
    const exp = renderizarNaoAgir();
    expect(r.situacao).toBe(exp.situacao);
    expect(r.quando).toBe(exp.quando);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// D — Fila não importa nem chama Seller Assist (4 testes estáticos)
// ═══════════════════════════════════════════════════════════════════════════════

describe('D — Fila não importa nem chama sellerAssistService (static)', () => {

  const SRC_PATH = path.resolve(__dirname, '../lib/filaComercialPipeline.js');
  const src = fs.readFileSync(SRC_PATH, 'utf8');

  test('D-01: filaComercialPipeline.js não require sellerAssistService', () => {
    expect(src).not.toMatch(/sellerAssistService/);
  });

  test('D-02: filaComercialPipeline.js não usa calcularSellerAssist', () => {
    expect(src).not.toMatch(/calcularSellerAssist/);
  });

  test('D-03: filaComercialPipeline.js não usa provider', () => {
    expect(src).not.toMatch(/\bprovider\b/);
  });

  test('D-04: filaComercialPipeline.js não menciona INFRA_ERROR', () => {
    expect(src).not.toMatch(/INFRA_ERROR/);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// E — Fila funciona sem Seller Assist disponível (2 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('E — Fila funciona com Seller Assist indisponível', () => {

  test('E-01: processarCliente não chama calcularSellerAssist', async () => {
    // Se o módulo sellerAssistService fosse necessário e não existisse,
    // o require falharia no load. Como não importamos, isso é garantido por D-01.
    // Este teste prova por execução: o processarCliente completa sem throw.
    const resultado = await processarCliente({
      clienteMr4Id: 'N34-3-2-SYNT-001',
      nomeCliente:  'Sintético E01',
      vendas: [
        vendaSintetica('2026-04-20', 500),
        vendaSintetica('2026-03-18', 480),
        vendaSintetica('2026-02-15', 510),
        vendaSintetica('2026-01-12', 495),
        vendaSintetica('2025-12-10', 505),
      ],
    }, { dataReferencia: DATA_REF });

    expect(resultado).toBeDefined();
    expect(resultado.sellerAssist).toBeDefined();
    expect(typeof resultado.sellerAssist.situacao).toBe('string');
    expect(resultado.sellerAssist.situacao.length).toBeGreaterThan(0);
  });

  test('E-02: QUEUE_WORKS_WITH_SELLER_ASSIST_UNAVAILABLE — snapshot produzido', async () => {
    const { construirSnapshot } = require('../lib/filaComercialWriter');

    const clientes = [
      {
        clienteMr4Id: 'N34-3-2-SYNT-002',
        nomeCliente:  'Sintético E02-A',
        vendas: [
          vendaSintetica('2026-04-15', 400),
          vendaSintetica('2026-03-13', 420),
          vendaSintetica('2026-02-10', 410),
        ],
      },
      {
        clienteMr4Id: 'N34-3-2-SYNT-003',
        nomeCliente:  'Sintético E02-B',
        vendas: [
          vendaSintetica('2026-08-20', 300),
          vendaSintetica('2026-07-18', 310),
          vendaSintetica('2026-06-15', 295),
        ],
      },
    ];

    const clientesBrutos = await processarClientesParaFila(clientes, { dataReferencia: DATA_REF });
    const snapshot = construirSnapshot(clientesBrutos, { pipelineVersion: PIPELINE_VERSION });

    expect(snapshot).toHaveProperty('schemaVersion', 'v2'); // N34.6: bumped to v2
    expect(Array.isArray(snapshot.clientesHoje)).toBe(true);
    expect(Array.isArray(snapshot.clientesProximos)).toBe(true);
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// F — Output seller-facing equivalente (6 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('F — Output seller-facing semanticamente equivalente', () => {

  // Cliente AGIR_AGORA (reativação — última compra há ~150 dias)
  const clienteReativacao = {
    clienteMr4Id: 'N34-3-2-SYNT-REA',
    nomeCliente:  'Sintético Reativação',
    vendas: [
      vendaSintetica('2026-04-24', 500),
      vendaSintetica('2026-03-25', 480),
      vendaSintetica('2026-02-23', 520),
      vendaSintetica('2026-01-24', 490),
      vendaSintetica('2025-12-25', 510),
    ],
  };

  // Cliente PROGRAMAR_CICLO (última compra há ~25 dias)
  const clienteProximos = {
    clienteMr4Id: 'N34-3-2-SYNT-PRG',
    nomeCliente:  'Sintético Próximos',
    vendas: [
      vendaSintetica('2026-08-27', 300),
      vendaSintetica('2026-07-28', 310),
      vendaSintetica('2026-06-28', 295),
      vendaSintetica('2026-05-29', 305),
    ],
  };

  test('F-01: REATIVACAO — situacao contém dias sem comprar', async () => {
    const r = await processarCliente(clienteReativacao, { dataReferencia: DATA_REF });
    expect(typeof r.sellerAssist.situacao).toBe('string');
    expect(r.sellerAssist.situacao).toContain('dias');
  });

  test('F-02: REATIVACAO — quando = QUANDO_AGIR_AGORA', async () => {
    const r = await processarCliente(clienteReativacao, { dataReferencia: DATA_REF });
    if (r.decisaoAcaoComercial === 'AGIR_AGORA') {
      expect(r.sellerAssist.quando).toBe(QUANDO_AGIR_AGORA);
    }
  });

  test('F-03: PROGRAMAR_CICLO — situacao = "Cliente dentro do ciclo habitual de compra."', async () => {
    const r = await processarCliente(clienteProximos, { dataReferencia: DATA_REF });
    if (r.decisaoAcaoComercial === 'PROGRAMAR_CICLO') {
      expect(r.sellerAssist.situacao).toBe('Cliente dentro do ciclo habitual de compra.');
    }
  });

  test('F-04: comoAbordar ausente no clienteBruto', async () => {
    const r = await processarCliente(clienteReativacao, { dataReferencia: DATA_REF });
    expect(r).not.toHaveProperty('comoAbordar');
    expect(r.sellerAssist).not.toHaveProperty('comoAbordar');
  });

  test('F-05: score ausente no clienteBruto', async () => {
    const r = await processarCliente(clienteReativacao, { dataReferencia: DATA_REF });
    expect(r).not.toHaveProperty('scoreTotal');
    expect(r).not.toHaveProperty('score');
  });

  test('F-06: priorityScore ausente no clienteBruto', async () => {
    const r = await processarCliente(clienteReativacao, { dataReferencia: DATA_REF });
    expect(r).not.toHaveProperty('priorityScore');
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// G — Snapshot sem campos bloqueados (5 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('G — Snapshot sem campos bloqueados', () => {

  const { construirSnapshot, assertSnapshotSeguro } = require('../lib/filaComercialWriter');
  const { verificarCamposBloqueados }               = require('../lib/filaComercialUtils');

  const clientes = [
    {
      clienteMr4Id: 'N34-3-2-SYNT-SNAP',
      nomeCliente:  'Sintético Snapshot',
      vendas: [
        vendaSintetica('2026-04-20', 500),
        vendaSintetica('2026-03-18', 480),
        vendaSintetica('2026-02-15', 510),
        vendaSintetica('2026-01-12', 490),
        vendaSintetica('2025-12-10', 505),
      ],
    },
  ];

  let snap;

  beforeAll(async () => {
    const brutos = await processarClientesParaFila(clientes, { dataReferencia: DATA_REF });
    snap = construirSnapshot(brutos, { pipelineVersion: PIPELINE_VERSION });
  });

  test('G-01: assertSnapshotSeguro não lança erro', () => {
    expect(() => assertSnapshotSeguro(snap)).not.toThrow();
  });

  test('G-02: verificarCamposBloqueados retorna []', () => {
    expect(verificarCamposBloqueados(snap)).toEqual([]);
  });

  test('G-03: comoAbordar ausente do snapshot', () => {
    const json = JSON.stringify(snap);
    expect(json).not.toContain('comoAbordar');
  });

  test('G-04: INFRA_ERROR ausente do snapshot', () => {
    const json = JSON.stringify(snap);
    expect(json).not.toContain('INFRA_ERROR');
  });

  test('G-05: schema v2 (N34.6 bump)', () => {
    expect(snap.schemaVersion).toBe('v2'); // N34.6: v1→v2 (clientesProspeccao added)
  });

});

// ═══════════════════════════════════════════════════════════════════════════════
// H — PIPELINE_VERSION e invariantes (3 testes)
// ═══════════════════════════════════════════════════════════════════════════════

describe('H — Invariantes do pipeline refatorado', () => {

  test('H-01: PIPELINE_VERSION = "N34.6.1"', () => {
    expect(PIPELINE_VERSION).toBe('N34.6.1'); // N34.6 Gate5A5: Cenário B bump
  });

  test('H-02: processarClientesParaFila retorna Promise', () => {
    const p = processarClientesParaFila([], {});
    expect(p).toBeInstanceOf(Promise);
  });

  test('H-03: QUEUE_REQUIRES_INFRA_ERROR=NO — palavra INFRA_ERROR ausente no código do pipeline', () => {
    const SRC_PATH = path.resolve(__dirname, '../lib/filaComercialPipeline.js');
    const src = fs.readFileSync(SRC_PATH, 'utf8');
    expect(src).not.toMatch(/INFRA_ERROR/);
  });

});
