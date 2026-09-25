'use strict';
// N35.20.1 — Segregação real dos dados de gestão (ticket médio) com Firestore Rules REAIS no emulador.
// Projeto isolado; nada em produção. O "backend" é o gerador real (Admin SDK, modo LIVE, transação).
const path = require('path');
const fs = require('fs');
const { readFileSync } = fs;
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const admin = require('firebase-admin');
const G = require('../lib/worklistGenerator');
const C = require('../lib/contextoComercial');
const { resolverParticipantes } = require('../lib/dailyWorklist');
const WV = require('../../modulos/fila-worklist-view.js');

const PROJECT = 'mr4-n35201-rules';
const NOW = new Date('2026-09-25T09:00:00.000Z');
const RULES = readFileSync(path.resolve(__dirname, '../../modulos/firestore.rules'), 'utf8');
const HTML = readFileSync(path.resolve(__dirname, '../../modulos/fila-comercial.html'), 'utf8');
const PROIBIDO = /ticket|faturamento|margem|lucro|custo|gestao/i;

// Personas com a mesma forma de configuração de produção (uids de teste)
const FC = { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 };
const PESSOAS = {
  fab: { users: { role: 'funcionario', ativo: true }, sys: { nome: 'Fabiana', admin: false, bloqueado: false, modulos: ['catalogo', 'clientes', 'demandas', 'fila-comercial', 'fila-comercial-operar'], filaComercial: FC } },
  ade: { users: { role: 'funcionario', ativo: true }, sys: { nome: 'Ademir', admin: false, bloqueado: false, modulos: ['fila-comercial', 'fila-comercial-operar'], filaComercial: FC } },
  cam: { users: { role: 'funcionario', ativo: true }, sys: { nome: 'Camila', admin: false, bloqueado: false, modulos: ['catalogo', 'expedicao', 'ponto', 'garantia', 'demandas', 'fila-comercial-gestao'] } },
  mur: { users: { role: 'gestor', ativo: true }, sys: { nome: 'Murilo', admin: true, modulos: ['ponto', 'vendas', 'catalogo', 'expedicao', 'marketing', 'garantia', 'admin', 'financeiro', 'compras', 'fila-comercial'] } },
  opn: { users: { role: 'funcionario', ativo: true }, sys: { nome: 'Opera sem participar', admin: false, bloqueado: false, modulos: ['fila-comercial', 'fila-comercial-operar'] } },
  adm: { users: { role: 'funcionario', ativo: true }, sys: { nome: 'Admin sem gestão', admin: true, bloqueado: false, modulos: ['fila-comercial-operar'] } },
  camBloq: { users: { role: 'funcionario', ativo: true }, sys: { nome: 'Gestão bloqueada', admin: false, bloqueado: true, modulos: ['fila-comercial-gestao'] } },
  gesInat: { users: { role: 'gestor', ativo: false }, sys: { nome: 'Gestor inativo', admin: true, modulos: ['fila-comercial'] } },
};

function vendasCli(gc, n, ultima, intervalo) {
  const out = [];
  const base = Date.parse(ultima + 'T12:00:00Z');
  for (let i = 0; i < n; i++) {
    const d = new Date(base - i * intervalo * 86400000).toISOString().slice(0, 10);
    out.push({ id: `v${gc}-${i}`, cliente_id: gc, data: d, nome_situacao: 'Concretizada', valor_total: String(300 + i), cadastrado_em: d + ' 10:00:00', vendedor_id: '1',
      produtos: [{ produto_id: 'P1', nome_produto: 'KIT LED H4', quantidade: '1', valor_total: String(300 + i) }] });
  }
  return out;
}

let env, adminDb, gerado;
const leitor = uid => (uid ? env.authenticatedContext(uid) : env.unauthenticatedContext()).firestore();

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: RULES, host: 'localhost', port: 8080 } });
  await env.clearFirestore();
  process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
  const app = admin.apps.find(a => a && a.name === 'n35201') || admin.initializeApp({ projectId: PROJECT }, 'n35201');
  adminDb = app.firestore();
  const vendas = [];
  for (let i = 0; i < 30; i++) vendas.push(...vendasCli(String(88800000 + i), 4 + (i % 5), new Date(Date.UTC(2026, 2, 1 + i)).toISOString().slice(0, 10), 14 + (i % 7)));
  const b = adminDb.batch();
  for (const v of vendas) b.set(adminDb.doc(`vendas_gc/${v.id}`), v);
  for (const [uid, p] of Object.entries(PESSOAS)) { b.set(adminDb.doc(`users/${uid}`), p.users); b.set(adminDb.doc(`sistema_usuarios/${uid}`), p.sys); }
  await b.commit();
  // SEC-11: backend real (Admin SDK) gera e grava operacional + gerencial na mesma transação
  gerado = await G.executarGeracaoWorklist({ db: adminDb, now: NOW, mode: 'LIVE', logger: { log() {} }, lookupNome: async gc => 'Cliente ' + gc });
}, 120000);

afterAll(async () => { await env.clearFirestore(); await env.cleanup(); });

describe('Rules — leitura', () => {
  test('SEC-01 vendedora lê a worklist operacional = ALLOW', async () => {
    await assertSucceeds(leitor('fab').doc('fila_comercial/worklist').get());
    await assertSucceeds(leitor('ade').doc('fila_comercial/worklist').get());
  });
  test('SEC-02 vendedora lê o documento gerencial = DENY (get e list)', async () => {
    await assertFails(leitor('fab').doc('fila_comercial_gestao/worklist').get());
    await assertFails(leitor('fab').collection('fila_comercial_gestao').get());
  });
  test('SEC-03 fila-comercial-operar sem participar da distribuição = DENY', async () => {
    await assertFails(leitor('opn').doc('fila_comercial_gestao/worklist').get());
  });
  test('SEC-04 vendedor participante da distribuição = DENY', async () => {
    await assertFails(leitor('ade').doc('fila_comercial_gestao/worklist').get());
  });
  test('SEC-05 admin=true sem módulo de gestão NÃO cria bypass = DENY', async () => {
    await assertFails(leitor('adm').doc('fila_comercial_gestao/worklist').get());
  });
  test('SEC-06 gestor (Murilo) lê gestão = ALLOW', async () => {
    await assertSucceeds(leitor('mur').doc('fila_comercial_gestao/worklist').get());
  });
  test('SEC-07 fila-comercial-gestao (Camila) lê gestão = ALLOW', async () => {
    await assertSucceeds(leitor('cam').doc('fila_comercial_gestao/worklist').get());
  });
  test('SEC-07b gestão bloqueada ou gestor inativo = DENY', async () => {
    await assertFails(leitor('camBloq').doc('fila_comercial_gestao/worklist').get());
    await assertFails(leitor('gesInat').doc('fila_comercial_gestao/worklist').get());
  });
  test('SEC-08 não autenticado = DENY', async () => {
    await assertFails(leitor(null).doc('fila_comercial_gestao/worklist').get());
    await assertFails(leitor(null).doc('fila_comercial/worklist').get());
  });
});

describe('Rules — escrita', () => {
  test('SEC-09 vendedora não escreve gestão (set/update/delete) = DENY', async () => {
    const db = leitor('fab');
    await assertFails(db.doc('fila_comercial_gestao/worklist').set({ itens: {} }));
    await assertFails(db.doc('fila_comercial_gestao/worklist').update({ x: 1 }));
    await assertFails(db.doc('fila_comercial_gestao/worklist').delete());
    await assertFails(db.doc('fila_comercial_gestao/novo').set({ itens: {} }));
  });
  test('SEC-10 gestão pelo cliente (Camila/Murilo) não escreve gestão = DENY', async () => {
    for (const uid of ['cam', 'mur']) {
      await assertFails(leitor(uid).doc('fila_comercial_gestao/worklist').set({ itens: {} }));
      await assertFails(leitor(uid).doc('fila_comercial_gestao/worklist').delete());
    }
  });
});

describe('Estrutura gerada pelo backend', () => {
  let op, ge;
  beforeAll(async () => {
    op = (await adminDb.doc('fila_comercial/worklist').get()).data();
    ge = (await adminDb.doc('fila_comercial_gestao/worklist').get()).data();
  });
  test('SEC-11 backend gera e grava as duas estruturas na mesma execução', () => {
    expect(gerado.status).toBe('GERADA');
    expect(gerado.escritoGestao).toBe('fila_comercial_gestao/worklist');
    expect(op.dataReferencia).toBe('2026-09-25');
    expect(ge).toMatchObject({ schemaVersion: 'worklist-gestao-v1', dataReferencia: '2026-09-25', geradoEm: op.geradoEm });
    expect(Object.keys(ge.itens).length).toBeGreaterThan(0);
  });
  test('SEC-12 documento operacional não contém ticketMedio', () => {
    expect(JSON.stringify(op)).not.toContain('ticketMedio');
    expect(C.camposGestaoExpostos(op)).toEqual([]);
  });
  test('SEC-13 documento operacional não contém o campo gestao (em nenhum nível)', () => {
    const chaves = [];
    const walk = o => { if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { chaves.push(k); walk(v); } };
    walk(op);
    expect(chaves).not.toContain('gestao');
    const comCtx = op.vendedoresAtivos.flatMap(u => op.vendedores[u].novas).filter(x => x.contextoComercial);
    expect(comCtx.length).toBeGreaterThan(0);
  });
  test('SEC-14 documento gerencial sem PII desnecessária (lista branca; sem nome, uid, telefone, documento)', () => {
    expect(Object.keys(ge).sort()).toEqual(['dataReferencia', 'geradoEm', 'itens', 'schemaVersion']);
    for (const v of Object.values(ge.itens)) expect(Object.keys(v)).toEqual(['ticketMedio']);
    const s = JSON.stringify(ge);
    expect(s).not.toMatch(/nomeCliente|Cliente \d|uid|commercialEntityId|GC_NATIVE|telefone|email|cpf|cnpj/i);
    for (const u of Object.keys(PESSOAS)) expect(s).not.toContain(`"${u}"`);
  });
  test('SEC-15 join por opportunityInstanceId (toda chave gerencial existe nas atribuições; UI resolve pelo id)', () => {
    for (const opp of Object.keys(ge.itens)) {
      expect(opp).toMatch(/^[0-9a-f]{16}$/);
      expect(op.atribuicoes[opp]).toBeDefined();
    }
    const [opp] = Object.keys(ge.itens);
    const item = op.vendedoresAtivos.flatMap(u => ['novas', 'pendentes', 'followUps'].flatMap(g => op.vendedores[u][g])).find(x => x.opportunityInstanceId === opp);
    const det = WV.modeloDetalhe(item, { gestao: true, dadosGestao: ge.itens[opp] });
    expect(det.gestao.ticketMedio).toMatch(/^R\$ /);
    expect(HTML).toContain("_gestaoCarga.itens[oppId]"); // UI usa o opportunityInstanceId como chave
  });
});

describe('RAW / DevTools — o que o navegador da vendedora recebe', () => {
  test('RAW-01 leitura bruta da worklist pela vendedora: nenhum campo ou valor gerencial', async () => {
    for (const uid of ['fab', 'ade']) {
      const snap = await assertSucceeds(leitor(uid).doc('fila_comercial/worklist').get());
      const achados = [];
      const walk = (o, p) => {
        if (o && typeof o === 'object') for (const [k, v] of Object.entries(o)) { if (PROIBIDO.test(k)) achados.push(`${p}.${k}`); walk(v, `${p}.${k}`); }
        else if (typeof o === 'string' && /ticket|R\$/i.test(o)) achados.push(`${p}=${o.slice(0, 30)}`);
      };
      walk(snap.data(), '');
      expect(achados).toEqual([]); // SELLER_RAW_TICKET_EXPOSURE=NO
    }
  });
  test('RAW-02 vendedora tenta o documento gerencial pela API = DENY', async () => {
    for (const uid of ['fab', 'ade']) await assertFails(leitor(uid).doc('fila_comercial_gestao/worklist').get()); // SELLER_MANAGEMENT_READ=DENY
  });
  test('RAW-03 frontend: leitura gerencial só por carregarDadosGestao, guardada por _canManageQueue; sem ticket em atributo HTML', () => {
    const usos = HTML.split("'fila_comercial_gestao'").length - 1;
    expect(usos).toBe(1);
    const fn = HTML.slice(HTML.indexOf('function carregarDadosGestao'), HTML.indexOf('function dadosGestaoPara'));
    expect(fn).toMatch(/if \(!window\._canManageQueue\) return Promise\.resolve\(null\)/);
    expect(HTML).not.toMatch(/data-ticket|window\._gestao|window\.gestao/);
    const card = HTML.slice(HTML.indexOf('function renderWorklistCard'), HTML.indexOf('function renderGrupoWl'));
    expect(card).not.toMatch(/ticket|gestao/i);
    const chamada = HTML.slice(HTML.indexOf('function renderDetalheContent'), HTML.indexOf('function renderDetalheOperacional'));
    expect(chamada).toMatch(/const viaGestao = !!cliente\._wlGestao && !!window\._canManageQueue/);
  });
});

describe('Personas e defesa do gerador', () => {
  test('PER-01 Murilo (gestor) não participa da distribuição nem ganha operação; Camila também não', () => {
    const sistema = new Map(Object.entries(PESSOAS).map(([u, p]) => [u, p.sys]));
    const users = new Map(Object.entries(PESSOAS).map(([u, p]) => [u, p.users]));
    const { participantes } = resolverParticipantes(sistema, users);
    const uids = participantes.map(p => p.uid).sort();
    expect(uids).toEqual(['ade', 'fab']);
  });
  test('PER-02 gerador falha fechado se campo gerencial vazar para o documento operacional', () => {
    expect(C.camposGestaoExpostos({ vendedores: { a: { novas: [{ contextoComercial: { gestao: { ticketMedio: 1 } } }] } } })).toEqual([
      'vendedores.a.novas.0.contextoComercial.gestao', 'vendedores.a.novas.0.contextoComercial.gestao.ticketMedio']);
    const src = readFileSync(path.resolve(__dirname, '../lib/worklistGenerator.js'), 'utf8');
    expect(src).toContain("throw new Error('WORKLIST_DOC_CAMPO_GESTAO_EXPOSTO: '");
  });
  test('PER-03 separarGestao: operacional nunca leva a chave gestao; gestão só leva campos gerenciais', () => {
    const { operacional, gestao } = C.separarGestao({ versao: 'V1', motivo: 'x', gestao: { ticketMedio: 10, nomeCliente: 'NAO' } });
    expect('gestao' in operacional).toBe(false);
    expect(gestao).toEqual({ ticketMedio: 10 });
    expect(C.separarGestao({ versao: 'V1', motivo: 'x', gestao: {} }).gestao).toBeNull();
  });
});
