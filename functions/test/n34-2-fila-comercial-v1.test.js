'use strict';
// N34.2 — Fila Comercial V1 — Suíte de testes
//
// OPENAI_CALLS=0 | PROD_WRITES=0 | DEPLOYS=0 | AI_MODE=SHADOW
// Testa lógica PURA de apresentação: filtragem, ordenação, labels, bloqueios.
// Nenhum teste chama Firebase, Firestore, OpenAI ou qualquer serviço externo.

const {
  UPCOMING_WINDOW_DAYS,
  TIPOS_RECOMPRA_V1,
  LABEL_OPORTUNIDADE,
  CAMPOS_BLOQUEADOS,
  labelOportunidade,
  corOportunidade,
  formatarDiasAteProximoCiclo,
  filtrarOrdenarFilaHoje,
  filtrarOrdenarProximosContatos,
  extrairSinaisVisiveis,
  prepararDadosUI,
  verificarCamposBloqueados,
} = require('../lib/filaComercialUtils');

// ── Fixtures ──────────────────────────────────────────────────────────────────

const AGIR_REATIVACAO = {
  clienteMr4Id: 'F_REAT', nomeCliente: 'Farmácia Central',
  decisaoAcaoComercial: 'AGIR_AGORA', tipoOportunidade: 'REATIVACAO_120D',
  prioridade: 97, diasSemComprar: 143, diasEntreComprasMediana: 30,
  diasAteProximoCiclo: null, tendencia: 'CAINDO',
  sellerAssist: {
    situacao: 'Cliente sem comprar há 143 dias (ciclo habitual: 30 dias). Reativação necessária.',
    quando: 'Ação recomendada: neste ciclo.',
    comoAbordar: 'Pergunte sobre o que mudou — [BLOQUEADO NA UI]',
    sinais: { diasSemComprar: 143, cicloMedianoDias: 30, tendencia: 'CAINDO' },
    metadata: { llmUsed: true, llmStatus: 'LLM_SUCCESS', versaoPrompt: 'v1.0' },
  },
  scoreTotal: 85, classificacao: 'A',
};

const AGIR_JANELA = {
  clienteMr4Id: 'F_JAN', nomeCliente: 'Auto Peças Vitória',
  decisaoAcaoComercial: 'AGIR_AGORA', tipoOportunidade: 'JANELA_DE_RECOMPRA',
  prioridade: 75, diasSemComprar: 36, diasEntreComprasMediana: 30,
  diasAteProximoCiclo: null, tendencia: 'ESTAVEL',
  sellerAssist: {
    situacao: 'Cliente na janela de recompra habitual. 36 dias desde a última compra.',
    quando: 'Ação recomendada: neste ciclo.',
    comoAbordar: null,
    sinais: { diasSemComprar: 36, cicloMedianoDias: 30, tendencia: 'ESTAVEL' },
    metadata: { llmUsed: false, llmStatus: 'INFRA_ERROR' },
  },
  scoreTotal: 70, classificacao: 'B',
};

const AGIR_QUEDA = {
  clienteMr4Id: 'F_QUE', nomeCliente: 'Distribuidora SP',
  decisaoAcaoComercial: 'AGIR_AGORA', tipoOportunidade: 'QUEDA_DE_COMPRAS',
  prioridade: 65, diasSemComprar: 22, diasEntreComprasMediana: 30,
  diasAteProximoCiclo: null, tendencia: 'CAINDO',
  sellerAssist: {
    situacao: 'Cliente com queda no ritmo de compras. Sem compras há 22 dias.',
    quando: 'Ação recomendada: neste ciclo.',
    comoAbordar: null,
    sinais: { diasSemComprar: 22, cicloMedianoDias: 30, tendencia: 'CAINDO' },
    metadata: { llmUsed: false, llmStatus: 'INFRA_ERROR' },
  },
  scoreTotal: 60, classificacao: 'B',
};

const PROGRAMAR_0_DIAS = {
  clienteMr4Id: 'F_P0', nomeCliente: 'Auto Sul',
  decisaoAcaoComercial: 'PROGRAMAR_CICLO', tipoOportunidade: null,
  prioridade: null, diasSemComprar: 25, diasEntreComprasMediana: 25,
  diasAteProximoCiclo: 0, tendencia: 'ESTAVEL',
  sellerAssist: {
    situacao: 'Cliente dentro do ciclo habitual. Próximo contato hoje.',
    quando: 'Próximo ciclo em 0 dias.',
    comoAbordar: null,
    sinais: null,
    metadata: { llmUsed: false, llmStatus: 'NOT_ELIGIBLE' },
  },
};

const PROGRAMAR_1_DIA = {
  clienteMr4Id: 'F_P1', nomeCliente: 'Mecânica Norte',
  decisaoAcaoComercial: 'PROGRAMAR_CICLO', tipoOportunidade: null,
  prioridade: null, diasSemComprar: 29, diasEntreComprasMediana: 30,
  diasAteProximoCiclo: 1, tendencia: 'ESTAVEL',
  sellerAssist: {
    situacao: 'Cliente dentro do ciclo habitual.',
    quando: 'Próximo ciclo em 1 dia.',
    comoAbordar: null,
    sinais: null,
    metadata: { llmUsed: false, llmStatus: 'NOT_ELIGIBLE' },
  },
};

const PROGRAMAR_7_DIAS = {
  clienteMr4Id: 'F_P7', nomeCliente: 'Peças OK',
  decisaoAcaoComercial: 'PROGRAMAR_CICLO', tipoOportunidade: null,
  prioridade: null, diasSemComprar: 23, diasEntreComprasMediana: 30,
  diasAteProximoCiclo: 7, tendencia: 'ESTAVEL',
  sellerAssist: {
    situacao: 'Cliente dentro do ciclo habitual.',
    quando: 'Próximo ciclo em 7 dias.',
    comoAbordar: null,
    sinais: null,
    metadata: { llmUsed: false, llmStatus: 'NOT_ELIGIBLE' },
  },
};

const PROGRAMAR_8_DIAS = {
  clienteMr4Id: 'F_P8', nomeCliente: 'Loja Futura',
  decisaoAcaoComercial: 'PROGRAMAR_CICLO', tipoOportunidade: null,
  prioridade: null, diasSemComprar: 22, diasEntreComprasMediana: 30,
  diasAteProximoCiclo: 8, tendencia: 'ESTAVEL',
  sellerAssist: {
    situacao: 'Cliente dentro do ciclo habitual.',
    quando: 'Próximo ciclo em 8 dias.',
    comoAbordar: null,
    sinais: null,
    metadata: { llmUsed: false, llmStatus: 'NOT_ELIGIBLE' },
  },
};

const NAO_AGIR = {
  clienteMr4Id: 'F_NA', nomeCliente: 'Sem Dados Suficientes',
  decisaoAcaoComercial: 'NAO_AGIR', tipoOportunidade: null,
  prioridade: null, diasSemComprar: null, diasEntreComprasMediana: null,
  diasAteProximoCiclo: null, tendencia: null,
  sellerAssist: {
    situacao: 'Dados insuficientes para ação.',
    quando: null,
    comoAbordar: null,
    sinais: null,
    metadata: { llmUsed: false, llmStatus: 'NOT_ELIGIBLE' },
  },
};

const PROSPECT_VINCULADO = {
  clienteMr4Id: 'F_PROS', nomeCliente: 'Novo Cliente Potencial',
  decisaoAcaoComercial: 'AGIR_AGORA', tipoOportunidade: 'PROSPECT_VINCULADO',
  prioridade: 30, diasSemComprar: null, diasEntreComprasMediana: null,
  diasAteProximoCiclo: null, tendencia: null,
  sellerAssist: {
    situacao: 'Prospecção ativa.',
    quando: 'Ação recomendada: neste ciclo.',
    comoAbordar: null,
    sinais: null,
    metadata: { llmUsed: false, llmStatus: 'FAIL_CLOSED' },
  },
};

// Fixture com prioridade alta mas diasSemComprar baixo (para testar desempate)
const AGIR_REATIVACAO_PRIO_ALTA = {
  ...AGIR_REATIVACAO,
  clienteMr4Id: 'F_REAT2', prioridade: 97, diasSemComprar: 50,
};

// Fixture nunca comprou
const NUNCA_COMPROU = {
  clienteMr4Id: 'F_NUNCA', nomeCliente: 'Prospect Puro',
  decisaoAcaoComercial: 'AGIR_AGORA', tipoOportunidade: 'REATIVACAO_120D',
  prioridade: 40, diasSemComprar: null, diasEntreComprasMediana: null,
  diasAteProximoCiclo: null, tendencia: null,
  sellerAssist: null,
};

const TODOS = [
  AGIR_REATIVACAO, AGIR_JANELA, AGIR_QUEDA,
  PROGRAMAR_0_DIAS, PROGRAMAR_1_DIA, PROGRAMAR_7_DIAS, PROGRAMAR_8_DIAS,
  NAO_AGIR, PROSPECT_VINCULADO,
];

// ── Seção A: Filtragem HOJE ───────────────────────────────────────────────────

describe('A — Filtragem fila HOJE', () => {

  test('A-01 AGIR_AGORA V1 aparece na fila HOJE', () => {
    const hoje = filtrarOrdenarFilaHoje([AGIR_REATIVACAO]);
    expect(hoje.length).toBe(1);
    expect(hoje[0].clienteMr4Id).toBe('F_REAT');
  });

  test('A-02 NAO_AGIR não aparece na fila HOJE', () => {
    const hoje = filtrarOrdenarFilaHoje([NAO_AGIR]);
    expect(hoje.length).toBe(0);
  });

  test('A-03 PROSPECT_VINCULADO não entra na fila de recompra', () => {
    const hoje = filtrarOrdenarFilaHoje([PROSPECT_VINCULADO]);
    expect(hoje.length).toBe(0);
  });

  test('A-04 PROGRAMAR_CICLO não aparece na fila HOJE', () => {
    const hoje = filtrarOrdenarFilaHoje([PROGRAMAR_0_DIAS, PROGRAMAR_7_DIAS]);
    expect(hoje.length).toBe(0);
  });

  test('A-05 lista mista: apenas os três tipos V1 entram', () => {
    const hoje = filtrarOrdenarFilaHoje(TODOS);
    const ids = hoje.map(c => c.clienteMr4Id);
    expect(ids).toContain('F_REAT');
    expect(ids).toContain('F_JAN');
    expect(ids).toContain('F_QUE');
    expect(ids).not.toContain('F_PROS');
    expect(ids).not.toContain('F_NA');
    expect(ids).not.toContain('F_P7');
  });

});

// ── Seção B: Filtragem PRÓXIMOS ───────────────────────────────────────────────

describe('B — Filtragem PRÓXIMOS CONTATOS', () => {

  test('B-01 PROGRAMAR diasAteProximoCiclo=0 aparece', () => {
    expect(filtrarOrdenarProximosContatos([PROGRAMAR_0_DIAS]).length).toBe(1);
  });

  test('B-02 PROGRAMAR diasAteProximoCiclo=1 aparece', () => {
    expect(filtrarOrdenarProximosContatos([PROGRAMAR_1_DIA]).length).toBe(1);
  });

  test('B-03 PROGRAMAR diasAteProximoCiclo=7 aparece (boundary inclusive)', () => {
    expect(filtrarOrdenarProximosContatos([PROGRAMAR_7_DIAS]).length).toBe(1);
  });

  test('B-04 PROGRAMAR diasAteProximoCiclo=8 NÃO aparece (fora da janela)', () => {
    expect(filtrarOrdenarProximosContatos([PROGRAMAR_8_DIAS]).length).toBe(0);
  });

  test('B-05 AGIR_AGORA não aparece em PRÓXIMOS', () => {
    expect(filtrarOrdenarProximosContatos([AGIR_REATIVACAO]).length).toBe(0);
  });

  test('B-06 windowDays customizável: diasAteProximoCiclo=8 aparece com windowDays=8', () => {
    expect(filtrarOrdenarProximosContatos([PROGRAMAR_8_DIAS], 8).length).toBe(1);
  });

});

// ── Seção C: Ordenação ────────────────────────────────────────────────────────

describe('C — Ordenação', () => {

  test('C-01 HOJE ordenado por prioridade DESC (97 > 75 > 65)', () => {
    const hoje = filtrarOrdenarFilaHoje([AGIR_QUEDA, AGIR_REATIVACAO, AGIR_JANELA]);
    expect(hoje[0].clienteMr4Id).toBe('F_REAT');
    expect(hoje[1].clienteMr4Id).toBe('F_JAN');
    expect(hoje[2].clienteMr4Id).toBe('F_QUE');
  });

  test('C-02 HOJE desempate por diasSemComprar DESC quando prioridade igual', () => {
    const base = { ...AGIR_REATIVACAO_PRIO_ALTA };
    const rival = { ...AGIR_REATIVACAO, clienteMr4Id: 'F_REAT3', diasSemComprar: 200 };
    const hoje = filtrarOrdenarFilaHoje([base, rival]);
    expect(hoje[0].clienteMr4Id).toBe('F_REAT3');
  });

  test('C-03 PRÓXIMOS ordenados por diasAteProximoCiclo ASC (0 < 1 < 7)', () => {
    const prox = filtrarOrdenarProximosContatos([
      PROGRAMAR_7_DIAS, PROGRAMAR_0_DIAS, PROGRAMAR_1_DIA,
    ]);
    expect(prox[0].diasAteProximoCiclo).toBe(0);
    expect(prox[1].diasAteProximoCiclo).toBe(1);
    expect(prox[2].diasAteProximoCiclo).toBe(7);
  });

});

// ── Seção D: Labels seller-facing ─────────────────────────────────────────────

describe('D — Labels seller-facing', () => {

  test('D-01 REATIVACAO_120D → "Retomar contato"', () => {
    expect(labelOportunidade('REATIVACAO_120D')).toBe('Retomar contato');
  });

  test('D-02 JANELA_DE_RECOMPRA → "Janela de recompra"', () => {
    expect(labelOportunidade('JANELA_DE_RECOMPRA')).toBe('Janela de recompra');
  });

  test('D-03 QUEDA_DE_COMPRAS → "Queda no ritmo"', () => {
    expect(labelOportunidade('QUEDA_DE_COMPRAS')).toBe('Queda no ritmo');
  });

  test('D-04 tipo desconhecido retorna null (nomes internos não aparecem)', () => {
    expect(labelOportunidade('PROSPECT_VINCULADO')).toBeNull();
    expect(labelOportunidade('CROSS_SELL')).toBeNull();
    expect(labelOportunidade(null)).toBeNull();
    expect(labelOportunidade(undefined)).toBeNull();
  });

  test('D-05 nomes internos dos tipos não chegam à UI via label', () => {
    for (const tipo of ['REATIVACAO_120D', 'QUEDA_DE_COMPRAS', 'JANELA_DE_RECOMPRA']) {
      const label = labelOportunidade(tipo);
      expect(label).not.toContain('120D');
      expect(label).not.toContain('QUEDA');
      expect(label).not.toContain('JANELA');
      expect(label).not.toContain('REATIVACAO');
    }
  });

});

// ── Seção E: Prevenção de vazamento de dados ──────────────────────────────────

describe('E — Prevenção de vazamento (dados bloqueados)', () => {

  test('E-01 prepararDadosUI não expõe comoAbordar', () => {
    const ui = prepararDadosUI(AGIR_REATIVACAO);
    const bloqueados = verificarCamposBloqueados(ui);
    expect(bloqueados).not.toContain('comoAbordar');
    expect(JSON.stringify(ui)).not.toContain('comoAbordar');
  });

  test('E-02 prepararDadosUI não expõe scoreTotal nem classificacao', () => {
    const ui = prepararDadosUI(AGIR_REATIVACAO);
    expect(verificarCamposBloqueados(ui)).not.toContain('scoreTotal');
    expect(JSON.stringify(ui)).not.toContain('scoreTotal');
    expect(JSON.stringify(ui)).not.toContain('classificacao');
  });

  test('E-03 prepararDadosUI não expõe prioridade numérica', () => {
    const ui = prepararDadosUI(AGIR_REATIVACAO);
    const bloqueados = verificarCamposBloqueados(ui);
    expect(bloqueados).not.toContain('prioridade');
    expect(JSON.stringify(ui)).not.toContain('"prioridade"');
  });

  test('E-04 prepararDadosUI não expõe llmStatus nem versaoPrompt', () => {
    const ui = prepararDadosUI(AGIR_REATIVACAO);
    expect(JSON.stringify(ui)).not.toContain('llmStatus');
    expect(JSON.stringify(ui)).not.toContain('versaoPrompt');
  });

  test('E-05 prepararDadosUI sem comoAbordar quando sellerAssist está presente', () => {
    const ui = prepararDadosUI(AGIR_REATIVACAO);
    expect(ui).not.toHaveProperty('comoAbordar');
  });

});

// ── Seção F: Segurança de sinais ──────────────────────────────────────────────

describe('F — Sinais visíveis', () => {

  test('F-01 máximo de 3 sinais retornados', () => {
    const sinais = extrairSinaisVisiveis(AGIR_REATIVACAO);
    expect(sinais.length).toBeLessThanOrEqual(3);
  });

  test('F-02 null não vira dado falso (diasSemComprar null → sinal ausente)', () => {
    const sinais = extrairSinaisVisiveis(NUNCA_COMPROU);
    const labels = sinais.map(s => s.label);
    expect(labels).not.toContain('Dias sem comprar');
  });

  test('F-03 null não vira dado falso (mediana null → sinal ausente)', () => {
    const sinais = extrairSinaisVisiveis(NUNCA_COMPROU);
    const labels = sinais.map(s => s.label);
    expect(labels).not.toContain('Ciclo habitual');
  });

  test('F-04 sinais da fixture completa incluem dias, ciclo e tendência', () => {
    const sinais = extrairSinaisVisiveis(AGIR_REATIVACAO);
    const labels = sinais.map(s => s.label);
    expect(labels).toContain('Dias sem comprar');
    expect(labels).toContain('Ciclo habitual');
    expect(labels).toContain('Tendência');
  });

});

// ── Seção G: Robustez e estados de borda ─────────────────────────────────────

describe('G — Robustez', () => {

  test('G-01 lista vazia retorna fila HOJE vazia', () => {
    expect(filtrarOrdenarFilaHoje([])).toEqual([]);
  });

  test('G-02 lista vazia retorna PRÓXIMOS vazia', () => {
    expect(filtrarOrdenarProximosContatos([])).toEqual([]);
  });

  test('G-03 null na lista não causa erro (null safety)', () => {
    expect(() => filtrarOrdenarFilaHoje([null, undefined])).not.toThrow();
    expect(filtrarOrdenarFilaHoje([null, undefined])).toEqual([]);
  });

  test('G-04 input não-array retorna array vazio', () => {
    expect(filtrarOrdenarFilaHoje(null)).toEqual([]);
    expect(filtrarOrdenarFilaHoje(undefined)).toEqual([]);
    expect(filtrarOrdenarFilaHoje('string')).toEqual([]);
  });

  test('G-05 AGIR_AGORA sem tipoOportunidade não entra na fila (null-safe)', () => {
    const semTipo = { ...AGIR_REATIVACAO, tipoOportunidade: null };
    expect(filtrarOrdenarFilaHoje([semTipo]).length).toBe(0);
  });

  test('G-06 prepararDadosUI com null retorna null', () => {
    expect(prepararDadosUI(null)).toBeNull();
    expect(prepararDadosUI(undefined)).toBeNull();
  });

});

// ── Seção H: Integridade de negócio ──────────────────────────────────────────

describe('H — Integridade de negócio', () => {

  test('H-01 UPCOMING_WINDOW_DAYS = 7 (decisão humana confirmada)', () => {
    expect(UPCOMING_WINDOW_DAYS).toBe(7);
  });

  test('H-02 TIPOS_RECOMPRA_V1 tem exatamente 3 tipos e não inclui PROSPECT_VINCULADO', () => {
    expect(TIPOS_RECOMPRA_V1).toHaveLength(3);
    expect(TIPOS_RECOMPRA_V1).not.toContain('PROSPECT_VINCULADO');
  });

  test('H-03 nenhum botão de persistência ou confirmação de venda no output da fila', () => {
    const hoje = filtrarOrdenarFilaHoje([AGIR_REATIVACAO]);
    const serializado = JSON.stringify(hoje);
    expect(serializado).not.toContain('VENDA_CONFIRMADA');
    expect(serializado).not.toContain('registrarResultado');
    expect(serializado).not.toContain('salvar');
    expect(serializado).not.toContain('confirmar');
  });

  test('H-04 nenhuma carteira é inferida a partir dos dados da fila', () => {
    const hoje = filtrarOrdenarFilaHoje([AGIR_REATIVACAO, AGIR_JANELA]);
    for (const c of hoje) {
      expect(c).not.toHaveProperty('vendasResponsavel');
      expect(c).not.toHaveProperty('carteira');
      expect(c).not.toHaveProperty('responsavel');
    }
  });

  test('H-05 shadow output não está no resultado da fila', () => {
    const hoje = filtrarOrdenarFilaHoje([AGIR_REATIVACAO]);
    const serializado = JSON.stringify(hoje);
    expect(serializado).not.toContain('aiMode');
    expect(serializado).not.toContain('SHADOW');
    expect(serializado).not.toContain('mockMode');
  });

  test('H-06 prepararDadosUI não contém placeholder de IA', () => {
    const ui = prepararDadosUI(AGIR_REATIVACAO);
    const serializado = JSON.stringify(ui);
    expect(serializado).not.toMatch(/luna/i);
    expect(serializado).not.toMatch(/sugest.o em breve/i);
    expect(serializado).not.toContain('INFRA_ERROR');
    expect(serializado).not.toContain('FAIL_CLOSED');
  });

});
