'use strict';
// Varredura do webhook (WHK-01/03), caixa de saída do modo ATIVO e conferência de loja (WHK-02).
const V = require('../lib/webhooks/varredura');
const R = require('../lib/webhooks/receptor');
const { dbWebhook, loggerFalso } = require('./fixtures/webhook-db');

const MIN = 60000, H = 60 * MIN, AG = Date.parse('2026-11-26T12:00:00Z');
const ev = (extra = {}) => ({ evento: 'recebimento.baixado', recurso: 'recebimentos', registro_id: '7', loja_id: '262759', recebido_ms: AG - 10 * MIN, status: 'SOMBRA_CONCLUIDA', resultado: 'CONFERIDO', ...extra });
function cena({ modo = 'ATIVO', eventos = {}, extra = {} } = {}) {
  const db = dbWebhook({ ...(modo === null ? {} : { gc_webhook_config: { estado: { modo } } }), gc_webhook_eventos: eventos, ...extra });
  const logger = loggerFalso(); const n = { buscar: 0, job: 0, fin: 0 };
  const dep = { db, logger, buscar: async () => { n.buscar++; return { status: 200, loja_id: '262759' }; }, dispararJob: async () => { n.job++; }, dispararFinanceiro: async () => { n.fin++; } };
  return { db, logger, n, dep, rodar: (agora = AG, mais = {}) => V.executarVarredura({ ...dep, ...mais, agora: () => agora }) };
}
const pendente = (extra = {}) => ev({ status: 'PENDENTE_SOMBRA', resultado: 'FALHA_CONSULTA', efeito: 'PENDENTE', ...extra });

describe('DESLIGADO/RECEPCAO: no-op barata', () => {
  test.each([null, 'DESLIGADO', 'RECEPCAO', 'INVALIDO'])('modo %s ⇒ 1 leitura, 0 gravações, nada consultado nem disparado', async modo => {
    const c = cena({ modo, eventos: { a: pendente() }, extra: { gc_refresh_fila: { financeiro_n1: { pendente: true, ultimoEventoMs: AG - H } } } });
    expect((await c.rodar()).acao).toBe('NADA'); expect(c.db.n).toEqual({ leituras: 1, gravacoes: 0 }); expect(c.n).toEqual({ buscar: 0, job: 0, fin: 0 }); expect(c.logger.linhas).toEqual([]);
  });
  test('configuração ilegível ⇒ nada (fail-closed)', async () => {
    const c = cena(); c.db.falhar = () => { throw new Error('UNAVAILABLE'); }; expect((await c.rodar()).acao).toBe('NADA'); expect(c.n).toEqual({ buscar: 0, job: 0, fin: 0 });
  });
});

describe('custo ocioso', () => {
  test.each([['SOMBRA', 4], ['ATIVO', 6]])('%s sem pendências: %i leituras e nenhuma gravação', async (modo, leituras) => {
    const c = cena({ modo, eventos: { a: ev() } }); await c.rodar(); expect(c.db.n).toEqual({ leituras, gravacoes: 0 }); expect(c.logger.alertas()).toEqual([]);
  });
});

describe('SOMBRA (WHK-01)', () => {
  test('repete a conferência pendente SEM efeito operacional (nem com efeito/pendência gravados)', async () => {
    const c = cena({ modo: 'SOMBRA', eventos: { a: pendente() }, extra: { gc_refresh_fila: { financeiro_n1: { pendente: true, ultimoEventoMs: AG - H } } } });
    await c.rodar(); expect(c.db.st.gc_webhook_eventos.a).toMatchObject({ status: 'SOMBRA_CONCLUIDA', resultado: 'CONFERIDO', tentativas_sombra: 1, efeito: 'PENDENTE' });
    expect(c.n).toEqual({ buscar: 1, job: 0, fin: 0 }); expect(Object.keys(c.db.st.gc_refresh_fila)).toEqual(['financeiro_n1']); expect(c.db.st.gc_refresh_fila.financeiro_n1.ultimoPedidoMs).toBeUndefined();
  });
  test('falha temporária: espera dobrada entre tentativas e, após 5, SOMBRA_FALHA com alerta (nada apagado)', async () => {
    const c = cena({ modo: 'SOMBRA', eventos: { a: pendente({ recebido_ms: AG }) } }); const buscar = async () => { c.n.buscar++; throw new Error('503'); }; const quando = [];
    for (let m = 10; m <= 400; m += 10) { const antes = c.n.buscar; await c.rodar(AG + m * MIN, { buscar }); if (c.n.buscar > antes) quando.push(m); }
    expect(quando).toEqual([10, 20, 40, 80, 160]); expect(c.db.st.gc_webhook_eventos.a).toMatchObject({ status: 'SOMBRA_FALHA', resultado: 'FALHA_CONSULTA_DEFINITIVA' });
    expect(c.logger.alertas().some(l => l.motivos.includes('SOMBRA_FALHA_DEFINITIVA') && l.nivel === 'error')).toBe(true);
    expect(c.logger.alertas().some(l => l.motivos.includes('SOMBRA_PENDENTES_ATRASADOS'))).toBe(true);
  });
  test('orçamento de tempo interrompe a rodada sem consumir tentativas', async () => {
    const c = cena({ modo: 'SOMBRA', eventos: { a: pendente(), b: pendente() } }); let t = AG;
    const r = await R.reprocessarPendentes({ db: c.db, buscar: async () => { t += 200000; return { status: 200, loja_id: '262759' }; }, agora: () => t, orcamentoMs: 150000 });
    expect(r.tentados).toBe(1); expect(c.db.st.gc_webhook_eventos.b.tentativas_sombra).toBeUndefined();
  });
});

describe('ATIVO: recuperação e borda final', () => {
  test('efeito não confirmado (processador interrompido) é reaplicado uma vez; um único disparo do Job', async () => {
    const c = cena({ eventos: { a: pendente({ status: 'SOMBRA_CONCLUIDA' }), b: ev({ evento: 'venda.cadastrada', recurso: 'vendas', efeito: 'PENDENTE' }), novo: ev({ efeito: 'PENDENTE', recebido_ms: AG - MIN }) } });
    const r = await c.rodar(); expect(r.efeitos.recuperados).toBe(2); expect(c.n).toMatchObject({ job: 1, fin: 1 });
    expect(c.db.st.gc_webhook_eventos.a.efeito).toBe('APLICADO'); expect(c.db.st.gc_webhook_eventos.novo.efeito).toBe('PENDENTE');
    expect(Object.keys(c.db.st.gc_refresh_fila.lote.blocos).sort()).toEqual(['financeiro', 'pedidos', 'perfil360', 'vendas']);
    expect(c.db.st.gc_refresh_fila.financeiro_n1).toMatchObject({ pendente: true, ultimoEventoMs: AG - 10 * MIN });
  });
  test('falha persistente ao registrar: mantém pendente, tenta 5 vezes e marca FALHA com alerta', async () => {
    const c = cena({ eventos: { a: ev({ efeito: 'PENDENTE', recebido_ms: AG - H }) } });
    c.db.falhar = ({ op, c: col }) => { if (op === 'txget' && col === 'gc_refresh_fila') throw new Error('ABORTED'); };
    for (let i = 0; i < 5; i++) { await c.rodar(AG + i * 10 * MIN); expect(c.db.st.gc_webhook_eventos.a.efeito).toBe('PENDENTE'); }
    await c.rodar(AG + H); expect(c.db.st.gc_webhook_eventos.a.efeito).toBe('FALHA'); expect(c.logger.alertas().some(l => l.motivos.includes('EFEITO_FALHA_DEFINITIVA'))).toBe(true);
  });
  test('processador → coalescido → varredura dispara após a janela → publicação confirma', async () => {
    const c = cena(); const efeito = async (id, m) => { const evDoc = ev({ efeito: 'PENDENTE', recebido_ms: AG + m * MIN }); c.db.st.gc_webhook_eventos[id] = evDoc; return V.aplicarEfeito({ ...c.dep, modo: 'ATIVO', id, evDoc, agoraMs: AG + m * MIN }); };
    expect((await efeito('e1', 0)).financeiroN1).toBe('DISPARADO'); expect((await efeito('e2', 5)).financeiroN1).toBe('COALESCIDO'); expect(c.db.st.gc_webhook_eventos.e2.efeito).toBe('APLICADO');
    c.db.st.fin_n1 = { active: { geracao: 'g1', publicado_em: new Date(AG + MIN).toISOString() } };
    expect((await c.rodar(AG + 30 * MIN)).financeiro).toBe('DISPARADO'); expect(c.n.fin).toBe(2);
    c.db.st.fin_n1.active = { geracao: 'g2', publicado_em: new Date(AG + 31 * MIN).toISOString() };
    expect((await c.rodar(AG + 40 * MIN)).financeiro).toBe('CONFIRMADO');
  });
  test('falha de uma etapa não impede as demais e é alertada', async () => {
    const c = cena({ eventos: { a: pendente({ efeito: undefined }) } });
    c.db.falhar = ({ c: col }) => { if (col === 'gc_refresh_fila') throw new Error('UNAVAILABLE'); };
    const r = await c.rodar(); expect(r.erros).toEqual(['FINANCEIRO']); expect(c.n.buscar).toBe(1); expect(c.logger.alertas()[0]).toMatchObject({ nivel: 'error', motivos: ['ERRO_ETAPA_FINANCEIRO'] });
  });
  test('sem permissão para disparar (situação atual) ⇒ alerta de falha e de tentativas esgotadas', async () => {
    const c = cena({ eventos: { a: ev({ recebido_ms: AG }) }, extra: { gc_refresh_fila: { financeiro_n1: { pendente: true, ultimoEventoMs: AG, pendenteDesdeMs: AG } } } });
    for (let m = 10; m <= 800; m += 10) await c.rodar(AG + m * MIN, { dispararFinanceiro: async () => { throw new Error('403'); } });
    const todos = new Set(c.logger.alertas().flatMap(l => l.motivos)); for (const m of ['FINANCEIRO_FALHA_DISPARO', 'FINANCEIRO_TENTATIVAS_ESGOTADAS', 'FINANCEIRO_PENDENTE_ATRASADO']) expect(todos.has(m)).toBe(true);
    expect(c.logger.alertas().length).toBeLessThan(10);
  });
});

describe('monitor de silêncio (WHK-03)', () => {
  test('avisa uma vez, repete a cada 6 h e registra a recuperação', async () => {
    const c = cena({ modo: 'SOMBRA', eventos: { a: ev({ recebido_ms: AG - 25 * H }) } });
    await c.rodar(AG); await c.rodar(AG + 10 * MIN); expect(c.logger.alertas()).toHaveLength(1); expect(c.logger.alertas()[0]).toMatchObject({ alerta: 'WEBHOOK_GC', nivel: 'error', motivos: ['SILENCIO_24H'] });
    await c.rodar(AG + 6 * H); expect(c.logger.alertas()).toHaveLength(2);
    c.db.st.gc_webhook_eventos.b = ev({ recebido_ms: AG + 7 * H }); await c.rodar(AG + 7 * H); expect(c.logger.alertas()[2].tipo).toBe('RECUPERADO');
  });
  test('nunca recebeu: carência de 24 h a partir de quando o modo foi ligado', async () => {
    const c = cena({ modo: 'SOMBRA' }); c.db.st.gc_webhook_config.estado.atualizadoEm = new Date(AG).toISOString();
    await c.rodar(AG + H); expect(c.logger.alertas()).toEqual([]); await c.rodar(AG + 25 * H); expect(c.logger.alertas()[0].motivos).toEqual(['NUNCA_RECEBEU']);
  });
  test('alertas só com códigos, contagens e horas', async () => {
    const c = cena({ modo: 'SOMBRA' }); await c.rodar(); expect(JSON.stringify(c.logger.linhas)).not.toMatch(/registro_id|cliente|valor|token/i);
  });
});

describe('caixa de saída no receptor', () => {
  const receber = async modo => {
    const crypto = require('crypto'); const db = dbWebhook({ gc_webhook_config: { estado: { modo } } }); const corpo = Buffer.from(JSON.stringify({ id: 'x1', evento: 'recebimento.baixado', loja_id: '262759', dados: { id: '1' } })); const t = Math.floor(AG / 1000);
    const sig = `t=${t},v1=${crypto.createHmac('sha256', 'segredo-de-teste').update(`${t}.`).update(corpo).digest('hex')}`;
    await R.tratarRequisicao({ req: { metodo: 'POST', cabecalhos: { 'x-webhook-assinatura': sig }, corpoCru: corpo }, db, segredo: 'segredo-de-teste', lerConfig: R.criarLeitorConfig({ db }), agora: () => AG });
    return db.st.gc_webhook_eventos.x1;
  };
  test('só em ATIVO o aviso nasce com efeito PENDENTE', async () => { expect((await receber('ATIVO')).efeito).toBe('PENDENTE'); for (const m of ['RECEPCAO', 'SOMBRA']) expect((await receber(m)).efeito).toBeUndefined(); });
});

describe('conferência de loja (WHK-02)', () => {
  const rodar = async (recurso, resposta) => { const db = dbWebhook({ gc_webhook_eventos: { a: pendente({ recurso }) } }); const out = await R.processarSombra({ db, id: 'a', buscar: async () => resposta }); return { codigo: out.codigo, doc: db.st.gc_webhook_eventos.a }; };
  test('venda é conferida pelo nome_loja (única informação que ela traz)', async () => {
    let x = await rodar('vendas', { status: 200, nome_loja: ' Mr4  Distribuidora ' }); expect(x.codigo).toBe('CONFERIDO'); expect(x.doc.conferencia_loja).toBe('NOME');
    x = await rodar('vendas', { status: 200, nome_loja: 'FOCUS PARTS' }); expect(x.codigo).toBe('LOJA_DIVERGENTE');
    x = await rodar('vendas', { status: 200 }); expect(x.codigo).toBe('LOJA_NAO_VERIFICADA');
    expect(JSON.stringify(x.doc)).not.toMatch(/nome_loja|FOCUS|Distribuidora/i);
  });
  test('loja_id, quando existe, manda; título sem dados de loja segue conferido pelo aviso', async () => {
    expect((await rodar('recebimentos', { status: 200, loja_id: '424483', nome_loja: 'MR4 DISTRIBUIDORA' })).codigo).toBe('LOJA_DIVERGENTE');
    expect((await rodar('recebimentos', { status: 200 })).doc).toMatchObject({ resultado: 'CONFERIDO', conferencia_loja: 'AUSENTE' });
  });
});
