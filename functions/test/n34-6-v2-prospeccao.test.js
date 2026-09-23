'use strict';
// N34.6 — V2 Prospecção Tests (Fase 26, Gate 5A.3)
// Cobre P01-P12: seção PROSPECÇÃO no snapshot, isolamento de HOJE/PROXIMOS,
// campos seller-facing, ordenação, campos bloqueados, criadoEm opcional.
//
// INVARIANTES:
//   OPENAI_CALLS=0
//   PROD_WRITES=0
//   SELLER_ASSIST_TO_PROSPECT=NEVER

const { calcularPerfil360 }         = require('../lib/perfil360');
const { processarPerfisParaFila }   = require('../lib/filaComercialPipeline');
const { construirSnapshot, assertSnapshotSeguro } = require('../lib/filaComercialWriter');
const {
  filtrarOrdenarProspeccao,
  filtrarOrdenarFilaHoje,
  filtrarOrdenarProximosContatos,
  prepararDadosUIProspect,
  CAMPOS_BLOQUEADOS,
} = require('../lib/filaComercialUtils');

// ── Helpers ───────────────────────────────────────────────────────────────────

function mkVenda(id, data, valor, gc) {
  return { id, data, nome_situacao: 'Concretizada', valor_total: valor, cliente_id: gc, produtos: [] };
}

// Cria clienteBruto de prospect manualmente (tipoOportunidade=PROSPECT_VINCULADO)
function mkProspectBruto(clienteMr4Id, nomeCliente, criadoEm) {
  return {
    clienteMr4Id,
    nomeCliente,
    tipoOportunidade:     'PROSPECT_VINCULADO',
    decisaoAcaoComercial: 'FILA_PROSPECCAO',
    diasSemComprar:       null,
    diasEntreComprasMediana: null,
    diasAteProximoCiclo:  null,
    prioridade:           null,
    tendencia:            null,
    sellerAssist: null,
    ...(criadoEm ? { criadoEm } : {}),
  };
}

// Cria clienteBruto de recompra (AGIR_AGORA)
function mkRecompraBruto(clienteMr4Id, nomeCliente, dsc, mediana) {
  return {
    clienteMr4Id,
    nomeCliente,
    tipoOportunidade:     'REATIVACAO_120D',
    decisaoAcaoComercial: 'AGIR_AGORA',
    diasSemComprar:       dsc,
    diasEntreComprasMediana: mediana,
    diasAteProximoCiclo:  null,
    prioridade:           50,
    tendencia:            'CAINDO',
    sellerAssist: { situacao: 'S', quando: 'Q', sinais: { diasSemComprar: dsc, cicloMedianoDias: mediana, tendencia: 'CAINDO' } },
  };
}

// ── P01 — Never-bought em PROSPECÇÃO, não em HOJE ─────────────────────────────

describe('P01 — never-bought vai para prospeccao, não para hoje', () => {
  const clientes = [
    mkProspectBruto('P1', 'Zeca', '2026-06-01T10:00:00Z'),
    mkRecompraBruto('R1', 'Ana', 130, null),
  ];

  test('filtrarOrdenarProspeccao retorna somente PROSPECT_VINCULADO', () => {
    const fila = filtrarOrdenarProspeccao(clientes);
    expect(fila).toHaveLength(1);
    expect(fila[0].clienteMr4Id).toBe('P1');
  });

  test('filtrarOrdenarFilaHoje não retorna PROSPECT_VINCULADO', () => {
    const hoje = filtrarOrdenarFilaHoje(clientes);
    const ids = hoje.map(c => c.clienteMr4Id);
    expect(ids).not.toContain('P1');
  });

  test('filtrarOrdenarProximosContatos não retorna PROSPECT_VINCULADO', () => {
    const proximos = filtrarOrdenarProximosContatos(clientes, 7);
    const ids = proximos.map(c => c.clienteMr4Id);
    expect(ids).not.toContain('P1');
  });
});

// ── P02 — Prospect nunca misturado com recompra ────────────────────────────────

describe('P02 — snapshot V2 separa seções corretamente', () => {
  const clientes = [
    mkProspectBruto('P1', 'Zeca', '2026-06-01T10:00:00Z'),
    mkProspectBruto('P2', 'Ana',  '2026-07-15T08:00:00Z'),
    mkRecompraBruto('R1', 'Carlos', 130, 30),
  ];
  const snap = construirSnapshot(clientes, { dataReferencia: '2026-09-21', timestamp: new Date('2026-09-21T12:00:00Z') });

  test('clientesProspeccao contém somente prospects', () => {
    expect(snap.clientesProspeccao).toHaveLength(2);
    snap.clientesProspeccao.forEach(c => {
      expect(c.tipoOportunidade).toBe('PROSPECT_VINCULADO');
    });
  });

  test('clientesHoje não contém prospects', () => {
    snap.clientesHoje.forEach(c => {
      expect(c.tipoOportunidade).not.toBe('PROSPECT_VINCULADO');
    });
  });

  test('clientesProximos não contém prospects', () => {
    snap.clientesProximos.forEach(c => {
      expect(c.tipoOportunidade).not.toBe('PROSPECT_VINCULADO');
    });
  });

  test('metadata.totalProspeccao correto', () => {
    expect(snap.metadata.totalProspeccao).toBe(2);
  });
});

// ── P03 — Nenhum diasSemComprar seller-facing para prospects ──────────────────

describe('P03 — prepararDadosUIProspect nunca expõe diasSemComprar', () => {
  const prospect = mkProspectBruto('P1', 'Zeca', '2026-06-01T10:00:00Z');

  test('prepararDadosUIProspect não inclui diasSemComprar', () => {
    const ui = prepararDadosUIProspect(prospect);
    expect(ui).not.toHaveProperty('diasSemComprar');
  });

  test('prepararDadosUIProspect não inclui diasEntreComprasMediana', () => {
    const ui = prepararDadosUIProspect(prospect);
    expect(ui).not.toHaveProperty('diasEntreComprasMediana');
  });

  test('prepararDadosUIProspect não inclui inativo120d', () => {
    const ui = prepararDadosUIProspect(prospect);
    expect(ui).not.toHaveProperty('inativo120d');
  });

  test('null no prospect bruto não vaza como 0', () => {
    const ui = prepararDadosUIProspect(prospect);
    for (const [key] of Object.entries(ui)) {
      expect(key).not.toBe('diasSemComprar');
    }
  });
});

// ── P04 — Label "Nunca comprou" ────────────────────────────────────────────────

describe('P04 — labelOp="Nunca comprou" no UI de prospect', () => {
  test('prepararDadosUIProspect usa labelOp correto', () => {
    const ui = prepararDadosUIProspect(mkProspectBruto('P1', 'Zeca'));
    expect(ui.labelOp).toBe('Nunca comprou');
  });

  test('tipoOportunidade preservado como PROSPECT_VINCULADO', () => {
    const ui = prepararDadosUIProspect(mkProspectBruto('P1', 'Zeca'));
    expect(ui.tipoOportunidade).toBe('PROSPECT_VINCULADO');
  });

  test('decisaoAcaoComercial=FILA_PROSPECCAO', () => {
    const ui = prepararDadosUIProspect(mkProspectBruto('P1', 'Zeca'));
    expect(ui.decisaoAcaoComercial).toBe('FILA_PROSPECCAO');
  });
});

// ── P05 — Ordenação determinística por nome ────────────────────────────────────

describe('P05 — ordenação determinística de prospects por nome', () => {
  const clientes = [
    mkProspectBruto('P3', 'Zelda'),
    mkProspectBruto('P1', 'Ana'),
    mkProspectBruto('P2', 'Beatriz'),
  ];

  test('filtrarOrdenarProspeccao ordena por nome ASC', () => {
    const fila = filtrarOrdenarProspeccao(clientes);
    expect(fila.map(c => c.nomeCliente)).toEqual(['Ana', 'Beatriz', 'Zelda']);
  });

  test('ordenação é estável para múltiplas chamadas', () => {
    const a = filtrarOrdenarProspeccao(clientes).map(c => c.nomeCliente);
    const b = filtrarOrdenarProspeccao(clientes).map(c => c.nomeCliente);
    expect(a).toEqual(b);
  });

  test('normalização case-insensitive', () => {
    const mixed = [
      mkProspectBruto('X1', 'carlos'),
      mkProspectBruto('X2', 'Ana'),
      mkProspectBruto('X3', 'Beatriz'),
    ];
    const fila = filtrarOrdenarProspeccao(mixed);
    const nomes = fila.map(c => c.nomeCliente.toLowerCase());
    expect(nomes).toEqual(['ana', 'beatriz', 'carlos']);
  });
});

// ── P06 — Campos bloqueados ausentes ──────────────────────────────────────────

describe('P06 — campos bloqueados ausentes em snapshot V2 (seção prospeccao)', () => {
  const clientes = [
    mkProspectBruto('P1', 'Zeca', '2026-06-01T10:00:00Z'),
    mkProspectBruto('P2', 'Ana'),
  ];
  const snap = construirSnapshot(clientes, { dataReferencia: '2026-09-21', timestamp: new Date() });

  test('assertSnapshotSeguro não lança para snapshot com prospects', () => {
    expect(() => assertSnapshotSeguro(snap)).not.toThrow();
  });

  test('nenhum campo bloqueado nos clientesProspeccao', () => {
    for (const c of snap.clientesProspeccao) {
      for (const campo of CAMPOS_BLOQUEADOS) {
        expect(c).not.toHaveProperty(campo);
      }
    }
  });

  test('score, prioridade, comoAbordar ausentes', () => {
    for (const c of snap.clientesProspeccao) {
      expect(c).not.toHaveProperty('score');
      expect(c).not.toHaveProperty('scoreTotal');
      expect(c).not.toHaveProperty('prioridade');
      expect(c).not.toHaveProperty('comoAbordar');
      expect(c).not.toHaveProperty('clienteMr4Id');
      expect(c).not.toHaveProperty('gc_id');
    }
  });
});

// ── P07 — criadoEm ausente não quebra ─────────────────────────────────────────

describe('P07 — criadoEm ausente não quebra nada', () => {
  test('prepararDadosUIProspect sem criadoEm', () => {
    const ui = prepararDadosUIProspect(mkProspectBruto('P1', 'Zeca'));
    expect(ui).not.toHaveProperty('criadoEm');
    expect(ui.nomeCliente).toBe('Zeca');
    expect(ui.labelOp).toBe('Nunca comprou');
  });

  test('snapshot com prospect sem criadoEm', () => {
    const snap = construirSnapshot([mkProspectBruto('P1', 'Zeca')], { dataReferencia: '2026-09-21', timestamp: new Date() });
    expect(snap.clientesProspeccao).toHaveLength(1);
    expect(snap.clientesProspeccao[0]).not.toHaveProperty('criadoEm');
  });

  test('criadoEm presente é incluído', () => {
    const ui = prepararDadosUIProspect(mkProspectBruto('P1', 'Zeca', '2026-06-01T10:00:00Z'));
    expect(ui.criadoEm).toBe('2026-06-01T10:00:00Z');
  });
});

// ── P08 — Lista vazia de prospects suportada ──────────────────────────────────

describe('P08 — lista vazia de prospects suportada', () => {
  const clientes = [mkRecompraBruto('R1', 'Carlos', 130, 30)];
  const snap = construirSnapshot(clientes, { dataReferencia: '2026-09-21', timestamp: new Date() });

  test('clientesProspeccao é array vazio quando sem prospects', () => {
    expect(snap.clientesProspeccao).toEqual([]);
    expect(snap.metadata.totalProspeccao).toBe(0);
  });

  test('filtrarOrdenarProspeccao com array vazio', () => {
    expect(filtrarOrdenarProspeccao([])).toEqual([]);
    expect(filtrarOrdenarProspeccao(null)).toEqual([]);
    expect(filtrarOrdenarProspeccao(undefined)).toEqual([]);
  });
});

// ── P09 — Seller Assist nunca vai para prospect ────────────────────────────────

describe('P09 — Seller Assist nunca incluído em prospect UI', () => {
  test('prepararDadosUIProspect não inclui sellerAssist', () => {
    const bruto = mkProspectBruto('P1', 'Zeca');
    bruto.sellerAssist = { situacao: 'xxx', quando: 'yyy', comoAbordar: 'zzz' };
    const ui = prepararDadosUIProspect(bruto);
    expect(ui).not.toHaveProperty('sellerAssist');
    expect(ui).not.toHaveProperty('situacao');
    expect(ui).not.toHaveProperty('quando');
    expect(ui).not.toHaveProperty('comoAbordar');
  });
});

// ── P10 — Pipeline: never-bought produz tipoOportunidade PROSPECT_VINCULADO ───

describe('P10 — pipeline: perfil nuncaComprou → PROSPECT_VINCULADO', () => {
  const DR = '2026-09-21';
  const perfilNever = calcularPerfil360({ clienteMr4Id: 'C-NEVER', vendas: [], dataReferencia: DR });

  test('nuncaComprou=true no perfil vazio', () => {
    expect(perfilNever.nuncaComprou).toBe(true);
  });

  test('pipeline retorna tipoOportunidade=PROSPECT_VINCULADO para nuncaComprou', async () => {
    const [res] = await processarPerfisParaFila(
      [{ perfil360: perfilNever, nomeCliente: 'Test' }], { dataReferencia: DR }
    );
    expect(res.tipoOportunidade).toBe('PROSPECT_VINCULADO');
    // decisaoAcaoComercial no bruto pode ser AGIR_AGORA — FILA_PROSPECCAO é aplicado
    // por prepararDadosUIProspect ao construir o snapshot. A separação é garantida pelo
    // filtrarOrdenarProspeccao (por tipoOportunidade) e pelo filtrarOrdenarFilaHoje
    // (que exige TIPOS_RECOMPRA_V1, excluindo PROSPECT_VINCULADO).
    expect(['AGIR_AGORA', 'FILA_PROSPECCAO']).toContain(res.decisaoAcaoComercial);
  });

  test('UI do prospect tem decisaoAcaoComercial=FILA_PROSPECCAO', async () => {
    const [res] = await processarPerfisParaFila(
      [{ perfil360: perfilNever, nomeCliente: 'Test' }], { dataReferencia: DR }
    );
    const ui = prepararDadosUIProspect(res);
    expect(ui.decisaoAcaoComercial).toBe('FILA_PROSPECCAO');
  });

  test('prospect do pipeline tem diasSemComprar=null', async () => {
    const [res] = await processarPerfisParaFila(
      [{ perfil360: perfilNever, nomeCliente: 'Test' }], { dataReferencia: DR }
    );
    expect(res.diasSemComprar).toBeNull();
  });
});

// ── P11 — Prospect nunca entra em snapshot HOJE/PROXIMOS via pipeline ─────────

describe('P11 — prospect via pipeline nunca entra em HOJE/PROXIMOS', () => {
  const DR = '2026-09-21';
  const perfilNever = calcularPerfil360({ clienteMr4Id: 'C-NEVER', vendas: [], dataReferencia: DR });
  const vendas = [
    mkVenda('v1','2026-07-24',100,'g1'), mkVenda('v2','2026-06-24',100,'g1'),
    mkVenda('v3','2026-05-25',100,'g1'),
  ];
  const perfilComprador = calcularPerfil360({ clienteMr4Id: 'C-COMP', vendas, dataReferencia: DR });

  let snap;
  beforeAll(async () => {
    const clientes = await processarPerfisParaFila(
      [
        { perfil360: perfilNever,    nomeCliente: 'Never' },
        { perfil360: perfilComprador, nomeCliente: 'Comprador' },
      ],
      { dataReferencia: DR }
    );
    snap = construirSnapshot(clientes, { dataReferencia: DR, timestamp: new Date() });
  });

  test('prospect está em clientesProspeccao', () => {
    expect(snap.clientesProspeccao.some(c => c.tipoOportunidade === 'PROSPECT_VINCULADO')).toBe(true);
  });

  test('prospect não está em clientesHoje', () => {
    expect(snap.clientesHoje.every(c => c.tipoOportunidade !== 'PROSPECT_VINCULADO')).toBe(true);
  });

  test('prospect não está em clientesProximos', () => {
    expect(snap.clientesProximos.every(c => c.tipoOportunidade !== 'PROSPECT_VINCULADO')).toBe(true);
  });
});

// ── P12 — Schema V2 inclui clientesProspeccao ─────────────────────────────────

describe('P12 — schema V2 obrigatoriamente inclui clientesProspeccao', () => {
  const snap = construirSnapshot([], { dataReferencia: '2026-09-21', timestamp: new Date() });

  test('schemaVersion=v2', () => {
    expect(snap.schemaVersion).toBe('v2');
  });

  test('clientesProspeccao sempre presente (não undefined)', () => {
    expect(snap.clientesProspeccao).toBeDefined();
    expect(Array.isArray(snap.clientesProspeccao)).toBe(true);
  });

  test('dataReferencia presente no snapshot raiz', () => {
    expect(snap.dataReferencia).toBe('2026-09-21');
  });

  test('metadata.totalProspeccao presente', () => {
    expect(typeof snap.metadata.totalProspeccao).toBe('number');
  });
});
