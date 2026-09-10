'use strict';

/**
 * Testes unitários e de integração — syncPainelDisplay (S3 Etapa 2)
 *
 * Testa o handler _syncPainelDisplayHandler diretamente contra o emulador Firestore.
 * fetch() é mockado para nunca chamar o GestãoClick real.
 *
 * Cenários:
 *   SP01 — filtro de situacao_id: só Concretizados (3952593) contam
 *   SP02 — venda de outro status não entra nos totais
 *   SP03 — identificação de vendedor por nome exato
 *   SP04 — identificação de vendedor por primeiro nome (match parcial)
 *   SP05 — venda sem vendedor conhecido não contamina métricas
 *   SP06 — totalHoje correto (soma apenas vendas do dia)
 *   SP07 — totalMes correto (soma todo o mês)
 *   SP08 — pedidosHoje correto
 *   SP09 — pedidosMes correto
 *   SP10 — ticketHoje correto (totalHoje / pedidosHoje)
 *   SP11 — ticketMes correto (totalMes / pedidosMes)
 *   SP12 — venda fora do período (mês anterior) não afeta totais
 *   SP13 — venda com estrutura inesperada (campos ausentes) — graceful
 *   SP14 — DTO não contém dados sensíveis (CPF, CNPJ, cliente, produtos, endereço)
 *   SP15 — paginação: busca múltiplas páginas até total_paginas
 *   SP16 — nome dos vendedores lido de painel_config/default (não hardcoded)
 *   SP17 — fallback para nomes padrão quando painel_config ausente
 *   SP18 — totais da equipe = soma dos vendedores
 *   SP19 — ticketHoje/ticketMes zerados quando sem pedidos (sem divisão por zero)
 *   SP20 — campos alternativos de valor: total e valor como fallback de valor_total
 *   SP21 — campos alternativos de data: data_venda e data_pedido como fallback de data
 *   SP22 — campos alternativos de vendedor: vendedor e nome_usuario como fallback
 *   SP23 — prevenção de sobreposição: pula se atualizado há menos de 25 min
 *
 * Executar:
 *   cd functions && npm test -- --testPathPattern=sync-painel
 */

process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';

process.env.GC_ACCESS_TOKEN        = 'mock-access-token-test';
process.env.GC_SECRET_ACCESS_TOKEN = 'mock-secret-token-test';

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mr4-ponto' });
}
const db = admin.firestore();

const {
  _syncPainelDisplayHandler: handler,
  _nomeMatchPainel:           nomeMatchPainel,
  _fetchTodasVendasGC:        fetchTodasVendasGC,
} = require('../index');

const { fortalezaAgora } = require('../utils');

// ── Helpers de data ───────────────────────────────────────────────────────────
function hojeStr()   { return fortalezaAgora().data; }
function anoMes()    { const [a, m] = hojeStr().split('-'); return `${a}-${m}`; }
function inicioMes() { return anoMes() + '-01'; }
function ontem() {
  const d = new Date(hojeStr() + 'T12:00:00Z');
  d.setDate(d.getDate() - 1);
  return d.toISOString().slice(0, 10);
}
function mesPasado() {
  const [a, m] = hojeStr().split('-').map(Number);
  const d = new Date(a, m - 2, 1); // mês anterior, dia 1
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-01`;
}

// ── Construtor de venda mock ──────────────────────────────────────────────────
let _idSeq = 100;
function mkVenda(overrides = {}) {
  return {
    id:          _idSeq++,
    situacao_id: 3952593,          // Concretizado (número — GC retorna número)
    nome_vendedor: 'Ademir Santos',
    data:        hojeStr(),
    valor_total: 1000,
    ...overrides,
  };
}

// ── Resposta GC paginada ──────────────────────────────────────────────────────
function gcResp(data, { pagina = 1, total_paginas = 1 } = {}) {
  return {
    data,
    meta: { pagina_atual: pagina, total_paginas, total_registros: data.length },
  };
}

// ── Mock fetch global ─────────────────────────────────────────────────────────
let mockFetchImpl = null;

function mockFetchSingle(vendas) {
  mockFetchImpl = () => Promise.resolve({
    ok: true, status: 200,
    json:  async () => gcResp(vendas),
    text:  async () => JSON.stringify(gcResp(vendas)),
  });
}

// ── Setup / teardown ──────────────────────────────────────────────────────────
beforeAll(() => {
  global.fetch = jest.fn((...args) => {
    if (mockFetchImpl) return mockFetchImpl(...args);
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => gcResp([]),
      text: async () => '{}',
    });
  });
});

beforeEach(async () => {
  jest.clearAllMocks();
  mockFetchImpl = null;
  // Remove o documento para evitar o bloqueio de 25 min entre testes
  await db.collection('display_metrics').doc('painel_comercial').delete().catch(() => {});
  // Seed painel_config/default com os nomes padrão
  await db.collection('painel_config').doc('default').set({
    vendedores: [{ nome: 'Ademir', meta: 50000 }, { nome: 'Fabiana', meta: 50000 }],
    meta_equipe: 0,
  });
});

afterAll(() => admin.app().delete());

// Helper para ler o documento gravado
async function lerDoc() {
  const snap = await db.collection('display_metrics').doc('painel_comercial').get();
  return snap.exists ? snap.data() : null;
}

// ── SP01 — apenas situacao_id=3952593 conta ───────────────────────────────────
test('SP01 — filtro situacao_id: só Concretizados (3952593) contam', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir', situacao_id: 3952593, valor_total: 1500 }),
    mkVenda({ nome_vendedor: 'Ademir', situacao_id: 9999999, valor_total: 5000 }), // outro status
  ]);

  await handler();
  const doc = await lerDoc();

  const ademir = doc.vendedores.find(v => v.nome === 'Ademir');
  expect(ademir.totalHoje).toBeCloseTo(1500);
  expect(ademir.pedidosHoje).toBe(1);
});

// ── SP02 — venda cancelada não entra nos totais ───────────────────────────────
test('SP02 — venda com outro status não contamina totais', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Fabiana', situacao_id: 1111111, valor_total: 9999 }),
  ]);

  await handler();
  const doc = await lerDoc();

  const fabiana = doc.vendedores.find(v => v.nome === 'Fabiana');
  expect(fabiana.totalMes).toBe(0);
  expect(fabiana.pedidosMes).toBe(0);
});

// ── SP03 — identificação por nome exato ──────────────────────────────────────
test('SP03 — nomeMatch: nome exato (case-insensitive)', () => {
  expect(nomeMatchPainel('fabiana oliveira', 'Fabiana Oliveira')).toBe(true);
  expect(nomeMatchPainel('ADEMIR', 'ademir')).toBe(true);
  expect(nomeMatchPainel('carlos', 'Fabiana')).toBe(false);
});

// ── SP04 — identificação por primeiro nome ────────────────────────────────────
test('SP04 — nomeMatch: match de primeiro nome', () => {
  expect(nomeMatchPainel('Ademir Santos', 'Ademir')).toBe(true);
  expect(nomeMatchPainel('Fabiana', 'Fabiana Oliveira')).toBe(true);
  expect(nomeMatchPainel('Carlos Lima', 'Fabiana')).toBe(false);
});

// ── SP05 — venda sem vendedor conhecido não contamina ─────────────────────────
test('SP05 — venda de vendedor desconhecido não entra em nenhum vendedor', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Desconhecido XYZ', valor_total: 7777 }),
  ]);

  await handler();
  const doc = await lerDoc();

  for (const v of doc.vendedores) {
    expect(v.totalMes).toBe(0);
    expect(v.pedidosMes).toBe(0);
  }
  // Equipe também não contabiliza
  expect(doc.equipe.totalMes).toBe(0);
});

// ── SP06 — totalHoje: soma apenas vendas do dia ───────────────────────────────
test('SP06 — totalHoje correto (só vendas de hoje)', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir', data: hojeStr(),  valor_total: 2000 }),
    mkVenda({ nome_vendedor: 'Ademir', data: ontem(),    valor_total: 500  }), // ontem
  ]);

  await handler();
  const doc = await lerDoc();

  const ademir = doc.vendedores.find(v => v.nome === 'Ademir');
  expect(ademir.totalHoje).toBeCloseTo(2000);
  expect(ademir.totalMes).toBeCloseTo(2500);
});

// ── SP07 — totalMes: soma todo o mês ─────────────────────────────────────────
test('SP07 — totalMes inclui vendas do mês inteiro (não só hoje)', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Fabiana', data: inicioMes(), valor_total: 3000 }),
    mkVenda({ nome_vendedor: 'Fabiana', data: hojeStr(),   valor_total: 1200 }),
  ]);

  await handler();
  const doc = await lerDoc();

  const fabiana = doc.vendedores.find(v => v.nome === 'Fabiana');
  expect(fabiana.totalMes).toBeCloseTo(4200);
});

// ── SP08 — pedidosHoje correto ────────────────────────────────────────────────
test('SP08 — pedidosHoje conta apenas vendas de hoje', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir', data: hojeStr()  }),
    mkVenda({ nome_vendedor: 'Ademir', data: hojeStr()  }),
    mkVenda({ nome_vendedor: 'Ademir', data: ontem()    }),
  ]);

  await handler();
  const doc = await lerDoc();

  const ademir = doc.vendedores.find(v => v.nome === 'Ademir');
  expect(ademir.pedidosHoje).toBe(2);
  expect(ademir.pedidosMes).toBe(3);
});

// ── SP09 — pedidosMes correto ─────────────────────────────────────────────────
test('SP09 — pedidosMes conta todas as vendas do mês', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Fabiana', data: inicioMes() }),
    mkVenda({ nome_vendedor: 'Fabiana', data: inicioMes() }),
    mkVenda({ nome_vendedor: 'Fabiana', data: hojeStr()   }),
    mkVenda({ nome_vendedor: 'Fabiana', data: hojeStr()   }),
    mkVenda({ nome_vendedor: 'Fabiana', data: hojeStr()   }),
  ]);

  await handler();
  const doc = await lerDoc();

  const fabiana = doc.vendedores.find(v => v.nome === 'Fabiana');
  expect(fabiana.pedidosMes).toBe(5);
});

// ── SP10 — ticketHoje correto ─────────────────────────────────────────────────
test('SP10 — ticketHoje = totalHoje / pedidosHoje', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir', data: hojeStr(), valor_total: 900 }),
    mkVenda({ nome_vendedor: 'Ademir', data: hojeStr(), valor_total: 1500 }),
  ]);

  await handler();
  const doc = await lerDoc();

  const ademir = doc.vendedores.find(v => v.nome === 'Ademir');
  expect(ademir.ticketHoje).toBeCloseTo(1200); // (900+1500)/2
});

// ── SP11 — ticketMes correto ──────────────────────────────────────────────────
test('SP11 — ticketMes = totalMes / pedidosMes', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Fabiana', data: inicioMes(), valor_total: 600 }),
    mkVenda({ nome_vendedor: 'Fabiana', data: inicioMes(), valor_total: 1200 }),
    mkVenda({ nome_vendedor: 'Fabiana', data: hojeStr(),   valor_total: 900 }),
  ]);

  await handler();
  const doc = await lerDoc();

  const fabiana = doc.vendedores.find(v => v.nome === 'Fabiana');
  expect(fabiana.ticketMes).toBeCloseTo(900); // (600+1200+900)/3
});

// ── SP12 — venda do mês anterior não afeta totais ────────────────────────────
// O filtro de data é aplicado na consulta GC (data_inicio=inicioMes).
// Mas se a GC retornar algo fora do intervalo (bug/borda), deve ser ignorado.
test('SP12 — venda com data do mês anterior ignorada pelo filtro de hoje', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir', data: mesPasado(), valor_total: 99999 }),
    mkVenda({ nome_vendedor: 'Ademir', data: hojeStr(),   valor_total: 1000  }),
  ]);

  await handler();
  const doc = await lerDoc();

  const ademir = doc.vendedores.find(v => v.nome === 'Ademir');
  // A venda do mês passado não é de hoje
  expect(ademir.pedidosHoje).toBe(1);
  expect(ademir.totalHoje).toBeCloseTo(1000);
  // Mas conta no totalMes (pois foi retornada pela API — fica na responsabilidade do período consultado)
  // O campo data_inicio na query GC já filtra — aqui testamos apenas o filtro "hoje"
  expect(ademir.pedidosMes).toBe(2);
});

// ── SP13 — venda com estrutura inesperada (campos ausentes) ───────────────────
test('SP13 — venda com campos ausentes processada sem lançar exceção', async () => {
  mockFetchSingle([
    { id: 999, situacao_id: 3952593 },             // sem nome_vendedor, data, valor_total
    { id: 998, situacao_id: 3952593, nome_vendedor: 'Ademir' }, // sem data, sem valor
  ]);

  await expect(handler()).resolves.not.toThrow();

  const doc = await lerDoc();
  expect(doc).not.toBeNull();
  // Nenhuma venda tem data=hoje nem valor válido → totais zero
  const ademir = doc.vendedores.find(v => v.nome === 'Ademir');
  expect(ademir.totalHoje).toBe(0);
});

// ── SP14 — DTO não contém dados sensíveis ─────────────────────────────────────
test('SP14 — documento gravado não contém dados sensíveis ou payload bruto', async () => {
  mockFetchSingle([
    mkVenda({
      nome_vendedor: 'Ademir',
      cliente: 'Cliente Teste',
      cpf: '000.000.000-00',
      cnpj: '00.000.000/0001-00',
      endereco: 'Rua A, 123',
      produtos: [{ nome: 'Pneu', valor: 100 }],
      email: 'cliente@example.com',
    }),
  ]);

  await handler();
  const doc = await lerDoc();

  const docStr = JSON.stringify(doc);
  expect(docStr).not.toContain('cpf');
  expect(docStr).not.toContain('cnpj');
  expect(docStr).not.toContain('endereco');
  expect(docStr).not.toContain('Cliente Teste');
  expect(docStr).not.toContain('email');
  expect(doc).not.toHaveProperty('vendas');     // sem array de vendas individuais
  expect(doc.vendedores[0]).not.toHaveProperty('cpf');
  // meta por vendedor é campo de config (não dado sensível) — incluída desde Etapa 3
  expect(typeof doc.vendedores[0].meta).toBe('number');
  expect(doc.vendedores[0]).not.toHaveProperty('pctMeta');
  expect(doc.equipe).not.toHaveProperty('meta');     // metaEquipe fica em configuracao, não em equipe
  expect(doc.equipe).not.toHaveProperty('pctMeta');
  // configuracao copiada de painel_config (somente campos mínimos do display)
  expect(doc).toHaveProperty('configuracao');
  expect(typeof doc.configuracao.metaEquipe).toBe('number');
});

// ── SP15 — paginação: busca múltiplas páginas ─────────────────────────────────
test('SP15 — paginação automática: busca todas as páginas até total_paginas', async () => {
  const pg1 = [
    mkVenda({ nome_vendedor: 'Ademir', valor_total: 1000 }),
    mkVenda({ nome_vendedor: 'Ademir', valor_total: 1000 }),
  ];
  const pg2 = [
    mkVenda({ nome_vendedor: 'Ademir', valor_total: 2000 }),
  ];
  let pagina = 0;
  const pages = [pg1, pg2];
  mockFetchImpl = () => {
    const data = pages[pagina] || [];
    const resp = gcResp(data, { pagina: pagina + 1, total_paginas: 2 });
    pagina++;
    return Promise.resolve({
      ok: true, status: 200,
      json: async () => resp,
      text: async () => JSON.stringify(resp),
    });
  };

  await handler();
  const doc = await lerDoc();

  const ademir = doc.vendedores.find(v => v.nome === 'Ademir');
  // Soma todas as 3 vendas das 2 páginas
  expect(ademir.pedidosMes).toBe(3);
  expect(ademir.totalMes).toBeCloseTo(4000);
  // Foram feitas 2 chamadas fetch (uma por página)
  expect(global.fetch).toHaveBeenCalledTimes(2);
});

// ── SP16 — nomes de vendedores lidos de painel_config ────────────────────────
test('SP16 — nomes dos vendedores lidos de painel_config/default', async () => {
  await db.collection('painel_config').doc('default').set({
    vendedores: [{ nome: 'Joaquim', meta: 60000 }, { nome: 'Maria', meta: 40000 }],
    meta_equipe: 0,
  });

  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Joaquim Neto', valor_total: 3000 }),
    mkVenda({ nome_vendedor: 'Maria Souza',  valor_total: 1500 }),
  ]);

  await handler();
  const doc = await lerDoc();

  const nomes = doc.vendedores.map(v => v.nome);
  expect(nomes).toContain('Joaquim');
  expect(nomes).toContain('Maria');
  expect(nomes).not.toContain('Ademir');  // config substituída

  const joaquim = doc.vendedores.find(v => v.nome === 'Joaquim');
  expect(joaquim.totalHoje).toBeCloseTo(3000);
});

// ── SP17 — fallback para nomes padrão quando painel_config ausente ─────────────
test('SP17 — fallback para [Ademir, Fabiana] quando painel_config não existe', async () => {
  await db.collection('painel_config').doc('default').delete().catch(() => {});

  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir' }),
    mkVenda({ nome_vendedor: 'Fabiana' }),
  ]);

  await handler();
  const doc = await lerDoc();

  const nomes = doc.vendedores.map(v => v.nome);
  expect(nomes).toContain('Ademir');
  expect(nomes).toContain('Fabiana');
});

// ── SP18 — totais da equipe = soma dos vendedores ─────────────────────────────
test('SP18 — totais da equipe são a soma de todos os vendedores', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir',  data: hojeStr(), valor_total: 1000 }),
    mkVenda({ nome_vendedor: 'Fabiana', data: hojeStr(), valor_total: 2000 }),
    mkVenda({ nome_vendedor: 'Ademir',  data: ontem(),   valor_total: 500  }),
  ]);

  await handler();
  const doc = await lerDoc();

  expect(doc.equipe.totalHoje).toBeCloseTo(3000);   // 1000 + 2000
  expect(doc.equipe.totalMes).toBeCloseTo(3500);    // 1000 + 2000 + 500
  expect(doc.equipe.pedidosHoje).toBe(2);
  expect(doc.equipe.pedidosMes).toBe(3);
});

// ── SP19 — ticket zero quando sem pedidos ─────────────────────────────────────
test('SP19 — ticketHoje e ticketMes são 0 quando sem pedidos (sem divisão por zero)', async () => {
  mockFetchSingle([]);   // nenhuma venda

  await handler();
  const doc = await lerDoc();

  for (const v of doc.vendedores) {
    expect(v.ticketHoje).toBe(0);
    expect(v.ticketMes).toBe(0);
  }
  expect(doc.equipe.ticketHoje).toBe(0);
  expect(doc.equipe.ticketMes).toBe(0);
});

// ── SP20 — campos alternativos de valor ───────────────────────────────────────
test('SP20 — usa `total` e `valor` como fallback de `valor_total`', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir', valor_total: undefined, total: 800 }),
    mkVenda({ nome_vendedor: 'Fabiana', valor_total: undefined, total: undefined, valor: 400 }),
  ]);

  await handler();
  const doc = await lerDoc();

  const ademir  = doc.vendedores.find(v => v.nome === 'Ademir');
  const fabiana = doc.vendedores.find(v => v.nome === 'Fabiana');
  expect(ademir.totalHoje).toBeCloseTo(800);
  expect(fabiana.totalHoje).toBeCloseTo(400);
});

// ── SP21 — campos alternativos de data ────────────────────────────────────────
test('SP21 — usa `data_venda` e `data_pedido` como fallback de `data`', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: 'Ademir',  data: undefined, data_venda: hojeStr(),  valor_total: 700 }),
    mkVenda({ nome_vendedor: 'Fabiana', data: undefined, data_venda: undefined, data_pedido: hojeStr(), valor_total: 300 }),
  ]);

  await handler();
  const doc = await lerDoc();

  const ademir  = doc.vendedores.find(v => v.nome === 'Ademir');
  const fabiana = doc.vendedores.find(v => v.nome === 'Fabiana');
  expect(ademir.pedidosHoje).toBe(1);
  expect(fabiana.pedidosHoje).toBe(1);
});

// ── SP22 — campos alternativos de nome do vendedor ────────────────────────────
test('SP22 — usa `vendedor` e `nome_usuario` como fallback de `nome_vendedor`', async () => {
  mockFetchSingle([
    mkVenda({ nome_vendedor: undefined, vendedor: 'Ademir Teste',  valor_total: 1100 }),
    mkVenda({ nome_vendedor: undefined, vendedor: undefined, nome_usuario: 'Fabiana X', valor_total: 900 }),
  ]);

  await handler();
  const doc = await lerDoc();

  const ademir  = doc.vendedores.find(v => v.nome === 'Ademir');
  const fabiana = doc.vendedores.find(v => v.nome === 'Fabiana');
  expect(ademir.totalHoje).toBeCloseTo(1100);
  expect(fabiana.totalHoje).toBeCloseTo(900);
});

// ── SP23 — prevenção de sobreposição ─────────────────────────────────────────
test('SP23 — pula execução se documento foi atualizado há menos de 25 min', async () => {
  // Pré-popula com timestamp recente (1 minuto atrás)
  const recentTs = admin.firestore.Timestamp.fromDate(new Date(Date.now() - 60_000));
  await db.collection('display_metrics').doc('painel_comercial').set({
    atualizadoEm: recentTs,
    periodo:  { inicioMes: inicioMes(), fim: hojeStr() },
    equipe:   { totalHoje: 99999, totalMes: 99999, pedidosHoje: 0, pedidosMes: 0, ticketHoje: 0, ticketMes: 0 },
    vendedores: [],
  });

  mockFetchSingle([mkVenda({ nome_vendedor: 'Ademir', valor_total: 500 })]);

  await handler();

  // fetch não deve ter sido chamado (handler pulou)
  expect(global.fetch).not.toHaveBeenCalled();

  // Documento não deve ter sido reescrito com novos dados
  const doc = await lerDoc();
  expect(doc.equipe.totalHoje).toBe(99999);
});
