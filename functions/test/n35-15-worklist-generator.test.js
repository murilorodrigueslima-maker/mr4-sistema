'use strict';
// N35.15 — Gerador oficial da Worklist V2 (puro: Firestore falso em memória, sem emulador, sem produção).

const G = require('../lib/worklistGenerator');
const { construirUniversoHibrido } = require('../lib/worklistUniverso');
const QC = require('../lib/filaQueueConfig');
const { criarEstadoInicial, claimOportunidade, registrarOutcome } = require('../lib/filaOperacional');
const { calcularPerfil360 } = require('../lib/perfil360');
const { verificarCamposBloqueados, prepararDadosUI } = require('../lib/filaComercialUtils');

const FAB = 'UGXinD3KVXX0ouYEfamBWjizC5C2';
const ADEMIR = 'G9JDOBsquwdth77qgwtXpcjSxYd2';
const NOW = new Date('2026-09-25T09:00:00.000Z'); // sexta 06:00 America/Fortaleza
const DR = '2026-09-25';
const quiet = { log() {} };

// ── Fixtures ─────────────────────────────────────────────────────────────────
function vendasDe(gcId, datas, valor = 300) {
  return datas.map((d, i) => ({ id: `${gcId}${i}`, cliente_id: gcId, data: d, nome_situacao: 'Concretizada', valor_total: String(valor), cadastrado_em: d + ' 10:00:00', vendedor_id: '1', produtos: [] }));
}
// comprador recorrente inativo há ~200 dias → REATIVACAO_120D / AGIR_AGORA
function inativo(gcId, ultima = '2026-03-09', n = 6) {
  const datas = []; const base = new Date(ultima + 'T12:00:00Z');
  for (let i = 0; i < n; i++) { const d = new Date(base); d.setUTCDate(d.getUTCDate() - i * 20); datas.push(d.toISOString().slice(0, 10)); }
  return vendasDe(gcId, datas);
}
function usuarios({ fabAtiva = true, ademirConfigurado = false } = {}) {
  const users = new Map([[FAB, { ativo: fabAtiva, role: 'funcionario' }], [ADEMIR, { ativo: true, role: 'funcionario' }]]);
  const sistema = new Map([[FAB, { nome: 'FABIANA', modulos: ['fila-comercial-operar'], filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } }], [ADEMIR, { modulos: ['fila-comercial-operar'] }]]);
  return { users, sistema, ademirConfigurado };
}
function dadosBase({ nGc = 25, estados = new Map(), extraVendas = [], perfis = [], clientes = [], u = usuarios() } = {}) {
  let vendas = [];
  for (let i = 0; i < nGc; i++) vendas = vendas.concat(inativo(String(30000000 + i), '2026-03-' + String(10 + (i % 18)).padStart(2, '0'), 4 + (i % 5)));
  return { perfis, clientes, vendas: vendas.concat(extraVendas), estados, users: u.users, sistema: u.sistema };
}
const nomeMock = async gc => `Cliente ${gc}`;
function fakeDb(inicial = {}) {
  const docs = new Map(Object.entries(inicial));
  const writes = [];
  const reads = [];
  const api = {
    writes, reads, docs,
    collection(c) {
      return {
        doc: id => ({
          get: async () => { reads.push(`${c}/${id}`); const d = docs.get(`${c}/${id}`); return { exists: !!d, data: () => d }; },
          set: async data => { writes.push(`${c}/${id}`); docs.set(`${c}/${id}`, JSON.parse(JSON.stringify(data))); },
        }),
      };
    },
  };
  return api;
}
const gerar = (o = {}) => G.executarGeracaoWorklist({ db: null, now: NOW, mode: 'DRY_RUN', logger: quiet, lookupNome: nomeMock, dados: dadosBase(), ...o });
const minha = r => r.doc.vendedores[FAB];

// ── Geração / CAP / vendedores ───────────────────────────────────────────────
describe('Geração e CAP', () => {
  test('GN-01 Fabiana recebe exatamente 10 novas com 25 candidatos', async () => {
    const r = await gerar();
    expect(minha(r).novas).toHaveLength(10);
    expect(r.doc.cap).toBe(10);
  });
  test('GN-02 somente vendedores ativos da config: Fabiana sim, Ademir não', async () => {
    const r = await gerar();
    expect(r.doc.vendedoresAtivos).toEqual([FAB]);
    expect(r.doc.vendedores[ADEMIR]).toBeUndefined();
    expect(Object.values(r.doc.atribuicoes).every(a => a.uid === FAB)).toBe(true);
  });
  test('GN-03 Fabiana inativa → nenhuma worklist gerada, vendedor rejeitado registrado', async () => {
    const r = await gerar({ dados: dadosBase({ u: usuarios({ fabAtiva: false }) }) });
    expect(r.doc.vendedoresAtivos).toEqual([]);
    expect(r.doc.contagens.vendedoresRejeitados).toBe(1);
    expect(Object.keys(r.doc.atribuicoes)).toHaveLength(0);
  });
  test('GN-04 follow-up vencido entra fora do CAP (10 novas + 1 retorno)', async () => {
    const base = await gerar();
    const alvo = minha(base).novas[9];
    let e = { ...criarEstadoInicial(alvo.commercialEntityId, alvo.opportunityInstanceId, alvo.tipoOportunidade, '2026-09-22T12:00:00.000Z'), nomeCliente: 'Nome gravado no estado' };
    e = registrarOutcome(claimOportunidade(e, FAB, '2026-09-22T12:01:00.000Z'), FAB, 'PEDIU_RETORNO', '2026-09-22T12:02:00.000Z', { scheduledFor: DR });
    const r = await gerar({ dados: dadosBase({ estados: new Map([[alvo.opportunityInstanceId, e]]) }) });
    expect(minha(r).followUps.map(x => x.opportunityInstanceId)).toEqual([alvo.opportunityInstanceId]);
    expect(minha(r).novas).toHaveLength(10);
    expect(minha(r).novas.map(x => x.opportunityInstanceId)).not.toContain(alvo.opportunityInstanceId);
  });
  test('GN-05 atendimento válido da Fabiana vem em emAtendimento, fora das novas', async () => {
    const base = await gerar();
    const alvo = minha(base).novas[0];
    const e = claimOportunidade(criarEstadoInicial(alvo.commercialEntityId, alvo.opportunityInstanceId, alvo.tipoOportunidade, '2026-09-25T08:00:00.000Z'), FAB, '2026-09-25T08:30:00.000Z');
    const r = await gerar({ dados: dadosBase({ estados: new Map([[alvo.opportunityInstanceId, e]]) }) });
    expect(minha(r).emAtendimento.map(x => x.opportunityInstanceId)).toEqual([alvo.opportunityInstanceId]);
    expect(minha(r).novas.map(x => x.opportunityInstanceId)).not.toContain(alvo.opportunityInstanceId);
  });
  test('GN-06 atribuições = união exata das listas, sem colisão', async () => {
    const r = await gerar();
    const ids = ['novas', 'followUps', 'emAtendimento'].flatMap(g => minha(r)[g].map(x => x.opportunityInstanceId));
    expect(Object.keys(r.doc.atribuicoes).sort()).toEqual([...ids].sort());
    expect(new Set(ids).size).toBe(ids.length);
  });
});

// ── Idempotência / determinismo ──────────────────────────────────────────────
describe('Idempotência', () => {
  const semData = d => { const { geradoEm, ...x } = d; return JSON.stringify(x); };
  test('ID-01 duas execuções com os mesmos dados → mesmo documento lógico', async () => {
    const a = await gerar(); const b = await gerar();
    expect(semData(b.doc)).toBe(semData(a.doc));
  });
  test('ID-02 vendas embaralhadas → mesmo documento', async () => {
    const d = dadosBase();
    const emb = { ...d, vendas: [...d.vendas].reverse() };
    const a = await gerar({ dados: d }); const b = await gerar({ dados: emb });
    expect(semData(b.doc)).toBe(semData(a.doc));
  });
  test('ID-03 LIVE já gerada hoje → não recalcula nem regrava (CAP do dia preservado)', async () => {
    const db = fakeDb();
    const r1 = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nomeMock, dados: dadosBase() });
    expect(r1.status).toBe('GERADA');
    const r2 = await G.executarGeracaoWorklist({ db, now: new Date('2026-09-25T15:00:00.000Z'), mode: 'LIVE', logger: quiet, lookupNome: nomeMock, dados: dadosBase({ nGc: 40 }) });
    expect(r2.status).toBe('JA_GERADA_HOJE');
    // N35.20.1: 1ª geração grava operacional + gerencial; a 2ª não grava nada
    expect(db.writes).toEqual(['fila_comercial/worklist', 'fila_comercial_gestao/worklist']);
  });
  test('ID-04 LIVE no dia seguinte gera nova worklist', async () => {
    const db = fakeDb();
    await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nomeMock, dados: dadosBase() });
    const r = await G.executarGeracaoWorklist({ db, now: new Date('2026-09-28T09:00:00.000Z'), mode: 'LIVE', logger: quiet, lookupNome: nomeMock, dados: dadosBase() });
    expect(r.status).toBe('GERADA');
    expect(db.docs.get('fila_comercial/worklist').dataReferencia).toBe('2026-09-28');
  });
});

// ── Escritas permitidas ──────────────────────────────────────────────────────
describe('Escritas', () => {
  test('WR-01 DRY_RUN grava SOMENTE a prévia (operacional + gerencial N35.20.1)', async () => {
    const db = fakeDb();
    const r = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'DRY_RUN', logger: quiet, lookupNome: nomeMock, dados: dadosBase() });
    expect(db.writes).toEqual(['fila_comercial/worklist_preview', 'fila_comercial_gestao/worklist_preview']);
    expect(r.escrito).toBe('fila_comercial/worklist_preview');
    expect(r.escritoGestao).toBe('fila_comercial_gestao/worklist_preview');
  });
  test('WR-02 OFF não lê nem grava nada', async () => {
    const db = fakeDb();
    const r = await G.executarGeracaoWorklist({ db, now: NOW, mode: 'OFF', logger: quiet, dados: dadosBase() });
    expect(r.status).toBe('OFF');
    expect(db.writes).toEqual([]);
    expect(db.reads).toEqual([]);
  });
  test('WR-03 geração NUNCA cria interacoes_fila, perfis_360 ou clientes', async () => {
    const db = fakeDb();
    await G.executarGeracaoWorklist({ db, now: NOW, mode: 'LIVE', logger: quiet, lookupNome: nomeMock, dados: dadosBase() });
    expect(db.writes.filter(w => /^(interacoes_fila|perfis_360|clientes|vendas_gc)\//.test(w))).toHaveLength(0);
  });
  test('WR-04 modo inválido lança erro', async () => {
    await expect(G.executarGeracaoWorklist({ db: null, now: NOW, mode: 'XYZ', logger: quiet, dados: dadosBase() })).rejects.toThrow();
  });
  test('WR-05 modo do repositório é LIVE desde a N35.17 (DRY_RUN continua disponível por parâmetro)', () => {
    expect(QC.WORKLIST_V2_MODE).toBe('LIVE');
  });
});

// ── Documento: schema e privacidade ──────────────────────────────────────────
describe('Schema do documento', () => {
  test('SC-01 sem CAMPOS_BLOQUEADOS (prioridade, faturamento, score, clienteMr4Id, gc_id…)', async () => {
    const r = await gerar();
    expect(verificarCamposBloqueados(r.doc)).toEqual([]);
  });
  test('SC-02 sem CPF/CNPJ/telefone/e-mail/endereço', async () => {
    const r = await gerar();
    expect(JSON.stringify(r.doc)).not.toMatch(/cpf|cnpj|telefone|email|endereco|endereço|cidade/i);
  });
  test('SC-03 item contém só os campos da fila', async () => {
    const r = await gerar();
    const chaves = new Set(minha(r).novas.flatMap(x => Object.keys(x)));
    // N35.20: + contextoComercial (informativo), com lista branca própria
    expect([...chaves].sort()).toEqual(['commercialEntityId', 'contextoComercial', 'diasEntreComprasMediana', 'diasSemComprar', 'labelOp', 'nomeCliente', 'opportunityInstanceId', 'quando', 'rank', 'sinaisVisiveis', 'situacao', 'tipoOportunidade'].sort());
    const ctxChaves = new Set(minha(r).novas.flatMap(x => Object.keys(x.contextoComercial || {})));
    // N35.20.1: `gestao` NÃO é permitido no documento operacional
    for (const k of ctxChaves) expect(['versao', 'motivo', 'motivoCodigo', 'rotuloTipo', 'historico', 'produtos', 'sinais', 'tendencia']).toContain(k);
  });
  test('SC-04 metadados: schemaVersion, versao, dataReferencia em America/Fortaleza, rótulo do vendedor', async () => {
    const r = await gerar({ now: new Date('2026-09-26T01:30:00.000Z') }); // 22:30 de 25/09 em Fortaleza
    expect(r.doc.schemaVersion).toBe('worklist-v2');
    expect(r.doc.versao).toBe('N35.18.1');
    expect(r.doc.dataReferencia).toBe('2026-09-25');
    expect(r.doc.vendedoresRotulos).toEqual({ [FAB]: 'FABIANA' });
  });
  test('SC-05 documento pequeno (< 20 KB)', async () => {
    const r = await gerar();
    expect(Buffer.byteLength(JSON.stringify(r.doc))).toBeLessThan(20000);
  });
  test('SC-06 rank sequencial 1..n na ordem canônica', async () => {
    const r = await gerar();
    expect(minha(r).novas.map(x => x.rank)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const { compararOrdemCanonica } = require('../lib/filaOrdering');
    const d = dadosBase();
    const u = await construirUniversoHibrido({ perfis: d.perfis, clientes: d.clientes, vendas: d.vendas, dataReferencia: DR });
    const esperado = [...u.hoje].sort(compararOrdemCanonica).slice(0, 10).map(c => c.opportunityInstanceId);
    expect(minha(r).novas.map(x => x.opportunityInstanceId)).toEqual(esperado);
  });
});

// ── Nomes GC_NATIVE ──────────────────────────────────────────────────────────
describe('Nomes', () => {
  test('NM-01 lookup só para as novas selecionadas (10 chamadas, não 25)', async () => {
    let n = 0;
    const r = await gerar({ lookupNome: async gc => { n++; return 'N' + gc; } });
    expect(n).toBe(10);
    expect(r.doc.contagens.nameLookups).toBe(10);
  });
  test('NM-02 nome não resolvido → substituída pela próxima elegível até completar 10', async () => {
    const r = await gerar({ lookupNome: async gc => (Number(gc) % 3 === 0 ? null : 'N' + gc) });
    expect(minha(r).novas).toHaveLength(10);
    expect(minha(r).novas.every(x => x.nomeCliente && x.nomeCliente.startsWith('N'))).toBe(true);
    expect(r.doc.contagens.nameUnresolved).toBeGreaterThan(0);
  });
  test('NM-03 sem lookup e sem nome → nenhuma nova exibida sem nome', async () => {
    const r = await gerar({ lookupNome: undefined });
    expect(minha(r).novas.filter(x => !x.nomeCliente)).toHaveLength(0);
  });
  test('NM-04 GC fora do ar (erro) → nada sem nome, sem exceção', async () => {
    const r = await gerar({ lookupNome: async () => { throw new Error('GC 503'); } });
    expect(minha(r).novas).toHaveLength(0);
    expect(r.doc.contagens.nameUnresolved).toBeGreaterThan(0);
  });
  test('NM-05 teto de lookups por execução respeitado', async () => {
    let n = 0;
    await gerar({ dados: dadosBase({ nGc: 80 }), lookupNome: async () => { n++; return null; } });
    expect(n).toBeLessThanOrEqual(QC.MAX_NAME_LOOKUPS_PER_RUN);
  });
  test('NM-06 nome nunca vira identidade: ids iguais com nomes diferentes', async () => {
    const a = await gerar({ lookupNome: async gc => 'A' + gc });
    const b = await gerar({ lookupNome: async gc => 'B' + gc });
    expect(minha(a).novas.map(x => x.opportunityInstanceId)).toEqual(minha(b).novas.map(x => x.opportunityInstanceId));
    expect(minha(a).novas.map(x => x.commercialEntityId)).toEqual(minha(b).novas.map(x => x.commercialEntityId));
  });
  test('NM-07 follow-up usa o nome gravado no estado (sem novo lookup)', async () => {
    const base = await gerar();
    const alvo = minha(base).novas[3];
    let e = { ...criarEstadoInicial(alvo.commercialEntityId, alvo.opportunityInstanceId, alvo.tipoOportunidade, '2026-09-22T12:00:00.000Z'), nomeCliente: 'Nome do estado' };
    e = registrarOutcome(claimOportunidade(e, FAB, '2026-09-22T12:01:00.000Z'), FAB, 'SEM_RESPOSTA', '2026-09-24T12:02:00.000Z');
    const chamados = [];
    const r = await gerar({ dados: dadosBase({ estados: new Map([[alvo.opportunityInstanceId, e]]) }), lookupNome: async gc => { chamados.push(gc); return 'L' + gc; } });
    expect(minha(r).followUps[0].nomeCliente).toBe('Nome do estado');
    expect(chamados).not.toContain(alvo.commercialEntityId.split(':')[1]);
  });
});

// ── Duplicatas / identidade / fontes ─────────────────────────────────────────
describe('Duplicatas, identidade e fontes', () => {
  test('DI-01 IDs duplicados GC nunca entram (mesmo sendo os mais prioritários)', async () => {
    const dupVendas = QC.DUPLICATE_GC_IDS.slice(0, 6).flatMap(id => inativo(id, '2026-01-05', 12));
    const r = await gerar({ dados: dadosBase({ extraVendas: dupVendas }) });
    const gcIds = Object.values(r.doc.atribuicoes).map(a => a.commercialEntityId.split(':')[1]);
    expect(gcIds.filter(id => QC.DUPLICATE_GC_IDS.includes(id))).toHaveLength(0);
    expect(r.doc.contagens.excluidos.DUPLICATA_GC).toBe(6);
  });
  test('DI-02 identidades válidas e opportunityInstanceId hex16 em todos os itens', async () => {
    const r = await gerar();
    for (const x of minha(r).novas) {
      expect(x.commercialEntityId).toMatch(/^(GC_NATIVE:\d+|MR4_LINKED:.+)$/);
      expect(x.opportunityInstanceId).toMatch(/^[0-9a-f]{16}$/);
    }
  });
  test('DI-03 MR4_LINKED usa nome do cadastro e não consome lookup', async () => {
    const mr4Id = 'AbCdEfGhIjKlMnOpQrSt';
    const vs = inativo('77700001', '2025-12-01', 10);
    const perfil = { ...calcularPerfil360({ clienteMr4Id: mr4Id, gestaoClickId: '77700001', vendas: vs, dataReferencia: DR }) };
    const dados = dadosBase({ nGc: 0, extraVendas: vs, perfis: [{ id: mr4Id, data: perfil }], clientes: [{ id: mr4Id, data: { nome: 'Loja Cadastro', gestaoClickId: '77700001' } }] });
    let n = 0;
    const r = await gerar({ dados, lookupNome: async () => { n++; return 'X'; } });
    expect(minha(r).novas.map(x => [x.commercialEntityId, x.nomeCliente])).toEqual([[`MR4_LINKED:${mr4Id}`, 'Loja Cadastro']]);
    expect(n).toBe(0);
  });
  test('DI-04 GC vinculado a cliente MR4 não aparece duplicado como GC_NATIVE', async () => {
    const vs = inativo('77700002', '2025-12-01', 10);
    const dados = dadosBase({ nGc: 0, extraVendas: vs, clientes: [{ id: 'ZzYyXxWwVvUuTtSsRrQq', data: { nome: 'Vinculado', gestaoClickId: '77700002' } }] });
    const u = await construirUniversoHibrido({ perfis: dados.perfis, clientes: dados.clientes, vendas: dados.vendas, dataReferencia: DR });
    expect(u.brutos.filter(b => b.commercialEntityId === 'GC_NATIVE:77700002')).toHaveLength(0);
  });
  test('DI-05 canários ficam fora das atribuições da vendedora', async () => {
    const r = await gerar();
    for (const id of QC.CANARY_OPPORTUNITY_IDS) expect(r.doc.atribuicoes[id]).toBeUndefined();
  });
  test('DI-06 universo GC_NATIVE é calculado em memória (sem escrita) a partir de vendas_gc', async () => {
    const d = dadosBase({ nGc: 7 });
    const u = await construirUniversoHibrido({ perfis: d.perfis, clientes: d.clientes, vendas: d.vendas, dataReferencia: DR });
    expect(u.stats.gcNativeEmMemoria).toBe(7);
    expect(u.brutos.every(b => b.source === 'GC_NATIVE')).toBe(true);
  });
  test('DI-07 tendência SEM_BASE exibida como texto legível', () => {
    const ui = prepararDadosUI({ opportunityInstanceId: 'a'.repeat(16), tendencia: 'SEM_BASE', diasSemComprar: 200 });
    expect(ui.sinaisVisiveis.find(s => s.label === 'Tendência').valor).toBe('Histórico insuficiente');
  });
});

// ── Supressão / SEM_RESPOSTA / cooldown via gerador ──────────────────────────
describe('Regras operacionais aplicadas pelo gerador', () => {
  async function comEstado(fn, dataGeracao = NOW) {
    const base = await gerar();
    const alvo = minha(base).novas[0];
    const e = fn(criarEstadoInicial(alvo.commercialEntityId, alvo.opportunityInstanceId, alvo.tipoOportunidade, '2026-09-20T12:00:00.000Z'));
    const r = await gerar({ now: dataGeracao, dados: dadosBase({ estados: new Map([[alvo.opportunityInstanceId, e]]) }) });
    const todos = ['novas', 'followUps', 'emAtendimento'].flatMap(g => minha(r)[g]);
    return { alvo, r, todos, e };
  }
  test('RG-01 SEM_RESPOSTA na sexta → volta na segunda como retorno, não antes', async () => {
    const f = e => registrarOutcome(claimOportunidade(e, FAB, '2026-09-25T13:00:00.000Z'), FAB, 'SEM_RESPOSTA', '2026-09-25T13:05:00.000Z');
    const sex = await comEstado(f, new Date('2026-09-25T20:00:00.000Z'));
    expect(sex.e.nextFollowUpAt).toBe('2026-09-28');
    expect(sex.todos.map(x => x.commercialEntityId)).not.toContain(sex.alvo.commercialEntityId);
    const seg = await comEstado(f, new Date('2026-09-28T09:00:00.000Z'));
    expect(minha(seg.r).followUps.map(x => x.commercialEntityId)).toEqual([seg.alvo.commercialEntityId]);
    expect(minha(seg.r).novas).toHaveLength(10);
  });
  test('RG-02 3× SEM_RESPOSTA → cooldown, entidade fora da worklist', async () => {
    const f = e => {
      let s = e;
      for (const d of ['2026-09-21', '2026-09-22', '2026-09-23']) s = registrarOutcome(claimOportunidade(s, FAB, d + 'T13:00:00.000Z'), FAB, 'SEM_RESPOSTA', d + 'T13:05:00.000Z');
      return s;
    };
    const { alvo, r, todos, e } = await comEstado(f);
    expect(e.nextFollowUpAt).toBeNull();
    expect(e.cooledUntil).toBeTruthy();
    expect(todos.map(x => x.commercialEntityId)).not.toContain(alvo.commercialEntityId);
    expect(r.doc.contagens.excluidos.COOLDOWN).toBe(1);
  });
  test('RG-03 PEDIU_RETORNO futuro → não aparece antes da data', async () => {
    const { alvo, todos } = await comEstado(e => registrarOutcome(claimOportunidade(e, FAB, '2026-09-24T13:00:00.000Z'), FAB, 'PEDIU_RETORNO', '2026-09-24T13:05:00.000Z', { scheduledFor: '2026-09-30' }));
    expect(todos.map(x => x.commercialEntityId)).not.toContain(alvo.commercialEntityId);
  });
  test('RG-04 conversa concluída → entidade suprimida por 30 dias', async () => {
    const { alvo, todos, r } = await comEstado(e => registrarOutcome(claimOportunidade(e, FAB, '2026-09-24T13:00:00.000Z'), FAB, 'CONVERSA_REALIZADA', '2026-09-24T13:05:00.000Z'));
    expect(todos.map(x => x.commercialEntityId)).not.toContain(alvo.commercialEntityId);
    expect(minha(r).novas).toHaveLength(10);
  });
  test('RG-05 atendimento expirado (>4h) volta como nova disponível', async () => {
    const { alvo, r } = await comEstado(e => claimOportunidade(e, FAB, '2026-09-24T09:00:00.000Z'));
    expect(minha(r).novas.map(x => x.commercialEntityId)).toContain(alvo.commercialEntityId);
    expect(minha(r).emAtendimento).toHaveLength(0);
  });
  test('RG-06 atendimento de vendedor NÃO ativo (Ademir) não é entregue à Fabiana', async () => {
    const { alvo, todos } = await comEstado(e => claimOportunidade(e, ADEMIR, '2026-09-25T08:30:00.000Z'));
    expect(todos.map(x => x.commercialEntityId)).not.toContain(alvo.commercialEntityId);
  });
});
