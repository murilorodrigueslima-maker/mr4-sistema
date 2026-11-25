'use strict';
// Módulo Integrações e Credenciais — testes isolados com credenciais FICTÍCIAS (nada toca produção, nenhum segredo real).
const { criarHandlers, FRASE_ATIVAR } = require('../lib/integracoes/handlers');
const SMOD = require('../lib/integracoes/secretManager'); const N = require('../lib/integracoes/nucleo');
const FICT_A = 'FICTICIO-access-AAAA1111', FICT_S = 'FICTICIO-secret-BBBB2222', FICT_W = 'FICTICIO-webhook-segredo-CCCC3333';

function fakeDb() {
  const m = new Map(); let seq = 0;
  const colecao = nome => {
    const mk = (filtros = [], ord = null, lim = null) => ({
      where: (f, op, v) => mk([...filtros, [f, op, v]], ord, lim), orderBy: (f, d) => mk(filtros, [f, d], lim), limit: n => mk(filtros, ord, n),
      _docs() { let r = [...m.entries()].filter(([k]) => k.startsWith(nome + '/')).map(([k, v]) => ({ id: k.split('/')[1], data: () => v }));
        for (const [f, op, v] of filtros) r = r.filter(d => op === '==' ? d.data()[f] === v : op === 'in' ? v.includes(d.data()[f]) : true);
        if (ord) r.sort((a, b) => (ord[1] === 'desc' ? -1 : 1) * ((a.data()[ord[0]] || 0) - (b.data()[ord[0]] || 0))); return lim ? r.slice(0, lim) : r; },
      async get() { return { docs: this._docs() }; }, count() { return { get: async () => ({ data: () => ({ count: this._docs().length }) }) }; },
      doc: id => ({ _k: nome + '/' + id, async get() { const v = m.get(nome + '/' + id); return { exists: v !== undefined, data: () => v }; },
        async set(v, o) { m.set(nome + '/' + id, o && o.merge ? { ...(m.get(nome + '/' + id) || {}), ...v } : v); } }),
      async add(v) { const id = 'a' + (++seq); m.set(nome + '/' + id, v); return { id }; } });
    return mk();
  };
  return { m, collection: colecao, runTransaction: async fn => fn({ get: async r => r.get(), set: (r, v) => r.set(v) }) };
}
function fakeSm() {
  const v = {}; const calls = [];
  const lista = n => (v[n] = v[n] || []);
  return { v, calls, falharEm: null,
    async adicionar(n, valor) { if (this.falharEm === n) throw new Error('falha simulada'); if (!SMOD.PERMITIDOS.includes(n)) throw new Error('SEGREDO_NAO_AUTORIZADO'); const l = lista(n); const num = l.length + 1; l.push({ n: num, estado: 'ENABLED', valor, criadaEm: '2026-11-25T00:0' + num + ':00Z' }); calls.push(['add', n]); return num; },
    async versoes(n) { return lista(n).map(x => ({ n: x.n, estado: x.estado, criadaEm: x.criadaEm })).sort((a, b) => b.n - a.n); },
    async desabilitar(n, num) { lista(n).find(x => x.n === num).estado = 'DISABLED'; calls.push(['dis', n, num]); }, async habilitar(n, num) { lista(n).find(x => x.n === num).estado = 'ENABLED'; calls.push(['en', n, num]); },
    async lerUltima(n) { const a = lista(n).filter(x => x.estado === 'ENABLED'); if (!a.length) throw new Error('sem versão'); return a[a.length - 1].valor; } };
}
const T = 1_800_000_000_000;
const auth = (uid, authAgoS = 10) => ({ uid, token: { auth_time: T / 1000 - authAgoS } });
function cenario({ gcOk = true } = {}) {
  const db = fakeDb(); const sm = fakeSm(); const cham = [];
  const put = (c, id, v) => db.collection(c).doc(id).set(v);
  put('integracoes_config', 'acesso', { masters: ['master'] });
  put('users', 'master', { ativo: true, role: 'gestor' }); put('sistema_usuarios', 'master', { admin: true });
  put('users', 'gestor2', { ativo: true, role: 'gestor' }); put('sistema_usuarios', 'gestor2', { admin: true });          // gestor/admin, mas NÃO master
  put('users', 'vend', { ativo: true, role: 'funcionario' }); put('sistema_usuarios', 'vend', { modulos: ['vendas'] });
  put('users', 'bloq', { ativo: true, role: 'gestor' }); put('sistema_usuarios', 'bloq', { admin: true, bloqueado: true });
  put('users', 'inativo', { ativo: false, role: 'gestor' }); put('sistema_usuarios', 'inativo', { admin: true });
  // master temporário bloqueado/inativo
  db.collection('integracoes_config').doc('acesso').set({ masters: ['master', 'bloq', 'inativo'] });
  sm.v.GC_ACCESS_TOKEN = [{ n: 1, estado: 'ENABLED', valor: 'ANTIGO-access-0001', criadaEm: '2026-11-01T00:00:00Z' }]; sm.v.GC_SECRET_ACCESS_TOKEN = [{ n: 1, estado: 'ENABLED', valor: 'ANTIGO-secret-0001', criadaEm: '2026-11-01T00:00:00Z' }]; sm.v.GC_WEBHOOK_SECRET = [{ n: 1, estado: 'ENABLED', valor: 'PLACEHOLDER-INICIAL-0001', criadaEm: '2026-11-25T00:00:00Z' }];
  const transporteGc = async (url, o) => { cham.push({ url, h: o.headers }); const acc = o.headers['access-token']; const ok = gcOk && /^(FICTICIO|ANTIGO)/.test(acc);
    return { ok, status: ok ? 200 : 401, headers: { get: () => null }, json: async () => ({ code: 200, data: [], meta: { total_registros: 0 } }), text: async () => '{}' }; };
  const disparos = []; const requisitarGcp = async o => { disparos.push(o); return { data: {} }; };
  const h = criarHandlers({ db, sm, transporteGc, requisitarGcp, agora: () => T, fetchReceptor: async () => ({ status: 200, json: async () => ({ codigo: 'EVENTO_NAO_SUPORTADO' }) }) });
  return { db, sm, h, cham, disparos, put };
}
const sv = o => JSON.stringify(o);

describe('controle de acesso (backend, independente da interface)', () => {
  test.each([['vend', 'vendedor/funcionário'], ['gestor2', 'gestor/admin não autorizado'], ['bloq', 'usuário bloqueado'], ['inativo', 'usuário desativado'], ['ninguem', 'sem cadastro']])('%s (%s) é negado em TODAS as operações', async (uid) => {
    const c = cenario();
    for (const [fn, data] of [['status'], ['gcSalvar', { accessToken: FICT_A, secretToken: FICT_S }], ['gcTestar'], ['gcReverter'], ['whSegredo', { segredo: FICT_W }], ['whModo', { modo: 'RECEPCAO' }], ['whTeste'], ['syncManual']])
      await expect(c.h[fn]({ auth: auth(uid), data })).rejects.toMatchObject({ code: 'permission-denied' });
    expect(c.sm.calls.length).toBe(0); expect(c.disparos.length).toBe(0);
  });
  test('sem login é negado', async () => { const c = cenario(); await expect(c.h.status({ auth: null })).rejects.toMatchObject({ code: 'unauthenticated' }); });
  test('tentativa negada é auditada sem valores', async () => {
    const c = cenario(); await expect(c.h.gcSalvar({ auth: auth('vend'), data: { accessToken: FICT_A, secretToken: FICT_S } })).rejects.toBeTruthy();
    const aud = [...c.db.m.entries()].filter(([k]) => k.startsWith('integracoes_auditoria/')).map(([, v]) => v); expect(aud.length).toBe(1); expect(aud[0]).toMatchObject({ uid: 'vend', resultado: 'NEGADO' }); expect(sv(aud)).not.toContain(FICT_A);
  });
  test('reautenticação recente é exigida para credenciais/segredo/ATIVO (token antigo é recusado)', async () => {
    const c = cenario(); const velho = auth('master', 3600);
    await expect(c.h.gcSalvar({ auth: velho, data: { accessToken: FICT_A, secretToken: FICT_S } })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(c.h.whSegredo({ auth: velho, data: { segredo: FICT_W } })).rejects.toMatchObject({ code: 'failed-precondition' });
    await expect(c.h.whModo({ auth: velho, data: { modo: 'RECEPCAO' } })).rejects.toMatchObject({ code: 'failed-precondition' });
    expect(c.sm.calls.length).toBe(0);
  });
});

describe('GestãoClick — troca segura de credenciais', () => {
  test('credenciais inválidas: conexão recusada, NADA é gravado e as atuais continuam', async () => {
    const c = cenario({ gcOk: false }); const r = await c.h.gcSalvar({ auth: auth('master'), data: { accessToken: FICT_A, secretToken: FICT_S } });
    expect(r.ok).toBe(false); expect(r.codigo).toBe('CREDENCIAIS_RECUSADAS'); expect(c.sm.calls.length).toBe(0); expect(c.sm.v.GC_ACCESS_TOKEN.length).toBe(1);
  });
  test('sucesso: valida na loja ativa 262759, cria versão nova, confirma, preserva a anterior, não devolve valores', async () => {
    const c = cenario(); const r = await c.h.gcSalvar({ auth: auth('master'), data: { accessToken: FICT_A, secretToken: FICT_S } });
    expect(r.ok).toBe(true); expect(r.versoes).toEqual({ access: 2, secret: 2 }); expect(c.cham[0].url).toContain('loja_id=262759'); expect(c.cham[0].url).not.toContain('424483');
    expect(c.sm.v.GC_ACCESS_TOKEN.map(x => x.estado)).toEqual(['ENABLED', 'ENABLED']);     // anterior preservada
    const tudo = sv(r) + sv([...c.db.m.entries()]); expect(tudo).not.toContain(FICT_A); expect(tudo).not.toContain(FICT_S);   // nenhum valor em retorno, Firestore ou auditoria
  });
  test('falha ao gravar o segundo segredo desfaz o primeiro', async () => {
    const c = cenario(); c.sm.falharEm = 'GC_SECRET_ACCESS_TOKEN'; const r = await c.h.gcSalvar({ auth: auth('master'), data: { accessToken: FICT_A, secretToken: FICT_S } });
    expect(r.ok).toBe(false); expect(c.sm.v.GC_ACCESS_TOKEN[1].estado).toBe('DISABLED'); expect((await c.sm.lerUltima('GC_ACCESS_TOKEN'))).toBe('ANTIGO-access-0001');
  });
  test('reversão: volta ao par anterior (validado) e desativa o novo', async () => {
    const c = cenario(); await c.h.gcSalvar({ auth: auth('master'), data: { accessToken: FICT_A, secretToken: FICT_S } });
    const r = await c.h.gcReverter({ auth: auth('master') }); expect(r.ok).toBe(true); expect(await c.sm.lerUltima('GC_ACCESS_TOKEN')).toBe('ANTIGO-access-0001');
  });
  test('campos extras e formato inválido são recusados; limite de requisições vale', async () => {
    const c = cenario(); await expect(c.h.gcSalvar({ auth: auth('master'), data: { accessToken: FICT_A, secretToken: FICT_S, outro: 'x' } })).rejects.toMatchObject({ code: 'invalid-argument' });
    await expect(c.h.gcSalvar({ auth: auth('master'), data: { accessToken: 'curto', secretToken: FICT_S } })).rejects.toMatchObject({ code: 'invalid-argument' });
    for (let i = 0; i < 3; i++) await c.h.gcSalvar({ auth: auth('master'), data: { accessToken: FICT_A, secretToken: FICT_S } }).catch(() => {});
    await expect(c.h.gcSalvar({ auth: auth('master'), data: { accessToken: FICT_A, secretToken: FICT_S } })).rejects.toMatchObject({ code: 'resource-exhausted' });
  });
  test('o gerenciador de segredos recusa qualquer nome fora dos 3 autorizados (não existe função genérica)', async () => {
    const sm = SMOD.criar({ requisitar: async () => ({ data: {} }) });
    for (const nome of ['OUTRO_SEGREDO', 'GC_ACCESS_TOKEN/../x', 'FIREBASE_KEY']) { await expect(sm.adicionar(nome, 'x')).rejects.toThrow('SEGREDO_NAO_AUTORIZADO'); await expect(sm.lerUltima(nome)).rejects.toThrow(); }
  });
});

describe('Webhooks — segredo, modos e ATIVO', () => {
  test('segredo é gravado só no Secret Manager; estado guarda apenas data/versão', async () => {
    const c = cenario(); const r = await c.h.whSegredo({ auth: auth('master'), data: { segredo: FICT_W } }); expect(r.ok).toBe(true);
    expect(sv([...c.db.m.entries()])).not.toContain(FICT_W); expect(sv(r)).not.toContain(FICT_W);
    const s = await c.h.status({ auth: auth('master') }); expect(s.webhook.segredoCadastrado).toBe(true); expect(sv(s)).not.toContain(FICT_W);
  });
  test('sem segredo não liga; transições só passo a passo; DESLIGADO é imediato', async () => {
    const c = cenario(); let r = await c.h.whModo({ auth: auth('master'), data: { modo: 'RECEPCAO' } }); expect(r.codigo).toBe('SEM_SEGREDO');
    await c.h.whSegredo({ auth: auth('master'), data: { segredo: FICT_W } });
    r = await c.h.whModo({ auth: auth('master'), data: { modo: 'SOMBRA' } }); expect(r.codigo).toBe('TRANSICAO_NAO_PERMITIDA');
    r = await c.h.whModo({ auth: auth('master'), data: { modo: 'RECEPCAO' } }); expect(r.ok).toBe(true);
    r = await c.h.whModo({ auth: auth('master'), data: { modo: 'SOMBRA' } }); expect(r.ok).toBe(true);
    r = await c.h.whModo({ auth: auth('master', 99999), data: { modo: 'DESLIGADO' } }); expect(r.ok).toBe(true);    // desativação imediata não exige reautenticação
    expect((await c.db.collection('gc_webhook_config').doc('estado').get()).data().modo).toBe('DESLIGADO');
  });
  test('ATIVO exige frase explícita E requisitos técnicos; nunca é automático', async () => {
    const c = cenario(); await c.h.whSegredo({ auth: auth('master'), data: { segredo: FICT_W } });
    await c.h.whModo({ auth: auth('master'), data: { modo: 'RECEPCAO' } }); await c.h.whModo({ auth: auth('master'), data: { modo: 'SOMBRA' } });
    let r = await c.h.whModo({ auth: auth('master'), data: { modo: 'ATIVO' } }); expect(r.codigo).toBe('CONFIRMACAO_EXPLICITA_NECESSARIA');
    r = await c.h.whModo({ auth: auth('master'), data: { modo: 'ATIVO', confirmacao: FRASE_ATIVAR } }); expect(r.codigo).toBe('REQUISITOS_NAO_ATENDIDOS');
    for (let i = 0; i < 25; i++) await c.put('gc_webhook_eventos', 'e' + i, { status: 'SOMBRA_CONCLUIDA', resultado: 'CONFERIDO', recebido_ms: T - i });
    await c.put('gc_sync_status', 'ultima', { ultimoSucessoCompletoEm: new Date(T - 3600000).toISOString() });
    r = await c.h.whModo({ auth: auth('master'), data: { modo: 'ATIVO', confirmacao: 'sim' } }); expect(r.codigo).toBe('CONFIRMACAO_EXPLICITA_NECESSARIA');
    r = await c.h.whModo({ auth: auth('master'), data: { modo: 'ATIVO', confirmacao: FRASE_ATIVAR } }); expect(r.ok).toBe(true); expect(r.modo).toBe('ATIVO');
  });
  test('loja divergente impede o ATIVO', async () => {
    const c = cenario(); await c.h.whSegredo({ auth: auth('master'), data: { segredo: FICT_W } }); await c.h.whModo({ auth: auth('master'), data: { modo: 'RECEPCAO' } }); await c.h.whModo({ auth: auth('master'), data: { modo: 'SOMBRA' } });
    for (let i = 0; i < 25; i++) await c.put('gc_webhook_eventos', 'e' + i, { status: 'SOMBRA_CONCLUIDA', resultado: i === 0 ? 'LOJA_DIVERGENTE' : 'CONFERIDO', recebido_ms: T - i });
    await c.put('gc_sync_status', 'ultima', { ultimoSucessoCompletoEm: new Date(T - 60000).toISOString() });
    const r = await c.h.whModo({ auth: auth('master'), data: { modo: 'ATIVO', confirmacao: FRASE_ATIVAR } }); expect(r.codigo).toBe('REQUISITOS_NAO_ATENDIDOS');
  });
  test('teste seguro: desligado não faz nada; ligado assina com o segredo e não grava evento', async () => {
    const c = cenario(); let r = await c.h.whTeste({ auth: auth('master') }); expect(r.codigo).toBe('RECEPTOR_DESLIGADO');
    await c.h.whSegredo({ auth: auth('master'), data: { segredo: FICT_W } }); await c.h.whModo({ auth: auth('master'), data: { modo: 'RECEPCAO' } });
    r = await c.h.whTeste({ auth: auth('master') }); expect(r.ok).toBe(true); expect(r.codigo).toBe('ASSINATURA_ACEITA'); expect([...c.db.m.keys()].some(k => k.startsWith('gc_webhook_eventos/'))).toBe(false);
  });
  test('histórico/estatísticas não expõem ids de venda, cliente nem valores', async () => {
    const c = cenario(); await c.put('gc_webhook_eventos', 'x1', { evento: 'venda.cadastrada', registro_id: '98765', codigo: 'V-1', loja_id: '262759', status: 'SOMBRA_CONCLUIDA', resultado: 'CONFERIDO', recebido_ms: T, ocorrido_em: new Date(T - 4000).toISOString(), modo: 'SOMBRA' });
    const s = await c.h.status({ auth: auth('master') }); expect(s.webhook.eventosRecebidos).toBe(1); expect(s.webhook.latenciaMediaMs).toBe(4000); expect(sv(s.webhook.historico)).not.toMatch(/98765|V-1/);
  });
});

describe('Google Cloud — sincronização manual respeitando a trava', () => {
  test('recusa com trava ativa; dispara o Job quando livre', async () => {
    const c = cenario(); await c.put('gc_sync_lock', 'sync-dados', { expiraEm: T + 600000, detentor: 'x' });
    let r = await c.h.syncManual({ auth: auth('master') }); expect(r.codigo).toBe('SYNC_EM_ANDAMENTO'); expect(c.disparos.length).toBe(0);
    await c.put('gc_sync_lock', 'sync-dados', { expiraEm: 0 }); r = await c.h.syncManual({ auth: auth('master') }); expect(r.ok).toBe(true); expect(c.disparos[0].url).toContain('/jobs/mr4-sync-job:run');
  });
});

describe('estáticos: proibições de armazenamento', () => {
  const fs = require('fs'), path = require('path'); const R = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
  test('a tela não usa localStorage/sessionStorage/IndexedDB nem grava segredo no Firestore; campos são type=password e limpos', () => {
    const H = R('modulos/integracoes.html');
    expect(H).not.toMatch(/localStorage|sessionStorage|indexedDB|setDoc|addDoc|updateDoc|getDoc\(doc\(db, 'integracoes/); expect(H).toMatch(/type="password"[^>]*autocomplete="off"/); expect(H).toMatch(/\.value = ''/);
  });
  test('os módulos de backend não gravam segredos no Firestore nem em log', () => {
    for (const f of ['functions/lib/integracoes/handlers.js', 'functions/integracoes-admin.js']) { const s = R(f); expect(s).not.toMatch(/console\.(log|info)\(/); expect(s).not.toMatch(/\.set\([^)]*(accessToken|secretToken|segredo\b)/); }
    expect(R('functions/lib/segredosRuntime.js')).not.toMatch(/console\./);
  });
});
