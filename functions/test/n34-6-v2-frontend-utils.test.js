'use strict';
// N34.6 — V2 Frontend Utility Tests (Fase 27, Gate 5A.3)
// Testa as funções utilitárias do frontend fila-comercial.html sem DOM.
//
// Funções testadas (portadas inline — não alteram o .html):
//   formatarCriadoEm(str) — converte ISO em "Cadastrado há N dias"
//   renderCardProspect — validação de propriedades (via construção manual)
//
// Demais funções já cobertas em:
//   n34-6-v2-reference-date.test.js (extrairSinaisVisiveis — SEM_BASE)
//   n34-6-v2-prospeccao.test.js     (prepararDadosUIProspect, etc.)
//
// INVARIANTES:
//   DOM_REQUIRED=NO (pure JS logic only)
//   OPENAI_CALLS=0
//   PROD_WRITES=0

// ── Portabilidade da função (inline para isolar do DOM) ───────────────────────
// Cópia fiel de modulos/fila-comercial.html — qualquer alteração ali deve espelhar aqui.

function formatarCriadoEm(criadoEmStr) {
  try {
    const dt = new Date(criadoEmStr);
    const diff = Math.floor((Date.now() - dt.getTime()) / 86400000);
    if (isNaN(diff) || diff < 0) return 'Cadastrado recentemente';
    if (diff === 0) return 'Cadastrado hoje';
    if (diff === 1) return 'Cadastrado há 1 dia';
    return `Cadastrado há ${diff} dias`;
  } catch {
    return '';
  }
}

// ── Teste auxiliar: esc() (escaping de HTML) ──────────────────────────────────
function esc(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ── Testes formatarCriadoEm ───────────────────────────────────────────────────

describe('formatarCriadoEm — conversão ISO → texto', () => {
  test('null → retorno seguro sem lançar (new Date(null) = epoch → "há N dias")', () => {
    const result = formatarCriadoEm(null);
    expect(typeof result).toBe('string');
    // new Date(null) = 1970-01-01T00:00:00Z → diff > 0 → "Cadastrado há N dias"
    expect(result).not.toMatch(/null|undefined|NaN/i);
  });

  test('undefined → "Cadastrado recentemente" sem lançar', () => {
    const result = formatarCriadoEm(undefined);
    expect(result).toBe('Cadastrado recentemente');
  });

  test('string inválida → retorno seguro sem lançar', () => {
    // Datas inválidas retornam "Cadastrado recentemente" (diff=NaN → fallback)
    // A implementação usa try/catch mas new Date() nunca lança — retorna Invalid Date.
    const result = formatarCriadoEm('not-a-date');
    expect(typeof result).toBe('string');
    expect(result).not.toMatch(/null|undefined|NaN/i);
    const result2 = formatarCriadoEm('');
    expect(typeof result2).toBe('string');
    expect(result2).not.toMatch(/null|undefined|NaN/i);
  });

  test('data futura → "Cadastrado recentemente"', () => {
    const futuro = new Date(Date.now() + 86400000 * 5).toISOString();
    expect(formatarCriadoEm(futuro)).toBe('Cadastrado recentemente');
  });

  test('data de hoje (diff=0) → "Cadastrado hoje"', () => {
    // Pequena margem: "hoje" = diff=0
    const agora = new Date(Date.now() - 3600000).toISOString(); // 1h atrás
    expect(formatarCriadoEm(agora)).toBe('Cadastrado hoje');
  });

  test('data de ontem (diff=1) → "Cadastrado há 1 dia"', () => {
    const ontem = new Date(Date.now() - 86400000 * 1 - 3600000).toISOString();
    expect(formatarCriadoEm(ontem)).toBe('Cadastrado há 1 dia');
  });

  test('30 dias atrás → "Cadastrado há 30 dias"', () => {
    const ref = new Date(Date.now() - 86400000 * 30 - 3600000).toISOString();
    const result = formatarCriadoEm(ref);
    expect(result).toBe('Cadastrado há 30 dias');
  });

  test('saída nunca contém "null" ou "undefined"', () => {
    const resultado = formatarCriadoEm('not-a-date-string');
    expect(resultado).not.toMatch(/null/i);
    expect(resultado).not.toMatch(/undefined/i);
    expect(resultado).not.toMatch(/NaN/i);
  });

  test('saída nunca contém "null" quando string ISO válida mas antiga', () => {
    const antiga = new Date('2024-01-01T00:00:00Z').toISOString();
    const result = formatarCriadoEm(antiga);
    expect(result).not.toMatch(/null/i);
    expect(result).toMatch(/Cadastrado há \d+ dias/);
  });
});

// ── Testes de propriedades do card de prospect ────────────────────────────────

describe('renderCardProspect — propriedades e cópia seller-facing', () => {
  // Validação das propriedades que renderCardProspect usa (c.nomeCliente, c.criadoEm)
  // Testamos o shape que o writer produz e que o renderizador recebe

  const { prepararDadosUIProspect } = require('../lib/filaComercialUtils');

  test('chip "Nunca comprou" está presente no labelOp', () => {
    const ui = prepararDadosUIProspect({ tipoOportunidade: 'PROSPECT_VINCULADO', nomeCliente: 'Test' });
    expect(ui.labelOp).toBe('Nunca comprou');
  });

  test('card não expõe diasSemComprar ao renderer', () => {
    const ui = prepararDadosUIProspect({ tipoOportunidade: 'PROSPECT_VINCULADO', nomeCliente: 'Test' });
    expect(ui.diasSemComprar).toBeUndefined();
  });

  test('card sem nome usa fallback seguro ("—" no template)', () => {
    const ui = prepararDadosUIProspect({ tipoOportunidade: 'PROSPECT_VINCULADO', nomeCliente: null });
    expect(ui.nomeCliente).toBeNull();
    // esc(null) no template → '—' — verifica escape
    const rendered = esc(ui.nomeCliente || '—');
    expect(rendered).toBe('—');
  });

  test('XSS: nomeCliente com HTML é escapado', () => {
    const ui = prepararDadosUIProspect({ tipoOportunidade: 'PROSPECT_VINCULADO', nomeCliente: '<script>alert(1)</script>' });
    const escaped = esc(ui.nomeCliente);
    expect(escaped).not.toContain('<script>');
    expect(escaped).toContain('&lt;script&gt;');
  });

  test('XSS: criadoEm com HTML — saída não contém tags HTML', () => {
    const criadoEm = '<img onerror="alert(1)">';
    // new Date('<img>') → Invalid Date → diff=NaN → "Cadastrado recentemente"
    const text = formatarCriadoEm(criadoEm);
    expect(text).not.toContain('<');
    expect(text).not.toContain('>');
    expect(text).not.toContain('onerror');
    expect(typeof text).toBe('string');
    // esc() sobre a saída não produz nada perigoso
    const safeText = esc(text);
    expect(safeText).not.toContain('<img');
  });
});

// ── Testes renderizarFila e seções ────────────────────────────────────────────

describe('renderizarFila — cobertura de seções HOJE/PROXIMOS/PROSPECCAO via utils', () => {
  const {
    filtrarOrdenarFilaHoje,
    filtrarOrdenarProximosContatos,
    filtrarOrdenarProspeccao,
    construirSnapshot: _cs,
  } = (() => {
    const utils   = require('../lib/filaComercialUtils');
    return { ...utils, construirSnapshot: require('../lib/filaComercialWriter').construirSnapshot };
  })();

  function mkHoje(id, nome, dsc) {
    return {
      clienteMr4Id: id, nomeCliente: nome, tipoOportunidade: 'REATIVACAO_120D',
      decisaoAcaoComercial: 'AGIR_AGORA', diasSemComprar: dsc,
      diasEntreComprasMediana: 30, prioridade: 50, tendencia: 'CAINDO',
      sellerAssist: { situacao: 'S', quando: 'Q', sinais: {} },
    };
  }
  function mkProximos(id, nome, dap) {
    return {
      clienteMr4Id: id, nomeCliente: nome, tipoOportunidade: 'JANELA_DE_RECOMPRA',
      decisaoAcaoComercial: 'PROGRAMAR_CICLO', diasSemComprar: 25,
      diasAteProximoCiclo: dap, diasEntreComprasMediana: 30, prioridade: null,
      tendencia: 'ESTAVEL', sellerAssist: { situacao: 'S', quando: 'Q', sinais: {} },
    };
  }
  function mkProspecto(id, nome) {
    return {
      clienteMr4Id: id, nomeCliente: nome, tipoOportunidade: 'PROSPECT_VINCULADO',
      decisaoAcaoComercial: 'FILA_PROSPECCAO', diasSemComprar: null,
      diasEntreComprasMediana: null, prioridade: null, tendencia: null, sellerAssist: null,
    };
  }

  const todosBrutos = [
    mkHoje('H1', 'Carlos', 130),
    mkProximos('X1', 'Bruna', 5),
    mkProspecto('P1', 'Ana'),
    mkProspecto('P2', 'Zeca'),
  ];
  const snap = _cs(todosBrutos, { dataReferencia: '2026-09-21', timestamp: new Date() });

  test('seção HOJE contém somente AGIR_AGORA', () => {
    expect(snap.clientesHoje.every(c => c.decisaoAcaoComercial === 'AGIR_AGORA')).toBe(true);
  });

  test('seção PROXIMOS contém somente PROGRAMAR_CICLO com dap<=7', () => {
    expect(snap.clientesProximos.every(c => c.decisaoAcaoComercial === 'PROGRAMAR_CICLO')).toBe(true);
    expect(snap.clientesProximos.every(c => c.diasAteProximoCiclo <= 7)).toBe(true);
  });

  test('seção PROSPECCAO contém somente FILA_PROSPECCAO', () => {
    expect(snap.clientesProspeccao.every(c => c.decisaoAcaoComercial === 'FILA_PROSPECCAO')).toBe(true);
  });

  test('zero prospects em HOJE ou PROXIMOS', () => {
    const ids = new Set([...snap.clientesHoje, ...snap.clientesProximos].map(c => c.nomeCliente));
    expect(ids.has('Ana')).toBe(false);
    expect(ids.has('Zeca')).toBe(false);
  });

  test('SEM_BASE: sinais não produzem valores inválidos', () => {
    const { extrairSinaisVisiveis } = require('../lib/filaComercialUtils');
    const clienteSemBase = {
      diasSemComprar: 50, diasEntreComprasMediana: null,
      tendencia: 'CAINDO', sellerAssist: null,
    };
    const sinais = extrairSinaisVisiveis(clienteSemBase);
    sinais.forEach(s => {
      expect(s.valor).not.toMatch(/null|undefined|NaN/i);
    });
    const ciclo = sinais.find(s => s.label === 'Ciclo habitual');
    expect(ciclo?.valor).toBe('Ainda sem padrão de recompra');
  });

  test('score, prioridade, comoAbordar ausentes em clientesHoje do snapshot', () => {
    snap.clientesHoje.forEach(c => {
      expect(c).not.toHaveProperty('score');
      expect(c).not.toHaveProperty('scoreTotal');
      expect(c).not.toHaveProperty('prioridade');
      expect(c).not.toHaveProperty('comoAbordar');
    });
  });
});
