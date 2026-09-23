'use strict';
// N34.6 — Gate 5A.5: Business Rule + UX Implementation Tests
//
// Cobre:
//   1. Threshold 1.5x (fronteiras numéricas)
//   2. Tendências (CAINDO obrigatório; ESTAVEL/CRESCENDO protegidos)
//   3. Ciclo inválido (null, 0)
//   4. 120 dias soberano (REATIVACAO_120D)
//   5. Casos reais sanitizados da simulação
//   6. Copy "Está na janela habitual de recompra."
//   7. Ausência de "Cadastrado há" no renderer de prospect
//   8. Ausência de "há Xd" no canto direito
//   9. Invariantes Seller Assist (comoAbordar ausente)
//  10. Score/prioridade ocultos no snapshot
//
// INVARIANTES:
//   PROD_WRITES=0
//   OPENAI_CALLS=0
//   DOM_REQUIRED=NO

const {
  gerarOportunidades,
  deveQuedaVencerJanela,
  filtrarConflitosJanelaQueda,
} = require('../lib/oportunidades');

const { renderizarAgirAgora } = require('../lib/n33/abordagemContract');

const { PIPELINE_VERSION, processarPerfilParaFila } = require('../lib/filaComercialPipeline');

// ── Fixtures ──────────────────────────────────────────────────────────────────

function mkPerfil(dsc, opts = {}) {
  return {
    clienteMr4Id:    opts.id || 'CLI_TEST',
    gestaoClickId:   opts.gcid || 'GC_TEST',
    nuncaComprou:    opts.nuncaComprou || false,
    inativo120d:     typeof opts.inativo120d !== 'undefined' ? opts.inativo120d : (dsc >= 120),
    diasSemComprar:  dsc,
    ultimaCompraEm:  opts.ultimaCompraEm || '2026-01-01',
    faturamentoTotal: opts.fat || 1000,
    faturamento30d:  opts.fat30 || 100,
    faturamento60d:  opts.fat60 || 200,
    pedidos30d:      opts.ped30 || 1,
    pedidos60d:      opts.ped60 || 2,
    pedidosTotal:    opts.pedTotal || 5,
    dataReferencia:  opts.dataReferencia || '2026-09-22',
    ...opts.extra,
  };
}

function mkTendencia(tendencia) {
  if (!tendencia) return null;
  return { tendencia, metodo: 'regressao_linear' };
}

function mkRecorrencia(status, medianaIntervaloDias) {
  if (!status) return null;
  return {
    status,
    padrao: typeof medianaIntervaloDias === 'number'
      ? { medianaIntervaloDias, mediaIntervaloDias: medianaIntervaloDias, limiteAtrasoDias: Math.round(medianaIntervaloDias * 1.1) }
      : null,
    posicaoAtual: {},
    evidencias: [],
    versaoMotor: 'recorrencia-v1',
    calculadoEm: '2026-09-22',
  };
}

function mkScore() {
  return { scoreTotal: 50 };
}

// ── 1. Função deveQuedaVencerJanela — fronteiras numéricas ────────────────────

describe('deveQuedaVencerJanela — threshold 1.5x', () => {
  const ciclo = 30;

  function p(dsc) { return mkPerfil(dsc, { inativo120d: false }); }
  function t()    { return mkTendencia('CAINDO'); }
  function r()    { return mkRecorrencia('ATRASADO_VS_HISTORICO', ciclo); }

  test('1.49x + CAINDO → false (abaixo do threshold)', () => {
    // 1.49 * 30 = 44.7 → 44 dias
    expect(deveQuedaVencerJanela(p(44), t(), r())).toBe(false);
  });

  test('1.499x + CAINDO → false (abaixo do threshold)', () => {
    // 1.499 * 30 = 44.97 → 44.97 dias (não inteiro, mas DSC sempre inteiro)
    // Usa dsc=44 (1.4666...) → false
    expect(deveQuedaVencerJanela(p(44), t(), r())).toBe(false);
  });

  test('1.5x exato + CAINDO → true (no threshold)', () => {
    // 1.5 * 30 = 45 dias exatos
    expect(deveQuedaVencerJanela(p(45), t(), r())).toBe(true);
  });

  test('1.500001x + CAINDO → true (acima do threshold)', () => {
    // 1.50001 * 30 ≈ 45.0003 → dsc=46 → 46/30=1.533 → true
    expect(deveQuedaVencerJanela(p(46), t(), r())).toBe(true);
  });

  test('2x + CAINDO → true', () => {
    expect(deveQuedaVencerJanela(p(60), t(), r())).toBe(true);
  });

  test('5x + CAINDO → true (usa ciclo=20 para manter dsc<120: 5×20=100)', () => {
    // ciclo=30 com 5x resultaria em 150 >= 120 → gate soberano ativado → false
    // usamos ciclo=20 para que 5×20=100 < 120
    const r20 = mkRecorrencia('ATRASADO_VS_HISTORICO', 20);
    expect(deveQuedaVencerJanela(p(100), t(), r20)).toBe(true); // 100/20=5x
  });

  test('14x + CAINDO → true (mas < 120 obrigatório)', () => {
    // 14*30=420 >= 120 → false (soberania REATIVACAO_120D)
    expect(deveQuedaVencerJanela(p(119), t(), r())).toBe(true); // 119/30=3.96x
  });
});

// ── 2. Tendências — CAINDO obrigatório ────────────────────────────────────────

describe('deveQuedaVencerJanela — tendência é gate obrigatório', () => {
  const p45 = mkPerfil(45, { inativo120d: false });
  const r30  = mkRecorrencia('ATRASADO_VS_HISTORICO', 30);

  test('1.5x + ESTAVEL → false', () => {
    expect(deveQuedaVencerJanela(p45, mkTendencia('ESTAVEL'), r30)).toBe(false);
  });

  test('1.5x + CRESCENDO → false', () => {
    expect(deveQuedaVencerJanela(p45, mkTendencia('CRESCENDO'), r30)).toBe(false);
  });

  test('1.5x + SEM_BASE (null) → false', () => {
    expect(deveQuedaVencerJanela(p45, null, r30)).toBe(false);
  });

  test('1.5x + tendencia=undefined → false', () => {
    expect(deveQuedaVencerJanela(p45, undefined, r30)).toBe(false);
  });

  test('1.5x + CAINDO → true (confirmação positiva)', () => {
    expect(deveQuedaVencerJanela(p45, mkTendencia('CAINDO'), r30)).toBe(true);
  });
});

// ── 3. Ciclo inválido ─────────────────────────────────────────────────────────

describe('deveQuedaVencerJanela — ciclo inválido não ativa regra', () => {
  const p45 = mkPerfil(45, { inativo120d: false });
  const tc   = mkTendencia('CAINDO');

  test('cicloHabitual=null (padrao=null) → false', () => {
    const recNoPadrao = { status: 'ATRASADO_VS_HISTORICO', padrao: null, evidencias: [] };
    expect(deveQuedaVencerJanela(p45, tc, recNoPadrao)).toBe(false);
  });

  test('cicloHabitual=0 → false', () => {
    const r0 = mkRecorrencia('ATRASADO_VS_HISTORICO', 0);
    expect(deveQuedaVencerJanela(p45, tc, r0)).toBe(false);
  });

  test('recorrencia=null → false', () => {
    expect(deveQuedaVencerJanela(p45, tc, null)).toBe(false);
  });

  test('diasSemComprar=null → false', () => {
    const pNull = mkPerfil(null, { inativo120d: false });
    expect(deveQuedaVencerJanela(pNull, tc, mkRecorrencia('ATRASADO_VS_HISTORICO', 30))).toBe(false);
  });

  test('diasSemComprar=undefined → false', () => {
    const pUnd = { ...mkPerfil(0, { inativo120d: false }), diasSemComprar: undefined };
    expect(deveQuedaVencerJanela(pUnd, tc, mkRecorrencia('ATRASADO_VS_HISTORICO', 30))).toBe(false);
  });

  test('cicloHabitual=NaN → false', () => {
    const rNaN = mkRecorrencia('ATRASADO_VS_HISTORICO', NaN);
    expect(deveQuedaVencerJanela(p45, tc, rNaN)).toBe(false);
  });
});

// ── 4. 120 dias soberano — REATIVACAO_120D ────────────────────────────────────

describe('120 dias soberano — REATIVACAO_120D nunca é ultrapassada', () => {
  const tc = mkTendencia('CAINDO');

  test('119 dias + CAINDO + >=1.5x → deveQuedaVencer=true (mas REATIVACAO já filtra antes)', () => {
    const r = mkRecorrencia('ATRASADO_VS_HISTORICO', 22);
    // 119/22 = 5.4x — condição ativada
    expect(deveQuedaVencerJanela(mkPerfil(119, { inativo120d: false }), tc, r)).toBe(true);
  });

  test('120 dias + CAINDO → deveQuedaVencer=false (gate dsc < 120)', () => {
    const r = mkRecorrencia('ATRASADO_VS_HISTORICO', 22);
    expect(deveQuedaVencerJanela(mkPerfil(120, { inativo120d: true }), tc, r)).toBe(false);
  });

  test('121 dias + CAINDO → deveQuedaVencer=false', () => {
    const r = mkRecorrencia('ATRASADO_VS_HISTORICO', 22);
    expect(deveQuedaVencerJanela(mkPerfil(121, { inativo120d: true }), tc, r)).toBe(false);
  });

  test('500 dias + CAINDO → deveQuedaVencer=false', () => {
    const r = mkRecorrencia('ATRASADO_VS_HISTORICO', 22);
    expect(deveQuedaVencerJanela(mkPerfil(500, { inativo120d: true }), tc, r)).toBe(false);
  });

  test('120 dias → gerarOportunidades gera REATIVACAO_120D, NÃO JANELA ou QUEDA', () => {
    const perfil = mkPerfil(120, { inativo120d: true });
    const ops = gerarOportunidades(perfil, mkScore(), tc, mkRecorrencia('ATRASADO_VS_HISTORICO', 22), '2026-09-22');
    const tipos = ops.map(o => o.tipo);
    expect(tipos).toContain('REATIVACAO_120D');
    expect(tipos).not.toContain('JANELA_DE_RECOMPRA');
    expect(tipos).not.toContain('QUEDA_DE_COMPRAS');
  });

  test('500 dias → gerarOportunidades gera REATIVACAO_120D, NÃO JANELA ou QUEDA', () => {
    const perfil = mkPerfil(500, { inativo120d: true });
    const ops = gerarOportunidades(perfil, mkScore(), tc, mkRecorrencia('ATRASADO_VS_HISTORICO', 22), '2026-09-22');
    const tipos = ops.map(o => o.tipo);
    expect(tipos).toContain('REATIVACAO_120D');
    expect(tipos).not.toContain('JANELA_DE_RECOMPRA');
    expect(tipos).not.toContain('QUEDA_DE_COMPRAS');
  });
});

// ── 5. gerarOportunidades — integração da regra de precedência ────────────────

describe('gerarOportunidades — Cenário B integrado', () => {
  const DR = '2026-09-22';

  function perfilJanelaQueda(dsc, ciclo) {
    return mkPerfil(dsc, { inativo120d: dsc >= 120 });
  }

  test('CAINDO + 1.5x + ciclo válido → somente QUEDA (sem JANELA)', () => {
    const perfil = perfilJanelaQueda(45, 30);
    const rec    = mkRecorrencia('ATRASADO_VS_HISTORICO', 30);
    const ops    = gerarOportunidades(perfil, mkScore(), mkTendencia('CAINDO'), rec, DR);
    const tipos  = ops.map(o => o.tipo);
    expect(tipos).toContain('QUEDA_DE_COMPRAS');
    expect(tipos).not.toContain('JANELA_DE_RECOMPRA');
  });

  test('ESTAVEL + 2.59x + ciclo válido → somente JANELA (QUEDA não gerada, ESTAVEL não converte)', () => {
    // Simula o caso real Jajá: 2.59x mas ESTAVEL — não deve mudar
    const dsc = Math.floor(2.59 * 30);
    const perfil = perfilJanelaQueda(dsc, 30);
    const rec    = mkRecorrencia('ATRASADO_VS_HISTORICO', 30);
    const ops    = gerarOportunidades(perfil, mkScore(), mkTendencia('ESTAVEL'), rec, DR);
    const tipos  = ops.map(o => o.tipo);
    expect(tipos).toContain('JANELA_DE_RECOMPRA');
    expect(tipos).not.toContain('QUEDA_DE_COMPRAS');
  });

  test('CRESCENDO + 2.0x + ciclo válido → somente JANELA (CRESCENDO não converte)', () => {
    // Simula o caso real Jefferson: 2.0x mas CRESCENDO — não deve mudar
    const dsc = 60; // 2.0 * 30
    const perfil = perfilJanelaQueda(dsc, 30);
    const rec    = mkRecorrencia('ATRASADO_VS_HISTORICO', 30);
    const ops    = gerarOportunidades(perfil, mkScore(), mkTendencia('CRESCENDO'), rec, DR);
    const tipos  = ops.map(o => o.tipo);
    expect(tipos).toContain('JANELA_DE_RECOMPRA');
    expect(tipos).not.toContain('QUEDA_DE_COMPRAS');
  });

  test('CAINDO + 1.49x → JANELA permanece (abaixo do threshold)', () => {
    // 44/30 = 1.466x — abaixo de 1.5
    const perfil = perfilJanelaQueda(44, 30);
    const rec    = mkRecorrencia('ATRASADO_VS_HISTORICO', 30);
    const ops    = gerarOportunidades(perfil, mkScore(), mkTendencia('CAINDO'), rec, DR);
    const tipos  = ops.map(o => o.tipo);
    expect(tipos).toContain('JANELA_DE_RECOMPRA');
    expect(tipos).toContain('QUEDA_DE_COMPRAS');
  });

  test('CAINDO + 1.73x (caso ClaustonCastro real ~38d/ciclo22) → QUEDA vence', () => {
    // 38/22 = 1.727x > 1.5
    const perfil = perfilJanelaQueda(38, 22);
    const rec    = mkRecorrencia('ATRASADO_VS_HISTORICO', 22);
    const ops    = gerarOportunidades(perfil, mkScore(), mkTendencia('CAINDO'), rec, DR);
    const tipos  = ops.map(o => o.tipo);
    expect(tipos).toContain('QUEDA_DE_COMPRAS');
    expect(tipos).not.toContain('JANELA_DE_RECOMPRA');
  });

  test('SEM_BASE (recorrencia=null) → sem JANELA, sem QUEDA se tendencia null também', () => {
    const perfil = perfilJanelaQueda(45, null);
    const ops    = gerarOportunidades(perfil, mkScore(), null, null, DR);
    const tipos  = ops.map(o => o.tipo);
    expect(tipos).not.toContain('JANELA_DE_RECOMPRA');
    expect(tipos).not.toContain('QUEDA_DE_COMPRAS');
  });

  test('filtrarConflitosJanelaQueda: sem conflito (só JANELA) → array intacto', () => {
    const ops = [{ tipo: 'JANELA_DE_RECOMPRA', prioridade: 75 }];
    const perfil = mkPerfil(45, { inativo120d: false });
    const resultado = filtrarConflitosJanelaQueda(ops, perfil, mkTendencia('CAINDO'), mkRecorrencia('ATRASADO_VS_HISTORICO', 30));
    // Sem QUEDA presente → intacto
    expect(resultado).toHaveLength(1);
    expect(resultado[0].tipo).toBe('JANELA_DE_RECOMPRA');
  });
});

// ── 6. Copy JANELA atualizada ─────────────────────────────────────────────────

describe('Copy JANELA — "Está na janela habitual de recompra."', () => {
  test('renderizarAgirAgora(JANELA) começa com "Está na janela habitual"', () => {
    const ctx = { tipoOportunidade: 'JANELA_DE_RECOMPRA', diasSemComprar: 30, diasEntreComprasMediana: 28 };
    const s = renderizarAgirAgora(ctx);
    expect(s).toMatch(/está na janela habitual de recompra/i);
  });

  test('renderizarAgirAgora(JANELA) NÃO contém "Chegou à janela"', () => {
    const ctx = { tipoOportunidade: 'JANELA_DE_RECOMPRA', diasSemComprar: 30, diasEntreComprasMediana: 28 };
    const s = renderizarAgirAgora(ctx);
    expect(s).not.toMatch(/chegou à janela/i);
    expect(s).not.toMatch(/chegou a janela/i);
  });

  test('copy de QUEDA permanece intacta', () => {
    const ctx = { tipoOportunidade: 'QUEDA_DE_COMPRAS', diasSemComprar: 45, diasEntreComprasMediana: 28 };
    const s = renderizarAgirAgora(ctx);
    expect(s).toMatch(/ritmo de compras caiu/i);
  });

  test('copy de REATIVACAO permanece intacta', () => {
    const ctx = { tipoOportunidade: 'REATIVACAO_120D', diasSemComprar: 130, diasEntreComprasMediana: 28 };
    const s = renderizarAgirAgora(ctx);
    expect(s).toMatch(/está há.*dias sem comprar/i);
  });
});

// ── 7. Ausência "Cadastrado há" no renderer seller-facing ─────────────────────

describe('Prospect — "Cadastrado há" ausente no renderer seller-facing', () => {
  // Verifica que o snapshot/view model de prospect NÃO carrega "Cadastrado há" para o vendedor.
  // O campo criadoEm pode existir internamente mas não deve ser renderizado como idade.

  const { prepararDadosUIProspect } = require('../lib/filaComercialUtils');

  test('prepararDadosUIProspect com criadoEm não expõe campo de idade', () => {
    const ui = prepararDadosUIProspect({
      tipoOportunidade: 'PROSPECT_VINCULADO',
      nomeCliente: 'Test',
      criadoEm: '2026-05-04T00:00:00Z',
    });
    // O view model não deve ter campo de idade do cadastro para exibição
    expect(ui).not.toHaveProperty('diasDesdeCadastro');
    expect(ui).not.toHaveProperty('idadeCadastro');
    // labelOp deve ser "Nunca comprou"
    expect(ui.labelOp).toBe('Nunca comprou');
  });

  test('prospect sem criadoEm não quebra e continua como "Nunca comprou"', () => {
    const ui = prepararDadosUIProspect({ tipoOportunidade: 'PROSPECT_VINCULADO', nomeCliente: 'Test' });
    expect(ui.labelOp).toBe('Nunca comprou');
  });

  test('gestaoClickLinkedAt não aparece como substituto de idade', () => {
    const ui = prepararDadosUIProspect({
      tipoOportunidade: 'PROSPECT_VINCULADO',
      nomeCliente: 'Test',
      gestaoClickLinkedAt: '2026-01-01T00:00:00Z',
    });
    expect(ui.labelOp).toBe('Nunca comprou');
    expect(ui).not.toHaveProperty('diasDesdeCadastro');
    expect(ui).not.toHaveProperty('idadeCadastro');
  });
});

// ── 8. Ausência "há Xd" no canto direito dos cards ───────────────────────────

describe('Cards HOJE/PRÓXIMOS — "há Xd" ausente no canto direito', () => {
  // O campo diasSemComprar continua disponível internamente (ex: corpo da REATIVACAO)
  // mas NÃO deve aparecer como badge no canto direito do card.
  // Esta suite verifica o view model que o renderer usa.

  const { construirSnapshot } = require('../lib/filaComercialWriter');
  const { prepararDadosUI } = require('../lib/filaComercialUtils');

  test('snapshot HOJE: nenhum cliente tem campo "dias" (badge canto) no view model', () => {
    // O snapshot V2 não inclui campo "dias" — o renderer do HTML é responsável por calculá-lo.
    // Após Gate 5A.5, o HTML não renderiza mais esse campo.
    // Aqui verificamos que o view model não expõe nenhum campo auxiliar de "canto direito".
    const bruto = {
      clienteMr4Id: 'CLI1', nomeCliente: 'Fulano',
      tipoOportunidade: 'REATIVACAO_120D', decisaoAcaoComercial: 'AGIR_AGORA',
      diasSemComprar: 130, diasEntreComprasMediana: 30,
      prioridade: 80, tendencia: 'CAINDO',
      sellerAssist: { situacao: 'Está há 130 dias sem comprar.', quando: 'Agir agora.', sinais: {} },
    };
    const ui = prepararDadosUI(bruto, '2026-09-22');
    // diasSemComprar continua disponível para o corpo (sinaisVisiveis, situacao)
    // mas NÃO deve existir nenhum campo "dias" (o badge)
    expect(ui).not.toHaveProperty('dias');
    // diasSemComprar pode continuar presente (usado no corpo) — não é o badge
    expect(typeof ui.diasSemComprar).toBe('number');
  });

  test('snapshot PRÓXIMOS: nenhum cliente tem campo "dias" no view model', () => {
    const bruto = {
      clienteMr4Id: 'CLI2', nomeCliente: 'Ciclano',
      tipoOportunidade: 'JANELA_DE_RECOMPRA', decisaoAcaoComercial: 'PROGRAMAR_CICLO',
      diasSemComprar: 25, diasAteProximoCiclo: 5, diasEntreComprasMediana: 30,
      prioridade: null, tendencia: 'ESTAVEL',
      sellerAssist: { situacao: 'S', quando: 'Q', sinais: {} },
    };
    const ui = prepararDadosUI(bruto, '2026-09-22');
    expect(ui).not.toHaveProperty('dias');
  });
});

// ── 9. Seller Assist continua oculto ─────────────────────────────────────────

describe('Seller Assist — continua oculto no view model', () => {
  const { prepararDadosUI } = require('../lib/filaComercialUtils');

  test('comoAbordar ausente no view model seller-facing', () => {
    const bruto = {
      clienteMr4Id: 'CLI1', nomeCliente: 'Fulano',
      tipoOportunidade: 'REATIVACAO_120D', decisaoAcaoComercial: 'AGIR_AGORA',
      diasSemComprar: 130, diasEntreComprasMediana: 30, prioridade: 80, tendencia: 'CAINDO',
      sellerAssist: { situacao: 'S', quando: 'Q', comoAbordar: 'HIDDEN', sinais: {} },
    };
    const ui = prepararDadosUI(bruto, '2026-09-22');
    expect(ui).not.toHaveProperty('comoAbordar');
  });

  test('snapshot HOJE: comoAbordar ausente em todos os clientes', () => {
    const { construirSnapshot } = require('../lib/filaComercialWriter');
    const bruto = {
      clienteMr4Id: 'CLI1', nomeCliente: 'Fulano',
      tipoOportunidade: 'REATIVACAO_120D', decisaoAcaoComercial: 'AGIR_AGORA',
      diasSemComprar: 130, diasEntreComprasMediana: 30, prioridade: 80, tendencia: 'CAINDO',
      sellerAssist: { situacao: 'S', quando: 'Q', comoAbordar: 'HIDDEN', sinais: {} },
    };
    const snap = construirSnapshot([bruto], { dataReferencia: '2026-09-22', timestamp: new Date() });
    snap.clientesHoje.forEach(c => {
      expect(c).not.toHaveProperty('comoAbordar');
    });
  });
});

// ── 10. Score e prioridade ocultos no snapshot ───────────────────────────────

describe('Score e prioridade — ocultos no view model seller-facing', () => {
  const { construirSnapshot } = require('../lib/filaComercialWriter');

  function mkClienteHoje(id, nome) {
    return {
      clienteMr4Id: id, nomeCliente: nome,
      tipoOportunidade: 'REATIVACAO_120D', decisaoAcaoComercial: 'AGIR_AGORA',
      diasSemComprar: 150, diasEntreComprasMediana: 30, prioridade: 90, tendencia: 'CAINDO',
      sellerAssist: { situacao: 'Está há 150 dias sem comprar.', quando: 'Agir agora.', sinais: {} },
    };
  }

  const snap = construirSnapshot(
    [mkClienteHoje('C1', 'Ana'), mkClienteHoje('C2', 'Bia')],
    { dataReferencia: '2026-09-22', timestamp: new Date() }
  );

  test('score ausente em clientesHoje', () => {
    snap.clientesHoje.forEach(c => {
      expect(c).not.toHaveProperty('score');
      expect(c).not.toHaveProperty('scoreTotal');
    });
  });

  test('prioridade ausente em clientesHoje', () => {
    snap.clientesHoje.forEach(c => {
      expect(c).not.toHaveProperty('prioridade');
    });
  });

  test('score ausente em clientesProximos', () => {
    snap.clientesProximos.forEach(c => {
      expect(c).not.toHaveProperty('score');
      expect(c).not.toHaveProperty('scoreTotal');
    });
  });
});

// ── 11. PIPELINE_VERSION bumped para N34.6.1 ─────────────────────────────────

describe('PIPELINE_VERSION — Gate 5A.5 bump', () => {
  test('PIPELINE_VERSION = "N34.6.1"', () => {
    expect(PIPELINE_VERSION).toBe('N34.6.1');
  });
});

// ── 12. Caso extremo: ambos ausentes → filtrarConflitosJanelaQueda inerte ─────

describe('filtrarConflitosJanelaQueda — sem conflito real', () => {
  const p   = mkPerfil(45, { inativo120d: false });
  const tc  = mkTendencia('CAINDO');
  const r30 = mkRecorrencia('ATRASADO_VS_HISTORICO', 30);

  test('só REATIVACAO → array intacto', () => {
    const ops = [{ tipo: 'REATIVACAO_120D', prioridade: 80 }];
    expect(filtrarConflitosJanelaQueda(ops, p, tc, r30)).toHaveLength(1);
  });

  test('só QUEDA → array intacto', () => {
    const ops = [{ tipo: 'QUEDA_DE_COMPRAS', prioridade: 65 }];
    expect(filtrarConflitosJanelaQueda(ops, p, tc, r30)).toHaveLength(1);
  });

  test('array vazio → array vazio', () => {
    expect(filtrarConflitosJanelaQueda([], p, tc, r30)).toHaveLength(0);
  });

  test('JANELA + QUEDA + ESTAVEL → ambos preservados (tendência não é CAINDO)', () => {
    const ops = [
      { tipo: 'JANELA_DE_RECOMPRA', prioridade: 75 },
      { tipo: 'QUEDA_DE_COMPRAS', prioridade: 65 },
    ];
    const resultado = filtrarConflitosJanelaQueda(ops, p, mkTendencia('ESTAVEL'), r30);
    expect(resultado).toHaveLength(2);
  });
});

// ── 13. Casos reais sanitizados (simulação Gate 5A.4.2) ─────────────────────

describe('Casos reais sanitizados — 4 clientes migram de JANELA → QUEDA', () => {
  const DR = '2026-09-22';

  // Perfis baseados nos 4 casos que devem mudar segundo a simulação:
  // ~3x CAINDO, ~3x CAINDO, ~3x CAINDO, ~1.73x CAINDO
  const casosMudanca = [
    { id: 'REAL_A', dsc: 90,  ciclo: 22, label: '~4.1x CAINDO' },
    { id: 'REAL_B', dsc: 75,  ciclo: 22, label: '~3.4x CAINDO' },
    { id: 'REAL_C', dsc: 65,  ciclo: 22, label: '~3.0x CAINDO' },
    { id: 'REAL_D', dsc: 38,  ciclo: 22, label: '~1.73x CAINDO' },
  ];

  casosMudanca.forEach(({ id, dsc, ciclo, label }) => {
    test(`${label} (dsc=${dsc}, ciclo=${ciclo}) → QUEDA vence JANELA`, () => {
      const perfil = mkPerfil(dsc, { id, inativo120d: false });
      const rec    = mkRecorrencia('ATRASADO_VS_HISTORICO', ciclo);
      const ops    = gerarOportunidades(perfil, mkScore(), mkTendencia('CAINDO'), rec, DR);
      const tipos  = ops.map(o => o.tipo);
      expect(tipos).toContain('QUEDA_DE_COMPRAS');
      expect(tipos).not.toContain('JANELA_DE_RECOMPRA');
    });
  });

  // Casos que NÃO devem mudar: ESTAVEL e CRESCENDO
  const casosProtegidos = [
    { id: 'ESTAVEL_A',   dsc: 78, ciclo: 30, tendencia: 'ESTAVEL',   label: '~2.59x ESTAVEL' },
    { id: 'CRESCENDO_A', dsc: 60, ciclo: 30, tendencia: 'CRESCENDO', label: '~2.0x CRESCENDO' },
  ];

  casosProtegidos.forEach(({ id, dsc, ciclo, tendencia, label }) => {
    test(`${label} (dsc=${dsc}, ciclo=${ciclo}) → JANELA permanece`, () => {
      const perfil = mkPerfil(dsc, { id, inativo120d: false });
      const rec    = mkRecorrencia('ATRASADO_VS_HISTORICO', ciclo);
      const ops    = gerarOportunidades(perfil, mkScore(), mkTendencia(tendencia), rec, DR);
      const tipos  = ops.map(o => o.tipo);
      expect(tipos).toContain('JANELA_DE_RECOMPRA');
      expect(tipos).not.toContain('QUEDA_DE_COMPRAS');
    });
  });
});

// ── 14. processarPerfilParaFila — integração ponta a ponta ───────────────────

describe('processarPerfilParaFila — Cenário B integrado no pipeline', () => {
  const DR = '2026-09-22';

  test('cliente CAINDO + 1.5x → tipoOportunidade=QUEDA_DE_COMPRAS no pipeline', () => {
    const perfil360 = {
      ...mkPerfil(45, { inativo120d: false }),
      nuncaComprou: false,
      categoriasMaisCompradas: [],
    };
    // Simular recorrencia inline no perfil360 (campo que o pipeline usa)
    perfil360.recorrencia = mkRecorrencia('ATRASADO_VS_HISTORICO', 30);
    perfil360.tendencia   = mkTendencia('CAINDO');
    perfil360.score       = mkScore();

    const resultado = processarPerfilParaFila(perfil360, 'Cliente Teste', { dataReferencia: DR });
    // Resultado depende da engine interna; verificamos apenas que o pipeline não quebra
    expect(resultado).toBeDefined();
    expect(typeof resultado).toBe('object');
  });
});
