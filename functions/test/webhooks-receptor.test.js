'use strict';
const crypto = require('crypto');
const W = require('../lib/webhooks/receptor');
const SEG = 'segredo-de-teste-apenas', AG = Date.parse('2026-11-25T12:00:00Z'), T = Math.floor(AG / 1000);
const assinar = (corpo, t = T, seg = SEG) => `t=${t},v1=${crypto.createHmac('sha256', seg).update(`${t}.`).update(corpo).digest('hex')}`;
const aviso = (extra = {}) => ({ id: 'a1b2c3d4-0001', evento: 'venda.cadastrada', versao: '1', ocorrido_em: '2026-11-25T08:59:00-03:00', empresa_id: '9', loja_id: '262759', recurso: 'vendas', dados: { id: '555', codigo: '1234', nome_cliente: 'CLIENTE SECRETO', valor_total: '999.99' }, ...extra });
function fakeDb(config) {
  const st = { eventos: {}, config }; const criados = [];
  return { st, criados, collection: nome => ({ doc: id => ({
    get: async () => nome === W.COL_CONFIG ? { exists: !!st.config, data: () => st.config } : { exists: st.eventos[id] !== undefined, data: () => st.eventos[id] },
    create: async d => { if (st.eventos[id]) { const e = new Error('ALREADY_EXISTS'); e.code = 6; throw e; } st.eventos[id] = d; criados.push(id); },
    set: async (d, o) => { st.eventos[id] = { ...(st.eventos[id] || {}), ...d }; } }) }) };
}
async function enviar({ cfg = { modo: 'SOMBRA' }, corpo = aviso(), mut = {}, segredo = SEG, db = fakeDb(cfg), agora = AG } = {}) {
  const crua = Buffer.from(typeof corpo === 'string' ? corpo : JSON.stringify(corpo)); const logs = [];
  const req = { metodo: 'POST', cabecalhos: { 'x-webhook-assinatura': assinar(crua), 'x-webhook-id': 'a1b2c3d4-0001', 'x-webhook-evento': 'venda.cadastrada', 'x-webhook-tentativa': '1', ...mut.cab }, corpoCru: mut.corpoCru || crua, ...mut.req };
  const r = await W.tratarRequisicao({ req, db, segredo, lerConfig: W.criarLeitorConfig({ db, agora: () => agora }), agora: () => agora, log: l => logs.push(l), serverTimestamp: () => 'TS' });
  return { ...r, db, logs };
}

describe('assinatura', () => {
  test('válida passa; corpo adulterado, segredo errado, formato errado ⇒ 401', async () => {
    expect((await enviar()).status).toBe(200);
    expect((await enviar({ mut: { corpoCru: Buffer.from(JSON.stringify(aviso({ id: 'x' }))) } })).status).toBe(401);
    expect((await enviar({ segredo: 'outro' })).status).toBe(401);
    expect((await enviar({ mut: { cab: { 'x-webhook-assinatura': 'lixo' } } })).status).toBe(401);
    expect((await enviar({ mut: { cab: { 'x-webhook-assinatura': undefined } } })).status).toBe(401);
  });
  test('replay: t com mais de 5 min (passado ou futuro) ⇒ 401 FORA_DA_JANELA; dentro da janela passa', async () => {
    const crua = JSON.stringify(aviso());
    for (const dt of [-301, 301]) expect((await enviar({ corpo: crua, mut: { cab: { 'x-webhook-assinatura': assinar(Buffer.from(crua), T + dt) } } })).corpo.codigo).toBe('FORA_DA_JANELA');
    expect((await enviar({ corpo: crua, mut: { cab: { 'x-webhook-assinatura': assinar(Buffer.from(crua), T - 299) } } })).status).toBe(200);
  });
  test('sem segredo configurado ⇒ 503 (o GC repete); nunca aceita sem validar', async () => { expect((await enviar({ segredo: '' })).status).toBe(503); });
  test('assinatura calculada sobre o CORPO CRU (espaços/ordem de chaves importam)', async () => {
    const crua = '{ "id":"a1b2c3d4-0001", "evento":"venda.cadastrada","loja_id":"262759","dados":{"id":"555"} }';
    expect((await enviar({ corpo: crua })).status).toBe(200);
    expect((await enviar({ corpo: crua, mut: { corpoCru: Buffer.from(crua.replace(' ', '  ')) } })).status).toBe(401);
  });
});

describe('modos e kill switch', () => {
  test('DESLIGADO (e configuração ausente/ilegível/modo inválido) ⇒ 200 sem validar nem gravar', async () => {
    for (const cfg of [{ modo: 'DESLIGADO' }, null, { modo: 'QUALQUER' }]) { const r = await enviar({ cfg, segredo: 'errado' }); expect(r.status).toBe(200); expect(r.corpo.codigo).toBe('DESLIGADO'); expect(r.db.criados).toEqual([]); }
    const db = fakeDb({ modo: 'SOMBRA' }); db.collection = () => ({ doc: () => ({ get: async () => { throw new Error('UNAVAILABLE'); } }) });
    const r = await enviar({ db }); expect(r.corpo.codigo).toBe('DESLIGADO');
  });
  test('RECEPCAO grava como RECEBIDO; SOMBRA grava como PENDENTE_SOMBRA', async () => {
    expect((await enviar({ cfg: { modo: 'RECEPCAO' } })).db.st.eventos['a1b2c3d4-0001'].status).toBe('RECEBIDO');
    expect((await enviar({ cfg: { modo: 'SOMBRA' } })).db.st.eventos['a1b2c3d4-0001'].status).toBe('PENDENTE_SOMBRA');
  });
  test('só POST', async () => { expect((await enviar({ mut: { req: { metodo: 'GET' } } })).status).toBe(405); });
  test('corpo vazio ou > 64 KB ⇒ 413', async () => { expect((await enviar({ mut: { corpoCru: Buffer.alloc(0) } })).status).toBe(413); expect((await enviar({ mut: { corpoCru: Buffer.alloc(70000, 'a') } })).status).toBe(413); });
});

describe('loja ativa, eventos e idempotência', () => {
  test('aviso da FOCUS PARTS (424483) é IGNORADO (200) e nada é gravado — mesmo se a configuração tentar permiti-la', async () => {
    for (const cfg of [{ modo: 'SOMBRA' }, { modo: 'SOMBRA', lojasPermitidas: ['262759', '424483'] }]) {
      const r = await enviar({ cfg, corpo: aviso({ loja_id: '424483' }) }); expect(r.corpo.codigo).toBe('LOJA_IGNORADA'); expect(r.db.criados).toEqual([]);
    }
  });
  test('loja ausente ⇒ 400; evento não suportado ⇒ 200 (sem reprocesso) e sem gravação', async () => {
    expect((await enviar({ corpo: aviso({ loja_id: undefined }) })).corpo.codigo).toBe('LOJA_AUSENTE');
    const r = await enviar({ corpo: aviso({ evento: 'venda.excluida' }), mut: { cab: { 'x-webhook-evento': 'venda.excluida' } } }); expect(r.status).toBe(200); expect(r.db.criados).toEqual([]);
  });
  test('os 6 eventos aprovados são aceitos; evento desativado na configuração é ignorado', async () => {
    for (const ev of W.EVENTOS) expect((await enviar({ corpo: aviso({ evento: ev, recurso: undefined }), mut: { cab: { 'x-webhook-evento': ev } } })).corpo.codigo).toBe('RECEBIDO');
    expect((await enviar({ cfg: { modo: 'SOMBRA', eventosAtivos: ['venda.cadastrada'] }, corpo: aviso({ evento: 'recebimento.baixado', recurso: undefined }), mut: { cab: { 'x-webhook-evento': 'recebimento.baixado' } } })).corpo.codigo).toBe('EVENTO_DESATIVADO');
  });
  test('idempotência: mesmo X-Webhook-Id duas vezes ⇒ 2º é DUPLICADO (200) e não regrava', async () => {
    const db = fakeDb({ modo: 'SOMBRA' }); const a = await enviar({ db }); const b = await enviar({ db });
    expect(a.corpo.codigo).toBe('RECEBIDO'); expect(b.corpo.codigo).toBe('DUPLICADO'); expect(db.criados).toHaveLength(1);
  });
  test('id do cabeçalho diferente do corpo ⇒ 400', async () => { expect((await enviar({ mut: { cab: { 'x-webhook-id': 'outro-id' } } })).corpo.codigo).toBe('ID_DIVERGENTE'); });
  test('falha de gravação ⇒ 500 (o GC repete); nunca 2xx sem gravar', async () => {
    const db = fakeDb({ modo: 'SOMBRA' }); const orig = db.collection; db.collection = n => { const c = orig(n); return { doc: id => ({ ...c.doc(id), create: async () => { throw new Error('UNAVAILABLE'); } }) }; };
    expect((await enviar({ db })).status).toBe(500);
  });
});

describe('privacidade e processamento em sombra', () => {
  test('o documento guarda só ids/evento/loja/recurso/horários/hash — nunca nome, valor ou corpo', async () => {
    const r = await enviar(); const d = r.db.st.eventos['a1b2c3d4-0001'];
    expect(JSON.stringify(d)).not.toMatch(/SECRETO|999\.99|nome_cliente|valor_total/);
    expect(Object.keys(d).sort()).toEqual(['codigo', 'corpo_sha256', 'empresa_id', 'evento', 'id', 'loja_id', 'modo', 'ocorrido_em', 'recebido_em', 'recebido_ms', 'recurso', 'registro_id', 'resultado', 'status', 'tentativa']);
    expect(JSON.stringify(r.logs)).not.toMatch(/SECRETO|999\.99|segredo/i);
  });
  test('sombra: confere existência/loja; 404 ⇒ ORIGEM_INDISPONIVEL (nada é apagado); falha ⇒ continua pendente; outra loja ⇒ LOJA_DIVERGENTE', async () => {
    const run = async buscar => { const r = await enviar(); const out = await W.processarSombra({ db: r.db, id: 'a1b2c3d4-0001', buscar }); return { out, ev: r.db.st.eventos['a1b2c3d4-0001'] }; };
    let x = await run(async () => ({ status: 200, loja_id: '262759' })); expect(x.out.codigo).toBe('CONFERIDO'); expect(x.ev.status).toBe('SOMBRA_CONCLUIDA');
    x = await run(async () => ({ status: 404 })); expect(x.out.codigo).toBe('ORIGEM_INDISPONIVEL');
    x = await run(async () => ({ status: 200, loja_id: '424483' })); expect(x.out.codigo).toBe('LOJA_DIVERGENTE');
    x = await run(async () => { throw new Error('GC_HTTP_503'); }); expect(x.out.codigo).toBe('FALHA_CONSULTA'); expect(x.ev.status).toBe('PENDENTE_SOMBRA');
  });
  test('o módulo não tem efeitos em coleções de negócio (só gc_webhook_*)', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'webhooks', 'receptor.js'), 'utf8');
    const colecoes = [...src.matchAll(/collection\('([^']+)'\)/g)].map(m => m[1]); expect(colecoes.every(c => /^gc_webhook_/.test(c))).toBe(true);
    expect(src).not.toMatch(/painel_cache|pedidos_cache|financeiro_cache|vendas_gc|expedicao_pedidos/);
  });
});

describe('sombra: reprocessamento, comparação com o polling, silêncio e proteção contra exclusão', () => {
  const dbCom = eventos => { const st = { ...eventos }; const q = { where: () => q, limit: () => q, get: async () => ({ docs: Object.entries(st).filter(([, v]) => v.status === q._s).map(([id, v]) => ({ id, data: () => v })) }) };
    return { st, collection: () => Object.assign(q, { doc: id => ({ get: async () => ({ exists: !!st[id], data: () => st[id] }), set: async (d) => { st[id] = { ...(st[id] || {}), ...d }; } }) }) }; };
  test('pendente cuja consulta falha é tentado até 5 vezes e depois fica SOMBRA_FALHA (nunca apagado)', async () => {
    const db = dbCom({ e1: { status: 'PENDENTE_SOMBRA', recurso: 'vendas', registro_id: '1', recebido_ms: 0, tentativas_sombra: 5 } });
    const col = db.collection(); col._s = 'PENDENTE_SOMBRA';
    const r = await W.reprocessarPendentes({ db, buscar: async () => { throw new Error('x'); }, agora: () => 10 * 3600000 });
    expect(r.falhas).toBe(1); expect(db.st.e1.status).toBe('SOMBRA_FALHA'); expect(db.st.e1).toBeDefined();
  });
  test('comparação com o polling: conta presentes, ausentes (cedo × após atraso), origem indisponível e loja divergente', async () => {
    const base = { status: 'SOMBRA_CONCLUIDA', recurso: 'vendas', recebido_ms: 0 };
    const db = dbCom({ a: { ...base, registro_id: '1', resultado: 'CONFERIDO' }, b: { ...base, registro_id: '2', resultado: 'CONFERIDO', recebido_ms: 9 * 3600000 }, c: { ...base, registro_id: '3', resultado: 'CONFERIDO' }, d: { ...base, registro_id: '4', resultado: 'ORIGEM_INDISPONIVEL' }, e: { ...base, registro_id: '5', resultado: 'LOJA_DIVERGENTE' } });
    db.collection()._s = 'SOMBRA_CONCLUIDA';
    const r = await W.compararComPolling({ db, existeNoPolling: async (_r, id) => id === '1', agora: () => 10 * 3600000 });
    expect(r).toEqual({ total: 5, no_polling: 1, ausente_ainda_cedo: 1, ausente_apos_atraso: 1, origem_indisponivel: 1, loja_divergente: 1 });
  });
  test('silêncio de 24 h só alerta com SOMBRA/ATIVO', () => {
    expect(W.avaliarSilencio({ modo: 'DESLIGADO', ultimoEventoMs: 0, agoraMs: 99 * 3600000 }).alerta).toBe(false);
    expect(W.avaliarSilencio({ modo: 'SOMBRA', ultimoEventoMs: 0, agoraMs: 25 * 3600000 }).alerta).toBe(true);
    expect(W.avaliarSilencio({ modo: 'SOMBRA', ultimoEventoMs: 3600000, agoraMs: 5 * 3600000 }).alerta).toBe(false);
    expect(W.avaliarSilencio({ modo: 'ATIVO', ultimoEventoMs: null, agoraMs: 1 }).motivo).toBe('NUNCA_RECEBEU');
  });
  test('proteção contra exclusões indevidas: o módulo NÃO tem delete/update destrutivo; evento excluído na origem só vira sinalização', () => {
    const src = require('fs').readFileSync(require('path').join(__dirname, '..', 'lib', 'webhooks', 'receptor.js'), 'utf8');
    expect(src).not.toMatch(/\.delete\(|\.remove\(|recursiveDelete|FieldValue\.delete/);
    const fn = require('fs').readFileSync(require('path').join(__dirname, '..', 'webhook-gestaoclick.js'), 'utf8'); expect(fn).not.toMatch(/\.delete\(|\.remove\(/);
  });
});

describe('HTTP local com eventos sintéticos (sem rede externa)', () => {
  const http = require('http');
  test('servidor real: aceita assinado, rejeita adulterado, é idempotente e responde rápido (< 5 s; típico ms)', async () => {
    const db = fakeDb({ modo: 'SOMBRA' }); const lerConfig = W.criarLeitorConfig({ db });
    const srv = http.createServer((rq, rs) => { const ch = []; rq.on('data', c => ch.push(c)); rq.on('end', async () => {
      const r = await W.tratarRequisicao({ req: { metodo: rq.method, cabecalhos: rq.headers, corpoCru: Buffer.concat(ch) }, db, segredo: SEG, lerConfig, serverTimestamp: () => 'TS' });
      rs.writeHead(r.status, { 'content-type': 'application/json' }); rs.end(JSON.stringify(r.corpo)); }); });
    await new Promise(r => srv.listen(0, '127.0.0.1', r)); const porta = srv.address().port;
    const t = Math.floor(Date.now() / 1000);
    const post = async (corpo, extra = {}) => { const ini = Date.now(); const cru = JSON.stringify(corpo); const resp = await fetch(`http://127.0.0.1:${porta}/`, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-id': corpo.id, 'x-webhook-evento': corpo.evento, 'x-webhook-tentativa': '1', 'x-webhook-assinatura': assinar(cru, t), ...extra }, body: cru }); return { status: resp.status, j: await resp.json(), ms: Date.now() - ini }; };
    const a = await post(aviso({ id: 'sint-1' })); const dup = await post(aviso({ id: 'sint-1' })); const adul = await post(aviso({ id: 'sint-2' }), { 'x-webhook-assinatura': assinar('{}', t) });
    const outra = await post(aviso({ id: 'sint-3', loja_id: '424483' }));
    srv.close();
    expect([a.status, a.j.codigo]).toEqual([200, 'RECEBIDO']); expect(dup.j.codigo).toBe('DUPLICADO'); expect(adul.status).toBe(401); expect(outra.j.codigo).toBe('LOJA_IGNORADA');
    expect(Math.max(a.ms, dup.ms, adul.ms, outra.ms)).toBeLessThan(1000); expect(Object.keys(db.st.eventos)).toEqual(['sint-1']);
  });
});
