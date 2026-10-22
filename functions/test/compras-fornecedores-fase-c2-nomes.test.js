'use strict';
// AGENTE COMPRAS MR4 — Fase C.2 · nomes reais dos fornecedores: cache, renomeação, ausentes, inativos, falhas da API e invariância dos números.
const N = require('../lib/compras/nomesFornecedores');
const S = require('../lib/compras/snapshot');
const Fe = require('../lib/compras/fetch');
const F = require('../lib/compras/fornecedores');
const G = require('./fixtures/compras-gc-falso');
const D = require('./fixtures/compras-ui-dados');
const X = require('./fixtures/compras-rentabilidade-fx').X;

const fonte = D.cenario(6), P12 = D.politica, T0 = X.AGORA, H = n => new Date(T0.getTime() + n * 3600e3);
const COL = 'compras_n0_fornecedores';
const api = lista => ({ id: lista.id, nome: lista.nome, ativo: lista.ativo === undefined ? '1' : lista.ativo, cnpj: '00.000.000/0001-00', cpf: '000.000.000-00', email: 'x@y.z', contatos: [{ telefone: '1' }], enderecos: [{ rua: 'a' }], rg: '1' });
const cenarioIds = async () => { const r = await S.executarSync({ cli: G.criarGcFalso(fonte).cli, db: G.criarDbFalso(), agora: T0, politica: P12 }); return r.snapshot.fornecedores.unidades.externos.map(g => g.fornecedor_id); };
const gc = lista => G.criarGcFalso({ ...fonte, fornecedores: lista });
const rodar = (lista, db, agora = T0, o = {}) => S.executarSync({ cli: (o.cli || gc(lista).cli), db, agora, politica: P12, ...o });
const nomeDe = (r, id) => r.snapshot.fornecedores.unidades.externos.find(g => g.fornecedor_id === id);
const numeros = snap => JSON.parse(JSON.stringify({ u: snap.fornecedores.unidades, v: snap.fornecedores.valores }, (k, x) => (['nome', 'nome_origem', 'inativo', 'nome_ausente_na_api', 'nome_anterior', 'nomes_fornecedores', 'limitacoes', 'gerado_em', 'valido_ate'].includes(k) ? undefined : x)));

describe('nomesFornecedores — funções puras', () => {
  test('sanitizar: remove controles, normaliza espaços, limita tamanho; vazio ⇒ null', () => {
    expect(N.sanitizarNome('  ACME \t\n LTDA\u0000 ')).toBe('ACME LTDA'); expect(N.sanitizarNome('   ')).toBeNull(); expect(N.sanitizarNome(null)).toBeNull(); expect(N.sanitizarNome(undefined)).toBeNull();
    expect(N.sanitizarNome('A'.repeat(500)).length).toBe(N.NOME_MAX); expect(N.sanitizarNome(123)).toBe('123');
  });
  test('normalizar resposta: só id/nome/ativo (nunca CNPJ, CPF, e-mail, contatos, endereço); sem id é descartado; duplicado vence o último', () => {
    const r = N.normalizarResposta([{ Fornecedor: api({ id: 1, nome: 'AAA' }) }, api({ id: '2', nome: ' BBB ', ativo: '0' }), { nome: 'sem id' }, api({ id: '1', nome: 'AAA NOVO' }), null]);
    expect(r).toEqual([{ id: '1', nome: 'AAA NOVO', ativo: true }, { id: '2', nome: 'BBB', ativo: false }]);
    expect(JSON.stringify(r)).not.toMatch(/cnpj|cpf|email|telefone|rua|0000/i);
  });
  test('mesclar: novos, renomeados (guarda nome anterior), inativos, reativados; id estável', () => {
    const a = N.mesclarResposta(N.cacheVazio(), [{ id: '1', nome: 'AAA', ativo: true }, { id: '2', nome: 'BBB', ativo: true }], T0);
    expect(a.relatorio).toMatchObject({ novos: 2, renomeados: 0 }); expect(Object.keys(a.cache.fornecedores)).toEqual(['1', '2']);
    const b = N.mesclarResposta(a.cache, [{ id: '1', nome: 'AAA RENOMEADA', ativo: true }, { id: '2', nome: 'BBB', ativo: false }], H(24));
    expect(b.cache.fornecedores['1']).toMatchObject({ nome: 'AAA RENOMEADA', nome_anterior: 'AAA', renomeado_em: H(24).toISOString() });
    expect(b.cache.fornecedores['2']).toMatchObject({ nome: 'BBB', ativo: false }); expect(b.relatorio).toMatchObject({ renomeados: 1, inativos: 1 });
    const c = N.mesclarResposta(b.cache, [{ id: '1', nome: 'AAA RENOMEADA', ativo: true }, { id: '2', nome: 'BBB', ativo: true }], H(48));
    expect(c.cache.fornecedores['2'].ativo).toBe(true); expect(c.relatorio.reativados).toBe(1); expect(c.relatorio.renomeados).toBe(0);
  });
  test('nome ausente/vazio na resposta mantém o nome conhecido; sem nome algum fica sem nome (sem inventar)', () => {
    const a = N.mesclarResposta(N.cacheVazio(), [{ id: '1', nome: 'AAA', ativo: true }], T0).cache;
    const b = N.mesclarResposta(a, [{ id: '1', nome: null, ativo: null }, { id: '9', nome: null, ativo: null }], H(1));
    expect(b.cache.fornecedores['1'].nome).toBe('AAA'); expect(b.cache.fornecedores['1'].ativo).toBe(true); expect(b.cache.fornecedores['9'].nome).toBeNull();
    expect(b.relatorio.sem_nome_na_resposta).toBe(2); expect(N.paraApresentacao(b.cache)['9']).toBeUndefined();
  });
  test('fornecedor ausente da resposta NUNCA é apagado: mantém o nome e marca ausente_desde; reaparece e a marca some', () => {
    const a = N.mesclarResposta(N.cacheVazio(), [{ id: '1', nome: 'AAA', ativo: true }, { id: '2', nome: 'BBB', ativo: true }], T0).cache;
    const b = N.mesclarResposta(a, [{ id: '1', nome: 'AAA', ativo: true }], H(24));
    expect(b.cache.fornecedores['2']).toMatchObject({ nome: 'BBB', ausente_desde: H(24).toISOString() }); expect(b.relatorio.ausentes).toBe(1);
    expect(N.paraApresentacao(b.cache)['2']).toMatchObject({ nome: 'BBB', ausente: true });
    const c = N.mesclarResposta(b.cache, [{ id: '1', nome: 'AAA', ativo: true }, { id: '2', nome: 'BBB', ativo: true }], H(48));
    expect(c.cache.fornecedores['2'].ausente_desde).toBeUndefined(); expect(c.relatorio.reaparecidos).toBe(1);
  });
  test('resposta vazia ou suspeita (menos de 50% do cache) é rejeitada; resposta normal passa', () => {
    const base = N.mesclarResposta(N.cacheVazio(), Array.from({ length: 10 }, (_, i) => ({ id: String(i), nome: 'F' + i, ativo: true })), T0).cache;
    expect(N.validarResposta(base, [], 0.5)).toEqual({ ok: false, codigo: 'RESPOSTA_VAZIA_COM_CACHE' });
    expect(N.validarResposta(N.cacheVazio(), [], 0.5)).toEqual({ ok: false, codigo: 'RESPOSTA_VAZIA' });
    expect(N.validarResposta(base, [{ id: '1', nome: 'x', ativo: true }], 0.5).codigo).toBe('RESPOSTA_SUSPEITA_MENOR_QUE_O_CACHE');
    expect(N.validarResposta(base, Array.from({ length: 5 }, (_, i) => ({ id: String(i) })), 0.5).ok).toBe(true);
  });
  test('falha: cache intacto (nomes e histórico), tentativa registrada, erro sem segredo; situação DESATUALIZADO', () => {
    const a = N.mesclarResposta(N.cacheVazio(), [{ id: '1', nome: 'AAA', ativo: true }], T0).cache;
    const f = N.registrarFalha(a, H(24), new Error('GC HTTP 503 em /fornecedores token=abcdefghijklmnopqrstuvwxyz0123456789'));
    expect(f.fornecedores).toEqual(a.fornecedores); expect(f.atualizado_em).toBe(T0.toISOString()); expect(f.ultima_tentativa_ok).toBe(false); expect(f.erro).not.toMatch(/abcdefghijklmnopqrstuvwxyz0123456789/);
    expect(N.situacao(f, H(25), 48)).toMatchObject({ status: 'DESATUALIZADO', motivo: 'ULTIMA_LEITURA_FALHOU', conhecidos: 1 });
  });
  test('situação: OK, cache antigo, ausente', () => {
    const a = N.mesclarResposta(N.cacheVazio(), [{ id: '1', nome: 'AAA', ativo: true }], T0).cache;
    expect(N.situacao(a, H(10), 48).status).toBe('OK'); expect(N.situacao(a, H(60), 48)).toMatchObject({ status: 'DESATUALIZADO', motivo: 'CACHE_ANTIGO' });
    expect(N.situacao(N.cacheVazio(), H(1), 48)).toMatchObject({ status: 'AUSENTE' }); expect(N.situacao(null, H(1), 48).status).toBe('AUSENTE');
  });
});

describe('Allowlist e custo de chamadas', () => {
  test('/fornecedores entra na allowlist do Compras; outros recursos e métodos continuam bloqueados', async () => {
    expect(Fe.RECURSOS_PERMITIDOS).toContain('/fornecedores');
    const chamadas = []; const cli = Fe.criarClienteGC({ fetchImpl: async (u, o) => { chamadas.push([u, o.method]); return { ok: true, json: async () => ({ data: [], meta: {} }) }; }, accessToken: 'a', secretToken: 'b', pausaMs: 0 });
    await cli.get('/fornecedores?pagina=1&limite=100');
    for (const caminho of ['/clientes', '/financeiro', '/usuarios', '/produtos_x']) await expect(cli.get(caminho)).rejects.toThrow(/GET_ONLY_GUARD/);
    await expect(cli.get('/fornecedores', { method: 'POST' })).rejects.toThrow(/GET_ONLY_GUARD/);
    expect(chamadas).toEqual([['https://api.gestaoclick.com/fornecedores?pagina=1&limite=100', 'GET']]);
  });
  test('o sync COMPLETO faz exatamente 1 GET a mais (/fornecedores); o INCREMENTAL faz 0', async () => {
    const ids = await cenarioIds(); const lista = ids.map(id => api({ id, nome: 'NOME ' + id }));
    const sem = gc(lista), com = gc(lista);
    await S.executarSync({ cli: sem.cli, db: G.criarDbFalso(), agora: T0, politica: { ...P12, supplier_sales: { ...F.DEFAULTS, fetch_names: false } } });
    const db = G.criarDbFalso(); await S.executarSync({ cli: com.cli, db, agora: T0, politica: P12 });
    const forn = c => c.chamadas.filter(x => /\/fornecedores/.test(x.url)).length;
    expect(forn(sem)).toBe(0); expect(forn(com)).toBe(1); expect(com.chamadas.length - sem.chamadas.length).toBe(1);
    const inc = gc(lista); const r = await S.executarSyncIncremental({ cli: inc.cli, db, agora: H(3), politica: P12 });
    expect(r.ok).toBe(true); expect(forn(inc)).toBe(0);
    expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores).toMatchObject({ atualizacao: 'USA_CACHE', status: 'OK' });
    expect(nomeDe(r, ids[0]).nome).toBe('NOME ' + ids[0]);                              // o incremental reaproveita o cache
  });
});

describe('Sync com nomes: resolução, cache, renomeação, ausentes e inativos', () => {
  let ids, lista;
  beforeAll(async () => { ids = await cenarioIds(); lista = ids.map(id => api({ id, nome: 'FORNECEDOR ' + id })); });
  test('primeiro COMPLETO: nomes reais, cache gravado (só id/nome/ativo), sem dados sensíveis em nenhum documento', async () => {
    const db = G.criarDbFalso(); const r = await rodar(lista, db);
    ids.forEach(id => expect(nomeDe(r, id)).toMatchObject({ nome: 'FORNECEDOR ' + id, nome_origem: 'GESTAOCLICK' }));
    expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores).toMatchObject({ status: 'OK', ultima_tentativa_ok: true, conhecidos: ids.length, relatorio: { novos: ids.length } });
    const cache = db.ler(COL, 'nomes'); expect(Object.keys(cache.fornecedores)).toEqual(expect.arrayContaining(ids)); expect(Object.keys(cache.fornecedores[ids[0]]).sort()).toEqual(['ativo', 'nome', 'visto_em']);
    for (const id of ['nomes', 'unidades', 'valores']) { const j = JSON.stringify(db.ler(COL, id)); expect(j).not.toMatch(/"(cnpj|cpf|rg|email|telefone|contatos|enderecos)"/i); expect(j).not.toMatch(/00\.000\.000|000\.000\.000-00|x@y\.z/); }
    expect(r.snapshot.fornecedores.unidades.meta.limitacoes).not.toContain('NOMES_DE_FORNECEDOR_AUSENTES');
  });
  test('o ID continua sendo a chave: renomear NÃO muda chave, grupo, quantidades, faturamento nem atribuição', async () => {
    const db = G.criarDbFalso(); const a = await rodar(lista, db);
    const renom = lista.map((x, i) => (i === 0 ? { ...x, nome: 'NOME NOVO DA EMPRESA' } : x));
    const b = await rodar(renom, db, T0);   // mesmo instante: só o nome muda
    expect(nomeDe(b, ids[0])).toMatchObject({ nome: 'NOME NOVO DA EMPRESA', nome_anterior: 'FORNECEDOR ' + ids[0], chave: 'EXTERNO:' + ids[0] });
    expect(JSON.stringify(numeros(b.snapshot))).toBe(JSON.stringify(numeros(a.snapshot)));
    expect(b.snapshot.fornecedores.unidades.meta.nomes_fornecedores.relatorio.renomeados).toBe(1);
  });
  test('INVARIÂNCIA: com nomes, sem nomes ou com nomes estranhos, todos os números e agrupamentos são idênticos', async () => {
    const base = await S.executarSync({ cli: G.criarGcFalso(fonte).cli, db: G.criarDbFalso(), agora: T0, politica: { ...P12, supplier_sales: { ...F.DEFAULTS, fetch_names: false } } });
    const estranhos = ids.map((id, i) => api({ id, nome: ['<script>alert(1)</script>', 'Z'.repeat(300)][i % 2] }));
    const emBranco = ids.map(id => api({ id, nome: '   ' }));
    for (const l of [lista, estranhos, emBranco, []]) { const r = await rodar(l, G.criarDbFalso()); expect(JSON.stringify(numeros(r.snapshot))).toBe(JSON.stringify(numeros(base.snapshot))); expect(r.ok).toBe(true); }
    const r = await rodar(estranhos, G.criarDbFalso());
    expect(nomeDe(r, ids[0]).nome).toBe('<script>alert(1)</script>');                       // guardado como texto; a tela escapa
    if (ids.length > 1) expect(nomeDe(r, ids[1]).nome.length).toBeLessThanOrEqual(N.NOME_MAX);
    const b = await rodar(emBranco, G.criarDbFalso());
    expect(nomeDe(b, ids[0]).nome_origem).toBe('FALLBACK_ID');                              // nome em branco ⇒ cai para o código, sem inventar
  });
  test('fornecedor inativo e ausente na resposta continuam com o último nome conhecido, sinalizados', async () => {
    const db = G.criarDbFalso(); await rodar(lista, db);
    const nova = lista.map((x, i) => (i === 0 ? { ...x, ativo: '0' } : x)).filter((x, i) => i !== 1);    // ids[0] inativo; ids[1] some da resposta
    const r = await rodar(nova, db, H(24));
    if (ids.length > 1) expect(nomeDe(r, ids[1])).toMatchObject({ nome: 'FORNECEDOR ' + ids[1], nome_origem: 'GESTAOCLICK', nome_ausente_na_api: true });
    expect(nomeDe(r, ids[0])).toMatchObject({ nome: 'FORNECEDOR ' + ids[0], inativo: true });
    expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores.relatorio).toMatchObject({ inativos: 1, ausentes: ids.length > 1 ? 1 : 0 });
  });
  test('id vendido que nunca apareceu na API: "Fornecedor #id" + limitação, sem quebrar', async () => {
    const r = await rodar(lista.slice(1), G.criarDbFalso());
    expect(nomeDe(r, ids[0])).toMatchObject({ nome: 'Fornecedor #' + ids[0], nome_origem: 'FALLBACK_ID' }); expect(r.snapshot.fornecedores.unidades.meta.limitacoes).toContain('NOMES_DE_FORNECEDOR_AUSENTES');
  });
});

describe('Falhas temporárias: dados anteriores preservados, vendas e estoque nunca bloqueados', () => {
  let ids, lista;
  beforeAll(async () => { ids = await cenarioIds(); lista = ids.map(id => api({ id, nome: 'FORNECEDOR ' + id })); });
  const clienteQueFalhaEmFornecedores = (status = 503) => { const base = gc(lista); return { chamadas: base.chamadas, cli: { get: async c => { if (/^\/fornecedores/.test(c)) { const e = new Error('GC HTTP ' + status + ' em /fornecedores'); throw e; } return base.cli.get(c); } } }; };
  test('API de fornecedores fora do ar no COMPLETO: sync OK, nomes anteriores mantidos, aviso de desatualização, cache intacto', async () => {
    const db = G.criarDbFalso(); await rodar(lista, db);
    const antes = JSON.stringify(db.ler(COL, 'nomes').fornecedores);
    const r = await rodar(lista, db, H(24), { cli: clienteQueFalhaEmFornecedores().cli });
    expect(r.ok).toBe(true); expect(db.ler('compras_n0', 'meta').ultima_tentativa_ok).toBe(true);
    ids.forEach(id => expect(nomeDe(r, id).nome).toBe('FORNECEDOR ' + id));
    const m = r.snapshot.fornecedores.unidades.meta; expect(m.nomes_fornecedores).toMatchObject({ status: 'DESATUALIZADO', motivo: 'ULTIMA_LEITURA_FALHOU', ultima_tentativa_ok: false }); expect(m.limitacoes).toContain('NOMES_DE_FORNECEDOR_DESATUALIZADOS');
    expect(JSON.stringify(db.ler(COL, 'nomes').fornecedores)).toBe(antes); expect(db.ler(COL, 'nomes').ultima_tentativa_ok).toBe(false);
  });
  test('primeira vez sem cache e API fora: sync OK com "Fornecedor #id" e aviso; nenhum nome inventado', async () => {
    const db = G.criarDbFalso(); const r = await rodar(lista, db, T0, { cli: clienteQueFalhaEmFornecedores().cli });
    expect(r.ok).toBe(true); ids.forEach(id => expect(nomeDe(r, id).nome_origem).toBe('FALLBACK_ID')); expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores.status).toBe('AUSENTE');
  });
  test('resposta vazia ou parcial (suspeita) NÃO apaga nomes conhecidos e é tratada como falha', async () => {
    const db = G.criarDbFalso(); await rodar(lista, db);
    for (const resp of [[], lista.slice(0, Math.max(0, Math.floor(lista.length * 0.4)))]) {
      if (resp.length === lista.length) continue;
      const r = await rodar(resp, db, H(24)); expect(r.ok).toBe(true);
      ids.forEach(id => expect(nomeDe(r, id).nome).toBe('FORNECEDOR ' + id)); expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores.status).toBe('DESATUALIZADO');
      expect(Object.keys(db.ler(COL, 'nomes').fornecedores).length).toBe(ids.length);
    }
  });
  test('cache antigo (> 48 h sem leitura com sucesso, p.ex. só incrementais) vira aviso de nomes desatualizados', async () => {
    const db = G.criarDbFalso(); await rodar(lista, db);
    const inc = await S.executarSyncIncremental({ cli: gc(lista).cli, db, agora: H(60), politica: P12 });
    expect(inc.ok).toBe(true); expect(inc.snapshot.fornecedores.unidades.meta.nomes_fornecedores).toMatchObject({ status: 'DESATUALIZADO', motivo: 'CACHE_ANTIGO' });
    expect(nomeDe(inc, ids[0]).nome).toBe('FORNECEDOR ' + ids[0]);
  });
  test('cache ilegível (erro de leitura): sync OK; se a API também falha, o cache bom NÃO é sobrescrito', async () => {
    const db = G.criarDbFalso(); await rodar(lista, db); const antes = db.ler(COL, 'nomes');
    const ruim = { ...db, collection: c => (c === COL ? { doc: id => (id === 'nomes' ? { get: async () => { throw new Error('indisponivel'); }, set: async () => { throw new Error('nao deve gravar'); } } : db.collection(c).doc(id)) } : db.collection(c)),
      batch: () => { const l = db.batch(); return { set: (r, v) => { if (r._c === COL && r.id === 'nomes') throw new Error('NOMES_SOBRESCRITO'); l.set(r, v); }, commit: () => l.commit() }; } };
    const r = await rodar(lista, ruim, H(24), { cli: clienteQueFalhaEmFornecedores().cli });
    expect(r.ok).toBe(true); expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores.cache_ilegivel).toBe(true); expect(r.snapshot.persistencia.fornecedores.gravado).toBe(true);
    expect(db.ler(COL, 'nomes')).toEqual(antes);
  });
  test('erro ao gravar o cache/agregados não derruba o sync e não altera as outras coleções', async () => {
    const db = G.criarDbFalso(); const falho = { ...db, batch: () => { const l = db.batch(); return { set: (r, v) => { if (r._c === COL) throw new Error('GRAVACAO_NEGADA'); l.set(r, v); }, commit: () => l.commit() }; } };
    const r = await rodar(lista, falho); expect(r.ok).toBe(true); expect(r.snapshot.persistencia.fornecedores).toEqual({ gravado: false, erro: 'GRAVACAO_NEGADA' }); expect(db.ler('compras_n0', 'meta').ultima_tentativa_ok).toBe(true);
  });
  test('chave de desligamento (fetch_names=false): nenhuma chamada, mas os nomes já conhecidos continuam aparecendo', async () => {
    const db = G.criarDbFalso(); await rodar(lista, db);
    const g = gc(lista); const r = await S.executarSync({ cli: g.cli, db, agora: H(24), politica: { ...P12, supplier_sales: { ...F.DEFAULTS, fetch_names: false } } });
    expect(g.chamadas.filter(c => /fornecedores/.test(c.url))).toEqual([]); expect(nomeDe(r, ids[0]).nome).toBe('FORNECEDOR ' + ids[0]); expect(r.snapshot.fornecedores.unidades.meta.nomes_fornecedores.atualizacao).toBe('DESLIGADA');
  });
});

describe('Compatibilidade: o sync de vendas/estoque não muda', () => {
  test('com a leitura de nomes ligada, todas as coleções existentes saem idênticas às de uma execução com nomes desligados', async () => {
    const ids = await cenarioIds(); const lista = ids.map(id => api({ id, nome: 'N ' + id }));
    const a = G.criarDbFalso(), b = G.criarDbFalso();
    await rodar(lista, a); await S.executarSync({ cli: gc(lista).cli, db: b, agora: T0, politica: { ...P12, supplier_sales: { ...F.DEFAULTS, fetch_names: false } } });
    const sem = st => Object.fromEntries(Object.entries(st).filter(([c]) => c !== COL).map(([c, docs]) => [c, Object.fromEntries(Object.entries(docs).map(([id, s]) => [id, JSON.parse(s)]))]));
    const norm = o => JSON.parse(JSON.stringify(o, (k, x) => (/^(geracao|base_ativa|base_pendente|base_orfas|persistencia|supplier_sales)$/.test(k) ? undefined : x)).replace(/g\d+x[0-9a-f]{6}_/g, ''));   // supplier_sales: só aparece no resumo porque este teste injeta a política
    expect(norm(sem(a.st))).toEqual(norm(sem(b.st)));
  });
});
