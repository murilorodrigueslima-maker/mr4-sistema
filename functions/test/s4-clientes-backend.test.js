'use strict';
// S4 — crmConsulta { clientesMeus | clienteBusca } (EMULADOR): escopo, minimização, anti-enumeração, limite, auditoria.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const Q = require('../lib/crmConsulta'); const CC = require('../lib/crmClientes');
jest.setTimeout(60000);
const ADE = 's4b-ade', FAB = 's4b-fab', BLOQ = 's4b-bloq', SEM = 's4b-sem', GES = 's4b-ges', CAM = 's4b-cam';
const criados = []; const put = async (p, d) => { criados.push(p); await db.doc(p).set(d); };
const req = (uid, data) => ({ auth: uid ? { uid } : null, data });
const call = (uid, data) => Q.crmConsultaHandler(req(uid, data), { db });
const erro = p => p.then(() => 'OK', e => e.code + ':' + e.message);
const busca = (uid, campo, valor) => call(uid, { acao: 'clienteBusca', campo, valor });

beforeAll(async () => {
  for (const [uid, role, mods, extra] of [[ADE, 'funcionario', ['clientes', 'fila-comercial-operar'], {}], [FAB, 'funcionario', ['clientes', 'fila-comercial-operar'], {}], [BLOQ, 'funcionario', ['clientes'], { bloqueado: true }],
    [SEM, 'funcionario', ['fila-comercial-operar'], {}], [GES, 'gestor', [], {}], [CAM, 'funcionario', ['fila-comercial-gestao'], {}]]) { await put('users/' + uid, { role, ativo: true }); await put('sistema_usuarios/' + uid, { nome: uid, modulos: mods, admin: false, ...extra }); }
  await put('carteira_comercial/GC:s4g1', { ownerUid: ADE }); await put('carteira_comercial/GC:s4g2', { ownerUid: FAB });
  await put('clientes/s4c1', { nome: 'Cliente do Ademir', tipo: 'PJ', cidade: 'Fortaleza', estado: 'CE', pipeline: 'ativo', telefone: '(85) 9999-1111', cpf_cnpj: '11222333000144', gestaoClickId: 's4g1', notas: [{ texto: 'nota interna' }], vendas: [{ v: 1 }], tags: ['a'] });
  await put('clientes/s4c2', { nome: 'Cliente da Fabiana', cidade: 'Recife', estado: 'PE', pipeline: 'lead', telefone: '(81) 98888-2222', gestaoClickId: 's4g2', notas: [{ texto: 'segredo da Fabiana' }] });
  await put('clientes/s4c3', { nome: 'Sem Carteira', cidade: 'Natal', estado: 'RN', pipeline: 'lead', telefone: '(84) 97777-3333', cpf_cnpj: '12345678901', notas: [{ texto: 'nota de alguém' }], vendas: [{ v: 2 }] });
  await put('clientes/s4c4', { nome: 'Arquivado', telefone: '(85) 9999-4444', arquivado: true });
});
afterAll(async () => {
  for (const p of criados) await db.doc(p).delete();
  for (const u of [ADE, FAB, GES, CAM, SEM, BLOQ]) await db.doc('crm_busca_limite/' + u).delete();
  for (const d of (await db.collection('audit_log').where('entityId', '==', 'busca').get()).docs) await d.ref.delete();
});

describe('S4 — autorização e payload', () => {
  test('anônimo, bloqueado e sem módulo clientes são recusados; Camila (só gestão de fila) também', async () => {
    expect(await erro(call(null, { acao: 'clientesMeus' }))).toMatch(/^unauthenticated/);
    for (const u of [BLOQ, SEM, CAM]) { expect(await erro(call(u, { acao: 'clientesMeus' }))).toBe('permission-denied:SEM_PERMISSAO'); expect(await erro(busca(u, 'telefone', '(85) 9999-1111'))).toBe('permission-denied:SEM_PERMISSAO'); }
  });
  test('identidade só do login; payload estrito; valores curtos/inválidos não viram varredura', async () => {
    expect(await erro(call(ADE, { acao: 'clientesMeus', sellerUid: FAB }))).toBe('invalid-argument:CAMPOS_NAO_PERMITIDOS');
    expect(await erro(call(ADE, { acao: 'clienteBusca', campo: 'telefone', valor: '8599', sellerUid: FAB }))).toBe('invalid-argument:CAMPOS_NAO_PERMITIDOS');
    for (const [campo, valor] of [['telefone', '85'], ['telefone', '859999'], ['cpf_cnpj', '123'], ['cpf_cnpj', '1234567890'], ['email', 'a'], ['email', '@'], ['email', 'abc@d'], ['nome', 'Cliente'], ['telefone', '%'], ['telefone', 'x'.repeat(200)]])
      expect(await erro(busca(ADE, campo, valor))).toMatch(/^invalid-argument/);
    expect(await erro(call(ADE, { acao: 'clienteBusca', campo: 'telefone', valor: 5 }))).toBe('invalid-argument:VALOR_INVALIDO');
    expect(await erro(call(ADE, { acao: 'clienteBusca', campo: ['telefone'], valor: '85999911111' }))).toBe('invalid-argument:CAMPO_INVALIDO');
  });
});

describe('S4 — carteira própria', () => {
  test('clientesMeus devolve só os clientes da carteira do vendedor (com contato completo e notas)', async () => {
    const a = await call(ADE, { acao: 'clientesMeus' }); const ids = a.clientes.map(c => c.id).filter(i => i.startsWith('s4c'));
    expect(ids).toEqual(['s4c1']); expect(a.clientes.find(c => c.id === 's4c1')).toMatchObject({ vinculo: 'MINHA', nome: 'Cliente do Ademir', notas: [{ texto: 'nota interna' }] });
    const f = await call(FAB, { acao: 'clientesMeus' }); expect(f.clientes.map(c => c.id).filter(i => i.startsWith('s4c'))).toEqual(['s4c2']);
    expect(JSON.stringify(a)).not.toContain('Fabiana'); expect(JSON.stringify(f)).not.toContain('Ademir');
  });
  test('gestão não recebe a base pelo endpoint (usa leitura direta)', async () => {
    const g = await call(GES, { acao: 'clientesMeus' }); expect(g.escopo).toBe('GESTAO'); expect(g.clientes).toEqual([]);
  });
});

describe('S4 — pesquisa pontual', () => {
  test('encontra pelo telefone em qualquer formato; meu cliente vem completo', async () => {
    for (const v of ['(85) 9999-1111', '8599991111', '+55 85 9999-1111', '85 9999-1111']) {
      const r = await busca(ADE, 'telefone', v); expect(r.resultados.map(x => x.id)).toEqual(['s4c1']); expect(r.resultados[0].vinculo).toBe('MINHA');
    }
  });
  test('cliente de OUTRO vendedor: sem dados, só o aviso de ocupado (sem id, nome, telefone, notas)', async () => {
    const r = await busca(ADE, 'telefone', '81988882222');
    expect(r.resultados).toEqual([]); expect(r.ocupadosPorOutroVendedor).toBe(1);
    expect(JSON.stringify(r)).not.toMatch(/Fabiana|s4c2|segredo|8888/);
  });
  test('sem carteira: dados mínimos, CPF/CNPJ mascarado, sem notas/vendas internas', async () => {
    const r = await busca(ADE, 'telefone', '84977773333'); const c = r.resultados[0];
    expect(c).toMatchObject({ id: 's4c3', vinculo: 'SEM_CARTEIRA', nome: 'Sem Carteira', cpf_cnpj: '***901', notas: [], vendas: [] });
    expect(JSON.stringify(r)).not.toContain('12345678901'); expect(JSON.stringify(r)).not.toContain('nota de alguém');
    const doc = await busca(FAB, 'cpf_cnpj', '123.456.789-01'); expect(doc.resultados[0].id).toBe('s4c3');
  });
  test('arquivado e inexistente não aparecem; gestão vê completo', async () => {
    expect((await busca(ADE, 'telefone', '85999914444')).resultados).toEqual([]);
    expect((await busca(ADE, 'telefone', '11933330000')).resultados).toEqual([]);
    const g = await busca(GES, 'telefone', '81988882222'); expect(g.resultados[0]).toMatchObject({ id: 's4c2', vinculo: 'GESTAO', notas: [{ texto: 'segredo da Fabiana' }] });
  });
  test('máximo de resultados e limite por hora (anti-enumeração) — 429 depois de 40 buscas', async () => {
    const lim = CC.LIMITE_BUSCAS_HORA; const antes = (await db.doc('crm_busca_limite/' + FAB).get()).data().n;
    for (let i = antes; i < lim; i++) await busca(FAB, 'telefone', '85911110000');
    expect(await erro(busca(FAB, 'telefone', '85911110000'))).toBe('resource-exhausted:LIMITE_DE_BUSCAS');
    expect(await erro(call(FAB, { acao: 'clientesMeus' }))).toBe('OK');                              // carteira própria não consome a cota
  });
  test('limite reinicia após a janela de 1 h', async () => {
    await db.doc('crm_busca_limite/' + FAB).set({ janelaInicioMs: Date.now() - 3600001, n: 40 });
    expect(await erro(busca(FAB, 'telefone', '85911110000'))).toBe('OK');
  });
});

describe('S4 — auditoria da busca (S7)', () => {
  test('registra quem buscou, campo, hash e contagem — nunca o termo', async () => {
    const l = (await db.collection('audit_log').where('action', '==', 'CRM_CLIENT_SEARCH').where('actorUid', '==', ADE).get()).docs.map(d => d.data());
    expect(l.length).toBeGreaterThan(0);
    const txt = JSON.stringify(l);
    for (const t of ['9999-1111', '99991111', '88882222', '12345678901']) expect(txt).not.toContain(t);
    expect(l[0]).toMatchObject({ category: 'CRM', actorType: 'USER', entityType: 'clientes' }); expect(l[0].metadata.termoHash).toMatch(/^sha256:/);
  });
});

describe('S4 — variantes (puro)', () => {
  test('formatos aceitos e rejeitados', () => {
    expect(CC.variantes('telefone', '(85) 99999-1111')).toEqual(['85999991111', '(85) 99999-1111', '85 99999-1111', '5585999991111']);
    expect(CC.variantes('cpf_cnpj', '112.223.330-0014')).toBeNull();
    expect(CC.variantes('cpf_cnpj', '11.222.333/0001-44')).toContain('11222333000144');
    expect(CC.variantes('email', 'A@b.co')).toEqual(['A@b.co', 'a@b.co']);
    expect(CC.variantes('telefone', '123')).toBeNull();
  });
});
