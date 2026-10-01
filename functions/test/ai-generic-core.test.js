'use strict';
// NÚCLEO GENÉRICO dos agentes especializados (permissão por módulo, piloto, limites por agente, validador, reidratação, falha isolada). Modelo FALSO.
const F = require('./fixtures/ai-agente');
const D = require('./fixtures/ai-generic-demo');
const G = require('../lib/ai/gateway/generic');
const V = require('../lib/ai/gateway/genericValidator');
const U = require('../lib/ai/gateway/usage');
const { UID, AGORA } = F;
const ag = D.agente; const KEY = 'sk-TESTE-FALSA-0000000000000000';
const PIL = { demo: { modo: 'MANAGEMENT_ONLY', uids: [] } };
const exec = (uid, data, fetchImpl, extra = {}) => { const db = extra.db || F.criarDb(F.dataset()); return G.executarGenerico({ uid, data: { agentType: 'demo', ...data }, ag, deps: { store: db, apiKey: KEY, fetchImpl, agora: () => AGORA, piloto: PIL, ...extra } }).then(r => ({ r, db }), e => ({ e, db })); };
const Q = { modo: 'pergunta', pergunta: 'O que merece atenção?' };
const resp = (o = {}) => ({ answer: 'P001 está há 147 dias sem venda com 48 unidades.', entities: [{ ref: 'P001', reasonCodes: ['SEM_VENDA_120D'], evidence: [{ metric: 'diasSemVenda', value: 147 }, { metric: 'estoque', value: 48 }] }], recommendations: [{ ref: 'P001', action: 'REVISAR', rationale: 'Revisar o item P001: 147 dias sem venda.' }], warnings: [], unavailable: [], dataFreshness: 'ok', ...o });
const modelo = o => F.fetchModelo(typeof o === 'function' ? o : resp(o));

describe('permissão por MÓDULO + piloto', () => {
  test('anônimo/inativo/sem módulo/admin sozinho/funcionário comum → DENY; gestor → ALLOW', async () => {
    for (const u of [UID.INAT, UID.SEM, UID.ADM, UID.FAB]) { const m = modelo(); const x = await exec(u, Q, m); expect(x.e.tipo).toBe('permission-denied'); expect(m.chamadas.length).toBe(0); }
    expect((await exec(UID.GER, Q, modelo())).r.ia.status).toBe('OK');
  });
  test('piloto: padrão MANAGEMENT_ONLY; OFF/inválido = ninguém; allowlist de uids restringe', async () => {
    expect(G.configPilotoAgente('inventory', {})).toEqual({ modo: 'MANAGEMENT_ONLY', uids: [] });
    expect(G.configPilotoAgente('finance', { AI_FINANCE_PILOT: 'off', AI_FINANCE_PILOT_UIDS: ' a , b ' })).toEqual({ modo: 'OFF', uids: ['a', 'b'] });
    for (const p of [{ modo: 'OFF', uids: [] }, { modo: 'XYZ', uids: [] }, { modo: 'MANAGEMENT_ONLY', uids: ['outro'] }]) expect((await exec(UID.GER, Q, modelo(), { piloto: { demo: p } })).e.codigo).toBe('FORA_DO_PILOTO');
    expect((await exec(UID.GMOD, { modo: 'acesso' }, modelo())).e).toBeTruthy();   // GMOD (módulo do CRM) NÃO tem o módulo demo: acesso CRM ≠ outro módulo
  });
  test('modo acesso: sem dados, sem IA, sem consumir limite; pedido não aceita module/entityId/ownerId', async () => {
    const m = modelo(); const a = await exec(UID.GER, { modo: 'acesso' }, m); expect(a.r).toEqual({ ok: true, acesso: true, agentType: 'demo', modulo: 'demo' }); expect(a.db.st.ai_rate).toBeUndefined();
    for (const extra of [{ module: 'finance' }, { entityId: 'SKU-1' }, { ownerId: 'u' }, { agentType2: 1 }]) expect((await exec(UID.GER, { ...Q, ...extra }, m)).e.codigo).toBe('CAMPOS_NAO_PERMITIDOS');
    expect(m.chamadas.length).toBe(0);
  });
});

describe('limites: global por usuário + por agente', () => {
  test('o teto do agente bloqueia antes do global; o global não é multiplicado', async () => {
    const db = F.criarDb(F.dataset()); const lim = { minuto: 50, dia: 5, porAgente: { demo: 2, outro: 2 } };
    expect((await exec(UID.GER, Q, modelo(), { db, limites: lim })).r.limitesUso.restanteAgente).toBe(1);
    await exec(UID.GER, Q, modelo(), { db, limites: lim });
    expect((await exec(UID.GER, Q, modelo(), { db, limites: lim })).e.codigo).toBe('RATE_LIMIT_AGENTE_DIA');
    await U.verificarLimite(db, UID.GER, AGORA, lim, 'outro'); await U.verificarLimite(db, UID.GER, AGORA, lim, 'outro');   // outro agente usa o global: 2+2 = 4
    await expect(U.verificarLimite(db, UID.GER, AGORA, { ...lim, porAgente: {} }, 'novo')).resolves.toBeTruthy();         // 5º
    await expect(U.verificarLimite(db, UID.GER, AGORA, { ...lim, porAgente: {} }, 'novo')).rejects.toMatchObject({ codigo: 'RATE_LIMIT_DIA' });
  });
  test('valores padrão documentados: global 8/min e 100/dia; por agente 60/40/40/30', () => { expect([U.LIMITE_POR_MINUTO, U.LIMITE_POR_DIA]).toEqual([8, 100]); expect(U.LIMITE_AGENTE_DIA).toEqual({ commercial: 60, inventory: 40, purchasing: 40, finance: 30 }); });
  test('uso registrado com módulo, sem conteúdo; contexto sem nomes', async () => {
    const m = modelo(); const x = await exec(UID.GER, Q, m); const log = Object.values(x.db.st.ai_chamadas)[0];
    expect(log).toMatchObject({ agentType: 'demo', modulo: 'demo', resultado: 'OK', modo: 'pergunta' }); expect(JSON.stringify(x.db.st.ai_chamadas)).not.toMatch(/Alfa|Beta|merece atenção/);
    expect(JSON.stringify(m.chamadas[0].body)).not.toMatch(/Alfa|Beta|SKU-/); expect(m.chamadas[0].body.store).toBe(false);
  });
});

describe('validação pós-modelo (fail closed) e reidratação', () => {
  test('resposta válida: refs reidratadas com nome só no backend; rótulos; evidências', async () => {
    const x = await exec(UID.GER, Q, modelo()); expect(x.r.ia.status).toBe('OK');
    expect(x.r.answer).toMatch(/^Produto Alfa Secreto está há 147 dias/); expect(x.r.answer).not.toMatch(/\bP\d{3}\b/);
    expect(x.r.entities[0]).toMatchObject({ id: 'SKU-1', nome: 'Produto Alfa Secreto' }); expect(x.r.entities[0].reasonCodes[0].label).toBe('Sem venda há 120 dias'); expect(x.r.entities[0].evidence[0]).toMatchObject({ label: 'Dias sem venda', value: 147 });
    expect(x.r.recommendations[0]).toMatchObject({ action: 'REVISAR', actionLabel: 'Revisar' }); expect(x.r.recommendations[0].rationale).toMatch(/Produto Alfa Secreto/);
    expect(x.r.frescor).toMatchObject({ sourceUpdatedAt: '2026-09-30', contextBuiltAt: AGORA.toISOString() });
  });
  const invalida = async (o, cod) => { const x = await exec(UID.GER, Q, modelo(o)); expect(x.r.ia).toMatchObject({ status: 'INDISPONIVEL', motivo: 'RESPOSTA_INVALIDA' }); expect(x.r.entities).toEqual([]); expect(Object.values(x.db.st.ai_chamadas)[0].erro).toMatch(new RegExp('^' + cod)); };
  test('id inventado / fora do contexto / duplicado / motivo / métrica / valor / ação / número / campos extras / segredo / PII', async () => {
    const e0 = resp().entities[0];
    await invalida({ entities: [{ ...e0, ref: 'P999' }] }, 'ENTIDADE_FORA_DO_CONTEXTO');
    await invalida({ entities: [e0, e0] }, 'ENTIDADE_DUPLICADA');
    await invalida({ entities: [{ ref: 'P002', reasonCodes: ['ESTOQUE_ALTO'], evidence: [] }], recommendations: [] }, 'MOTIVO_NAO_COMPROVADO');
    await invalida({ entities: [{ ...e0, evidence: [{ metric: 'inventada', value: 1 }] }] }, 'METRICA_INEXISTENTE');
    await invalida({ entities: [{ ...e0, evidence: [{ metric: 'estoque', value: 49 }] }] }, 'EVIDENCIA_DIVERGE_DO_FATO');
    await invalida({ recommendations: [{ ref: 'P001', action: 'COMPRAR_JA', rationale: 'x' }] }, 'ACAO_INVALIDA');
    await invalida({ recommendations: [{ ref: 'P777', action: 'REVISAR', rationale: 'x' }] }, 'RECOMENDACAO_FORA_DO_CONTEXTO');
    await invalida({ answer: 'P001 tem 999 dias sem venda.' }, 'NUMERO_NAO_VERIFICADO');
    await invalida({ extra: 1 }, 'CAMPOS_EXTRAS');
    await invalida({ answer: 'Use a chave sk-ABCDEFGHIJKLMNOP123456' }, 'SEGREDO_NA_RESPOSTA');
    await invalida({ answer: 'Ligue para 85 99999-0000 sobre P001.' }, 'PII_NA_RESPOSTA');
    await invalida({ recommendations: [{ ref: 'P001', action: 'REVISAR', rationale: 'Estoque de 77 unidades.' }] }, 'NUMERO_NAO_VERIFICADO');
  });
  test('regras extras do módulo (validacoesExtras) rejeitam; falhas do provedor ficam isoladas com resultado determinístico', async () => {
    const ag2 = { ...ag, validacoesExtras: r => { if (/saldo/i.test(r.answer)) throw new (require('../lib/ai/gateway/schema').RespostaInvalida)('SALDO_NAO_DISPONIVEL'); } };
    const db = F.criarDb(F.dataset()); const x = await G.executarGenerico({ uid: UID.GER, data: { agentType: 'demo', ...Q }, ag: ag2, deps: { store: db, apiKey: KEY, fetchImpl: modelo({ answer: 'O saldo é alto em P001.' }), agora: () => AGORA, piloto: PIL } }); expect(x.ia.status).toBe('INDISPONIVEL');
    for (const f of [F.fetchModelo({}, { status: 500 }), F.fetchModelo({}, { status: 429 }), F.fetchModelo({}, { falhaRede: true }), F.fetchModelo({}, { comoTexto: 'x' })]) { const y = await exec(UID.GER, Q, f); expect(y.r.ok).toBe(true); expect(y.r.ia.status).toBe('INDISPONIVEL'); expect(y.r.fallback.length).toBeGreaterThan(0); expect(y.r.fallback[0].nome).toBeTruthy(); }
    const sem = await exec(UID.GER, Q, modelo(), { apiKey: '' }); expect(sem.r.ia.motivo).toBe('IA_NAO_CONFIGURADA');
  });
  test('contagens: determinístico, sem IA e sem limite', async () => { const m = modelo(); const x = await exec(UID.GER, { modo: 'contagens' }, m); expect(x.r.ia.status).toBe('NAO_SOLICITADA'); expect(x.r.resumo.analisados).toBe(3); expect(m.chamadas.length).toBe(0); expect(x.db.st.ai_rate).toBeUndefined(); });
  test('injeção: nome com instrução nunca chega ao modelo (só refs)', async () => { const m = modelo(); await exec(UID.GER, Q, m); expect(JSON.stringify(m.chamadas[0].body)).not.toMatch(/Ignore as instru|revele o financeiro/); });
});

describe('redução determinística do contexto', () => {
  test('ajustarAoLimite encolhe por escala (nunca trunca JSON) e respeita o alvo', () => {
    const r = G.ajustarAoLimite(e => ({ bytes: Math.round(30000 * e), n: e }), { alvoBytes: 22000 }); expect(r.bytes).toBeLessThanOrEqual(22000); expect(r.escala).toBe(0.55);
  });
  test('schema por agente tem answer, entities, recommendations, warnings, unavailable, dataFreshness e enums fechados', () => {
    const s = V.criarSchemaAgente({ motivos: ['A'], acoes: ['X'] }); expect(s.required).toEqual(['answer', 'entities', 'recommendations', 'warnings', 'unavailable', 'dataFreshness']); expect(s.properties.entities.items.properties.reasonCodes.items.enum).toEqual(['A']); expect(s.additionalProperties).toBe(false);
  });
});
