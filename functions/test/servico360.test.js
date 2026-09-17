'use strict';

/**
 * SERV360-01 → SERV360-12
 * Testa: atribuicao.js (N16) e servicoAgenteComercial.js (N17).
 */

const { criarRegistroAtribuicao, dentroJanelaAtribuicao, JANELA_ATRIBUICAO_DIAS_PROVISIONAL } = require('../lib/ai/atribuicao');
const { executarPipelineComercial, VERSAO_SERVICO } = require('../lib/ai/servicoAgenteComercial');
const { FIXTURE_ATIVO_EXCELENTE, FIXTURE_NUNCA_COMPROU, FIXTURE_INATIVO_120D, FIXTURE_CAINDO } = require('./fixtures/agente-comercial/perfis-fixture');

// ── Atribuicao (N16) ──────────────────────────────────────────────────────────

describe('atribuicao (N16)', () => {
  test('SERV360-01: criarRegistroAtribuicao() retorna estrutura válida', () => {
    const reg = criarRegistroAtribuicao({
      clienteMr4Id: 'cli_001',
      vendedorId:   'vend_001',
      tipoAcao:     'CONTATO',
      dataAcao:     '2026-09-16',
      oportunidadesRef: ['id_oport_1'],
    });
    expect(reg.id).toBeTruthy();
    expect(reg.avisoAtribuicao).toContain('CORRELAÇÃO');
    expect(reg.statusAtribuicao).toBe('PROVISIONAL');
    expect(reg.versaoAtribuicao).toBeTruthy();
  });

  test('SERV360-02: criarRegistroAtribuicao() sem campos obrigatórios → erro', () => {
    expect(() => criarRegistroAtribuicao({ clienteMr4Id: 'x', vendedorId: 'y' }))
      .toThrow('campos obrigatórios ausentes');
  });

  test('SERV360-03: dentroJanelaAtribuicao() — 0 dias → dentro', () => {
    expect(dentroJanelaAtribuicao('2026-09-16', '2026-09-16')).toBe(true);
  });

  test('SERV360-04: dentroJanelaAtribuicao() — exato no limite → dentro', () => {
    expect(dentroJanelaAtribuicao('2026-08-17', '2026-09-16')).toBe(true);  // 30 dias
  });

  test('SERV360-05: dentroJanelaAtribuicao() — além do limite → fora', () => {
    expect(dentroJanelaAtribuicao('2026-08-16', '2026-09-16')).toBe(false);  // 31 dias
  });

  test('SERV360-06: dentroJanelaAtribuicao() — ação antes da oportunidade → fora', () => {
    expect(dentroJanelaAtribuicao('2026-09-16', '2026-09-10')).toBe(false);  // negativo
  });

  test('SERV360-07: dentroJanelaAtribuicao() — data inválida → false', () => {
    expect(dentroJanelaAtribuicao('invalida', '2026-09-16')).toBe(false);
  });

  test('SERV360-07b: JANELA_ATRIBUICAO_DIAS_PROVISIONAL = 30', () => {
    expect(JANELA_ATRIBUICAO_DIAS_PROVISIONAL).toBe(30);
  });
});

// ── servicoAgenteComercial (N17) ──────────────────────────────────────────────

describe('servicoAgenteComercial (N17)', () => {
  test('SERV360-08: pipeline completo com perfil ativo → resultado conforme', async () => {
    const resultado = await executarPipelineComercial(FIXTURE_ATIVO_EXCELENTE);
    expect(resultado.score.scoreTotal).toBeGreaterThanOrEqual(60);
    expect(resultado.analise.tipo).toBe('ANALISE');
    expect(resultado.auditoria.conformeGeral).toBe(true);
    expect(resultado.mockMode).toBe(true);
    expect(resultado.statusServico).toBe('SHADOW'); // N25: shadow mode ativo
    expect(resultado.versaoServico).toBeTruthy();
    expect(resultado.trace.spans.length).toBeGreaterThan(0);
  });

  test('SERV360-09: pipeline com nuncaComprou → oportunidade PROSPECT_VINCULADO (V1)', async () => {
    const resultado = await executarPipelineComercial(FIXTURE_NUNCA_COMPROU);
    const tipos = resultado.oportunidades.map(o => o.tipo);
    expect(tipos).toContain('PROSPECT_VINCULADO');
    expect(resultado.auditoria.conformeGeral).toBe(true);
  });

  test('SERV360-10: pipeline com inativo120d → oportunidade REATIVACAO_120D', async () => {
    const resultado = await executarPipelineComercial(FIXTURE_INATIVO_120D);
    const tipos = resultado.oportunidades.map(o => o.tipo);
    expect(tipos).toContain('REATIVACAO_120D');
  });

  test('SERV360-11: pipeline com incluirExplicacaoScore=true → explicacaoScore presente', async () => {
    const resultado = await executarPipelineComercial(FIXTURE_ATIVO_EXCELENTE, {
      incluirExplicacaoScore: true,
    });
    expect(resultado.explicacaoScore).toBeDefined();
    expect(resultado.explicacaoScore.tipo).toBe('EXPLICACAO');
  });

  test('SERV360-12: pipeline com perfil inválido → erro imediato', async () => {
    await expect(executarPipelineComercial(null)).rejects.toThrow('perfil inválido');
  });
});
