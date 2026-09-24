'use strict';
// N35.8 — Testes de Identidade Comercial Híbrida
// Cobre: commercialIdentity.js

const {
  SOURCES,
  ANCHOR_NUNCA,
  buildCommercialEntityId,
  parseCommercialEntityId,
  commercialEntityIdFromPerfil360,
  buildOpportunityInstanceId,
  validateIdentity,
} = require('../lib/commercialIdentity');

// ── buildCommercialEntityId ───────────────────────────────────────────────────

test('N35-8-ID-01: MR4_LINKED produz id prefixado correto', () => {
  const id = buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: 'abc123XYZ0987654321A' });
  expect(id).toBe('MR4_LINKED:abc123XYZ0987654321A');
});

test('N35-8-ID-02: GC_NATIVE produz id prefixado correto', () => {
  const id = buildCommercialEntityId({ source: 'GC_NATIVE', gestaoClickId: '31349459' });
  expect(id).toBe('GC_NATIVE:31349459');
});

test('N35-8-ID-03: MR4_LINKED rejeita mr4ClientId somente numérico', () => {
  expect(() =>
    buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: '31349459' })
  ).toThrow(/parece gestaoClickId/);
});

test('N35-8-ID-04: MR4_LINKED rejeita mr4ClientId vazio', () => {
  expect(() =>
    buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: '' })
  ).toThrow(/mr4ClientId obrigatório/);
});

test('N35-8-ID-05: MR4_LINKED rejeita mr4ClientId ausente', () => {
  expect(() =>
    buildCommercialEntityId({ source: 'MR4_LINKED' })
  ).toThrow(/mr4ClientId obrigatório/);
});

test('N35-8-ID-06: GC_NATIVE rejeita gestaoClickId não-numérico', () => {
  expect(() =>
    buildCommercialEntityId({ source: 'GC_NATIVE', gestaoClickId: 'abc123' })
  ).toThrow(/inteiro numérico/);
});

test('N35-8-ID-07: GC_NATIVE rejeita gestaoClickId ausente', () => {
  expect(() =>
    buildCommercialEntityId({ source: 'GC_NATIVE' })
  ).toThrow(/gestaoClickId obrigatório/);
});

test('N35-8-ID-08: source inválido lança erro', () => {
  expect(() =>
    buildCommercialEntityId({ source: 'DESCONHECIDO', mr4ClientId: 'x' })
  ).toThrow(/source inválido/);
});

// ── parseCommercialEntityId ───────────────────────────────────────────────────

test('N35-8-ID-09: parse extrai source e stableId de MR4_LINKED', () => {
  const { source, stableId } = parseCommercialEntityId('MR4_LINKED:abc123XYZ0987654321A');
  expect(source).toBe('MR4_LINKED');
  expect(stableId).toBe('abc123XYZ0987654321A');
});

test('N35-8-ID-10: parse extrai source e stableId de GC_NATIVE', () => {
  const { source, stableId } = parseCommercialEntityId('GC_NATIVE:31349459');
  expect(source).toBe('GC_NATIVE');
  expect(stableId).toBe('31349459');
});

test('N35-8-ID-11: parse lança erro em formato inválido', () => {
  // sem ':' → formato inválido
  expect(() => parseCommercialEntityId('SEMPREFIX')).toThrow(/formato inválido/);
  // com ':' mas source desconhecido
  expect(() => parseCommercialEntityId('DESCONHECIDO:abc')).toThrow(/source desconhecido/);
  expect(() => parseCommercialEntityId('')).toThrow();
});

// ── commercialEntityIdFromPerfil360 ──────────────────────────────────────────

test('N35-8-ID-12: fromPerfil360 MR4_LINKED usa clienteMr4Id', () => {
  const id = commercialEntityIdFromPerfil360({
    source:        'MR4_LINKED',
    clienteMr4Id:  'abc123XYZ0987654321A',
    gestaoClickId: '99999',
  });
  expect(id).toBe('MR4_LINKED:abc123XYZ0987654321A');
});

test('N35-8-ID-13: fromPerfil360 GC_NATIVE usa gestaoClickId (não clienteMr4Id)', () => {
  const id = commercialEntityIdFromPerfil360({
    source:        'GC_NATIVE',
    clienteMr4Id:  '31349459',     // alias para gestaoClickId no pipeline — mas aqui usamos gestaoClickId real
    gestaoClickId: '31349459',
  });
  expect(id).toBe('GC_NATIVE:31349459');
});

test('N35-8-ID-14: fromPerfil360 GC_NATIVE sem gestaoClickId lança erro', () => {
  expect(() =>
    commercialEntityIdFromPerfil360({ source: 'GC_NATIVE', clienteMr4Id: '31349459' })
  ).toThrow(/GC_NATIVE sem gestaoClickId/);
});

test('N35-8-ID-15: fromPerfil360 sem source trata como MR4_LINKED (legado)', () => {
  const id = commercialEntityIdFromPerfil360({ clienteMr4Id: 'abc123XYZ0987654321A' });
  expect(id).toBe('MR4_LINKED:abc123XYZ0987654321A');
});

// ── buildOpportunityInstanceId ────────────────────────────────────────────────

test('N35-8-ID-16: opportunityInstanceId é determinístico', () => {
  const id1 = buildOpportunityInstanceId('MR4_LINKED:abc123', 'REATIVACAO_120D', '2026-08-01');
  const id2 = buildOpportunityInstanceId('MR4_LINKED:abc123', 'REATIVACAO_120D', '2026-08-01');
  expect(id1).toBe(id2);
  expect(id1).toMatch(/^[0-9a-f]{16}$/);
});

test('N35-8-ID-17: opportunityInstanceId muda com nova ultimaCompraEm', () => {
  const id1 = buildOpportunityInstanceId('MR4_LINKED:abc123', 'REATIVACAO_120D', '2026-08-01');
  const id2 = buildOpportunityInstanceId('MR4_LINKED:abc123', 'REATIVACAO_120D', '2026-09-15');
  expect(id1).not.toBe(id2);
});

test('N35-8-ID-18: opportunityInstanceId usa NUNCA_COMPROU para ultimaCompraEm null', () => {
  const idNull   = buildOpportunityInstanceId('GC_NATIVE:31349459', 'PROSPECT_VINCULADO', null);
  const idNunca  = buildOpportunityInstanceId('GC_NATIVE:31349459', 'PROSPECT_VINCULADO', null);
  const idComDt  = buildOpportunityInstanceId('GC_NATIVE:31349459', 'PROSPECT_VINCULADO', '2026-01-01');
  expect(idNull).toBe(idNunca);
  expect(idNull).not.toBe(idComDt);
  expect(idNull).toMatch(/^[0-9a-f]{16}$/);
});

test('N35-8-ID-19: opportunityInstanceId muda com tipo diferente', () => {
  const id1 = buildOpportunityInstanceId('MR4_LINKED:abc123', 'JANELA_DE_RECOMPRA', '2026-08-01');
  const id2 = buildOpportunityInstanceId('MR4_LINKED:abc123', 'REATIVACAO_120D', '2026-08-01');
  expect(id1).not.toBe(id2);
});

// ── validateIdentity ──────────────────────────────────────────────────────────

test('N35-8-ID-20: validateIdentity retorna valid=true para MR4_LINKED válido', () => {
  const result = validateIdentity({ source: 'MR4_LINKED', clienteMr4Id: 'abc123XYZ0987654321A' });
  expect(result.valid).toBe(true);
  expect(result.commercialEntityId).toBe('MR4_LINKED:abc123XYZ0987654321A');
  expect(result.error).toBeNull();
});

test('N35-8-ID-21: validateIdentity retorna valid=true para GC_NATIVE válido', () => {
  const result = validateIdentity({ source: 'GC_NATIVE', gestaoClickId: '31349459' });
  expect(result.valid).toBe(true);
  expect(result.commercialEntityId).toBe('GC_NATIVE:31349459');
});

test('N35-8-ID-22: validateIdentity retorna valid=false para GC_NATIVE sem gestaoClickId', () => {
  const result = validateIdentity({ source: 'GC_NATIVE', clienteMr4Id: '31349459' });
  expect(result.valid).toBe(false);
  expect(result.commercialEntityId).toBeNull();
  expect(result.error).toMatch(/GC_NATIVE sem gestaoClickId/);
});

test('N35-8-ID-23: sem colisão entre namespace MR4 e GC (IDs do mesmo valor numérico)', () => {
  // GC_ID 31349459 nunca colide com um hipotético mr4ClientId "31349459" (que seria rejeitado)
  const gcId  = buildCommercialEntityId({ source: 'GC_NATIVE',  gestaoClickId: '31349459' });
  // base62 válido com dígitos e letras
  const mr4Id = buildCommercialEntityId({ source: 'MR4_LINKED', mr4ClientId: 'a31349459bbbbbbbbbbb' });
  expect(gcId).not.toBe(mr4Id);
  expect(gcId.startsWith('GC_NATIVE:')).toBe(true);
  expect(mr4Id.startsWith('MR4_LINKED:')).toBe(true);
});

test('N35-8-ID-24: SOURCES enum está frozen e contém os dois tipos', () => {
  expect(Object.isFrozen(SOURCES)).toBe(true);
  expect(SOURCES.MR4_LINKED).toBe('MR4_LINKED');
  expect(SOURCES.GC_NATIVE).toBe('GC_NATIVE');
});

test('N35-8-ID-25: ANCHOR_NUNCA é constante não-vazia', () => {
  expect(typeof ANCHOR_NUNCA).toBe('string');
  expect(ANCHOR_NUNCA.length).toBeGreaterThan(0);
});
