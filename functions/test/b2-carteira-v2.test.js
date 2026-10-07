'use strict';
// B2 — carteira-v2: schema, backfill aditivo (zero mudança de owner), conflitos de identidade, histórico v1/v2, operações transacionais, script ponta a ponta (EMULADOR).
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), os = require('os'), path = require('path'), cp = require('child_process');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const C2 = require('../lib/carteiraV2'); const H2 = require('../lib/carteiraHistoricoV2'); const ID = require('../lib/identidadeConflitos'); const OWN = require('../lib/carteiraOwnership');
jest.setTimeout(240000);

const ADE = 'b2-ade', FAB = 'b2-fab', CAM = 'b2-cam', GES = 'b2-ges', VEND = 'b2-vend', BLOQ = 'b2-bloq';
const T0 = '2026-09-26T13:59:45.769Z';
const v1 = (gc, owner) => ({ schemaVersion: 'carteira-v1', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: owner === ADE ? '111' : '222', criadoEm: T0, atualizadoEm: T0, versao: 1 });
const ev1 = (gc, owner) => ({ ownerNovoUid: owner, portfolioId: 'GC:' + gc, operadorUid: GES, versao: 1, criadoEm: T0, motivo: 'Migração N35.26 — Onda 1', tipoEvento: 'CARTEIRA_CRIADA', identidadeUsada: 'GC_NATIVE:' + gc, chaveIdempotencia: 'MIGRACAO:N3526_ONDA1:GC:' + gc, ownerAnteriorUid: null });
const NA = 25, NF = 15, BASE = 9000000;
const idsA = Array.from({ length: NA }, (_, i) => String(BASE + 1 + i)), idsF = Array.from({ length: NF }, (_, i) => String(BASE + 100 + i));
const SEM = Array.from({ length: 12 }, (_, i) => String(BASE + 500 + i));
let tmp, fixture;
async function limpar(cols) { for (const c of cols) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } }
const rodar = (args, env = {}) => { const r = cp.spawnSync('node', [path.join(__dirname, '../scripts/b2_carteira_v2.js'), '--emulator', ...args], { env: { ...process.env, ...env }, encoding: 'utf8' }); let j = null; try { j = JSON.parse(r.stdout); } catch (_) { /* saída não-JSON */ } return { code: r.status, j, out: r.stdout, err: r.stderr }; };
const lerCarteiras = async () => Object.fromEntries((await db.collection('carteira_comercial').get()).docs.map(d => [d.id, d.data()]));
const raw = (id, extra) => ({ id, nome: 'NOME-PRIVADO-' + id, ...extra });

beforeAll(async () => {
  assert_emulator();
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'b2-'));
  await limpar(['carteira_comercial', 'carteira_comercial_historico', 'clientes', 'vendas_gc', 'users', 'sistema_usuarios', 'carteira_comercial_config', 'carteira_comercial_decisoes_sombra', 'audit_log']);
  for (const [uid, role, mods, nome] of [[ADE, 'funcionario', ['fila-comercial-operar'], 'Ademir B2'], [FAB, 'funcionario', ['fila-comercial-operar'], 'Fabiana B2'], [CAM, 'funcionario', ['fila-comercial-gestao'], 'Camila B2'],
    [GES, 'gestor', [], 'Gestor B2'], [VEND, 'funcionario', ['clientes'], 'Vend B2'], [BLOQ, 'funcionario', ['fila-comercial-operar'], 'Bloq B2']]) {
    await db.doc('users/' + uid).set({ role, ativo: true }); await db.doc('sistema_usuarios/' + uid).set({ nome, modulos: mods, admin: false, ...(uid === BLOQ ? { bloqueado: true } : {}) });
  }
  for (const gc of idsA) { await db.doc('carteira_comercial/GC:' + gc).set(v1(gc, ADE)); await db.doc('carteira_comercial_historico/MIGRACAO_N3526_ONDA1_GC_' + gc).set(ev1(gc, ADE)); }
  for (const gc of idsF) { await db.doc('carteira_comercial/GC:' + gc).set(v1(gc, FAB)); await db.doc('carteira_comercial_historico/MIGRACAO_N3526_ONDA1_GC_' + gc).set(ev1(gc, FAB)); }
  for (let i = 0; i < 6; i++) await db.doc('clientes/crm' + i).set({ nome: 'CRM ' + i, gestaoClickId: idsA[i] });
  await db.doc('carteira_comercial_config/regra').set({ modo: 'SOMBRA' });
  for (let i = 0; i < 5; i++) await db.doc('carteira_comercial_decisoes_sombra/d' + i).set({ decisao: 'MANTER' });
  // vendas: compradores = todas as carteiras + 8 dos SEM (4 antigas ≥120d)
  let n = 0; const venda = (cli, data) => db.doc('vendas_gc/b2v' + (n++)).set({ cliente_id: cli, data, nome_situacao: 'Concretizada', vendedor_id: '111' });
  for (const gc of [...idsA, ...idsF]) await venda(gc, '2026-09-20');
  for (let i = 0; i < 8; i++) await venda(SEM[i], i < 4 ? '2026-03-01' : '2026-09-25');
  // clientes GC (fixture hashed): grupo 1 (carteiras de donos diferentes, doc igual), grupo 2 (carteira + irmão sem carteira, telefone), grupo 3 (sem carteira, e-mail)
  const doc1 = '52998224725', tel2 = '85988887777', em3 = 'compartilhado@exemplo.com.br';
  const todos = [...idsA, ...idsF, ...SEM].map(id => raw(id, {}));
  const set = (id, ex) => { Object.assign(todos.find(c => c.id === id), ex); };
  set(idsA[0], { cpf: doc1 }); set(idsF[0], { cpf: doc1 });                       // G1 FORTE donosDiferentes
  set(idsA[1], { celular: '(85) 98888-7777' }); set(SEM[0], { telefone: tel2 });   // G2 MEDIA carteira+irmão
  set(SEM[1], { email: em3 }); set(SEM[2], { email: em3 });                         // G3 FRACA sem carteira
  fixture = path.join(tmp, 'gc.json'); fs.writeFileSync(fixture, JSON.stringify(todos.map(ID.derivarCliente)));
});
function assert_emulator() { if (!process.env.FIRESTORE_EMULATOR_HOST) throw new Error('SOMENTE emulador'); }
afterAll(async () => { await limpar(['carteira_comercial', 'carteira_comercial_historico', 'clientes', 'vendas_gc', 'users', 'sistema_usuarios', 'carteira_comercial_config', 'carteira_comercial_decisoes_sombra', 'audit_log']); fs.rmSync(tmp, { recursive: true, force: true }); });

describe('B2 — schema v2 (puro)', () => {
  const ctx = { eventoInicialId: 'EV1', clienteMr4Id: 'crm1', conflito: null, loteId: 'L', agoraIso: '2026-10-07T12:00:00.000Z' };
  test('backfill é aditivo: ownership idêntico, só campos aprovados, documento v2 válido', () => {
    const a = v1('123', ADE); const { patch, depois } = C2.montarPatchBackfillV2(a, ctx);
    expect(C2.linhaOwnership(a)).toBe(C2.linhaOwnership(depois));
    expect(Object.keys(patch).sort()).toEqual([...C2.CAMPOS_ALTERADOS_BACKFILL].sort());
    expect(depois).toMatchObject({ schemaVersion: 'carteira-v2', versao: 2, status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: 'crm1', ultimoEventoId: 'EV1', ownerUid: ADE, ownerDesde: T0 });
    expect(C2.validarDocCarteiraV2(depois)).toBeNull();
  });
  test('recusa: já v2, sem owner (não cria owner), sem evento inicial (não fabrica evento), versão inesperada', () => {
    expect(() => C2.montarPatchBackfillV2({ ...v1('1', ADE), schemaVersion: 'carteira-v2' }, ctx)).toThrow(/carteira-v1/);
    expect(() => C2.montarPatchBackfillV2({ ...v1('1', null) }, ctx)).toThrow(/sem owner/);
    expect(() => C2.montarPatchBackfillV2(v1('1', ADE), { ...ctx, eventoInicialId: null })).toThrow(/evento inicial/);
    expect(() => C2.montarPatchBackfillV2({ ...v1('1', ADE), versao: 3 }, ctx)).toThrow(/versao/);
  });
  test('conflito marca EM_REVISAO sem tocar o owner; validador rejeita PII e campos fora do schema', () => {
    const conf = { grupoId: 'CG-0123456789ab', tipos: ['DOC_IGUAL'], forca: 'FORTE', relacionados: ['GC:2'], donosDiferentes: true, revisao: 'PENDENTE', revisores: ['PROPRIETARIO', 'CAMILA'], detectadoEm: null, origemDeteccao: 'B2_BACKFILL' };
    const { depois } = C2.montarPatchBackfillV2(v1('1', FAB), { ...ctx, conflito: conf });
    expect(depois.status).toBe('EM_REVISAO'); expect(depois.ownerUid).toBe(FAB);
    expect(C2.validarDocCarteiraV2({ ...depois, telefone: '85' })).toMatch(/CAMPOS_NAO_PERMITIDOS/);
    expect(C2.validarDocCarteiraV2({ ...depois, status: 'EM_REVISAO', conflito: null })).toBe('REVISAO_SEM_CONFLITO');
    expect(C2.validarDocCarteiraV2({ ...depois, ownerUid: null })).toBe('OWNER_X_STATUS');
  });
  test('leitura compatível v1/v2 e histórico v1/v2', () => {
    expect(C2.lerCarteira(v1('1', ADE))).toMatchObject({ ownerUid: ADE, status: 'ATIVA', schema: 'carteira-v1' });
    const h1 = H2.normalizarEvento(ev1('1', ADE)); expect(h1).toMatchObject({ schema: 'historico-v1', tipoEvento: 'CARTEIRA_CRIADA', ownerNovoUid: ADE, origemOperacao: 'MIGRACAO', versaoDepois: 1 });
    const e2 = H2.montarEventoHistoricoV2({ portfolioId: 'GC:1', tipoEvento: 'RENOVACAO_CICLO', ownerAnteriorUid: ADE, ownerNovoUid: ADE, motivo: 'm', operadorUid: GES, atorTipo: 'USER', origemOperacao: 'CALLABLE', criadoEm: T0, versaoCarteiraAntes: 2, versaoCarteiraDepois: 3, seq: 3, chaveIdempotencia: 'k' });
    expect(H2.normalizarEvento(e2)).toMatchObject({ schema: 'historico-v2', versaoAntes: 2, versaoDepois: 3, seq: 3 });
    expect(() => H2.montarEventoHistoricoV2({ ...e2, tipoEvento: 'CONFLITO_RESOLVIDO', ownerNovoUid: FAB })).toThrow(/não pode alterar owner/);
  });
});

describe('B2 — conflitos de identidade (puro, sem PII)', () => {
  test('grupos, força, donos diferentes, irmão sem carteira; ninguém recebe owner', () => {
    const cart = new Map([['GC:1', { ownerUid: ADE }], ['GC:2', { ownerUid: FAB }], ['GC:3', { ownerUid: ADE }]]);
    const cs = [{ id: '1', doc: 'd1', fones: [], email: null }, { id: '2', doc: 'd1', fones: [], email: null }, { id: '3', doc: null, fones: ['f1'], email: null }, { id: '4', doc: null, fones: ['f1'], email: null },
      { id: '5', doc: null, fones: [], email: 'e1' }, { id: '6', doc: null, fones: [], email: 'e1' }, { id: '7', doc: 'x', fones: [], email: null }];
    const r = ID.detectarConflitos(cs, cart, '2026-10-07T00:00:00Z');
    expect(r.resumo).toMatchObject({ grupos: 3, clientes: 6, comCarteiraDeDonosDiferentes: 1, comCarteiraEIrmaoSem: 1, semNenhumaCarteira: 1, carteirasMarcadas: 3 });
    expect(r.porCarteira.get('GC:1')).toMatchObject({ forca: 'FORTE', donosDiferentes: true, revisao: 'PENDENTE', revisores: ['PROPRIETARIO', 'CAMILA'], relacionados: ['GC:2'] });
    expect(r.porCarteira.get('GC:3').relacionados).toEqual(['GC:4']);                            // irmão sem carteira só referenciado
    expect(r.porCarteira.has('GC:4')).toBe(false); expect(r.porCarteira.has('GC:5')).toBe(false);   // nenhuma carteira criada p/ quem não tem
    for (const g of r.grupos) expect(JSON.stringify(g)).not.toMatch(/ownerUid|vendedor/);
  });
  test('derivação não vaza o dado bruto (hash) e normaliza telefone antigo de 10 dígitos', () => {
    const d = ID.derivarCliente({ id: 5, nome: 'PRIVADO', cpf: '529.982.247-25', telefone: '(85) 8888-7777', email: 'A@B.COM', vendedor_id: 9 });
    expect(JSON.stringify(d)).not.toMatch(/PRIVADO|52998224725|88887777|a@b\.com/i); expect(d.doc).toMatch(/^[0-9a-f]{16}$/);
    expect(ID.telCanon('(85) 8888-7777')).toBe('85988887777'); expect(ID.telCanon('(85) 98888-7777')).toBe('85988887777'); expect(ID.telCanon('123')).toBeNull();
    expect(ID.cpfOk('52998224725')).toBe(true); expect(ID.cnpjOk('11222333000181')).toBe(true); expect(ID.cpfOk('11111111111')).toBe(false);
  });
});

describe('B2 — script ponta a ponta no emulador (backup → dry-run → execute → verify → rollback)', () => {
  let bdir, plano, sig, antes;
  test('backup válido (contagens, hashes, owner por contagem)', async () => {
    antes = await lerCarteiras(); bdir = path.join(tmp, 'bk');
    const r = rodar(['--mode=backup', `--out=${bdir}`]); expect(r.code).toBe(0);
    expect(r.j.colecoes['carteira_comercial.json'].documentos).toBe(NA + NF); expect(r.j.colecoes['carteira_comercial_historico.json'].documentos).toBe(NA + NF);
    expect(Object.values(r.j.contagemPorOwner).sort()).toEqual([NF, NA]);
    expect(fs.existsSync(path.join(bdir, 'manifest.json'))).toBe(true);
  });
  test('dry-run: ZERO mudança de owner / atribuição / transferência / carteira nova / evento novo', () => {
    const r = rodar(['--mode=dry-run', `--backup-dir=${bdir}`, `--plan-out=${path.join(tmp, 'plan.json')}`], { B2_GC_FIXTURE: fixture }); expect(r.code).toBe(0); plano = r.j; sig = plano.assinatura;
    expect(plano).toMatchObject({ ok: true, carteiras: NA + NF, OWNER_CHANGES_PLANNED: 0, NEW_OWNER_ASSIGNMENTS_PLANNED: 0, TRANSFERS_PLANNED: 0, NEW_CARTEIRAS_PLANNED: 0, HISTORY_EVENTS_PLANNED: 0, CARTEIRAS_A_ATUALIZAR: NA + NF });
    expect(plano.mutacoes).toMatchObject({ EM_REVISAO: 3, ATIVA: NA + NF - 3, comClienteMr4Id: 6 });
    expect(plano.conflitos).toMatchObject({ grupos: 3, comCarteiraDeDonosDiferentes: 1, comCarteiraEIrmaoSem: 1, semNenhumaCarteira: 1 });
    expect(plano.shadow.modo).toBe('SOMBRA'); expect(plano.universo.semCarteira).toBe(SEM.length); expect(plano.universo.compradoresSemCarteiraGe120).toBe(4);
    expect(JSON.stringify(plano)).not.toMatch(/NOME-PRIVADO/);
  });
  test('execute recusa: assinatura errada, --confirm errado, ownership alterado depois do backup, regra fora de SOMBRA', async () => {
    expect(rodar(['--mode=execute', `--backup-dir=${bdir}`, '--expected-signature=0000', `--confirm=${NA + NF}`], { B2_GC_FIXTURE: fixture }).code).toBe(2);
    expect(rodar(['--mode=execute', `--backup-dir=${bdir}`, `--expected-signature=${sig}`, '--confirm=1'], { B2_GC_FIXTURE: fixture }).code).toBe(2);
    await db.doc('carteira_comercial_config/regra').set({ modo: 'ATIVO' });
    expect(rodar(['--mode=execute', `--backup-dir=${bdir}`, `--expected-signature=${sig}`, `--confirm=${NA + NF}`], { B2_GC_FIXTURE: fixture }).code).toBe(2);
    await db.doc('carteira_comercial_config/regra').set({ modo: 'SOMBRA' });
    const alvo = 'carteira_comercial/GC:' + idsA[3]; await db.doc(alvo).update({ ownerUid: FAB });
    const r = rodar(['--mode=execute', `--backup-dir=${bdir}`, `--expected-signature=${sig}`, `--confirm=${NA + NF}`], { B2_GC_FIXTURE: fixture }); expect(r.code).toBe(2); expect(r.j.erro).toMatch(/ownership atual difere|alterada após/);
    await db.doc(alvo).update({ ownerUid: ADE });                                          // restaura o estado do backup (mesmo conteúdo)
    expect(Object.values((await lerCarteiras())).every(d => d.schemaVersion === 'carteira-v1')).toBe(true);
  });
  test('backup precisa refletir o estado atual: após o reparo manual o updateTime mudou → novo backup', async () => {
    bdir = path.join(tmp, 'bk2'); const b = rodar(['--mode=backup', `--out=${bdir}`]); expect(b.code).toBe(0); antes = await lerCarteiras();
    const d = rodar(['--mode=dry-run', `--backup-dir=${bdir}`], { B2_GC_FIXTURE: fixture }); expect(d.code).toBe(0); sig = d.j.assinatura;
  });
  test('execute aditivo → verify: 0 owner alterado, 0 novas/removidas, 0 histórico perdido, hash de ownership igual', async () => {
    const e = rodar(['--mode=execute', `--backup-dir=${bdir}`, `--expected-signature=${sig}`, `--confirm=${NA + NF}`], { B2_GC_FIXTURE: fixture }); expect(e.code).toBe(0); expect(e.j.atualizadas).toBe(NA + NF);
    const v = rodar(['--mode=verify', `--backup-dir=${bdir}`]); expect(v.code).toBe(0);
    expect(v.j).toMatchObject({ ok: true, CARTEIRAS_BEFORE: NA + NF, CARTEIRAS_AFTER: NA + NF, OWNER_CHANGED: 0, NEW_CARTEIRAS: 0, DELETED_CARTEIRAS: 0, HISTORY_LOST: 0, HISTORY_ADDED: 0, V2: NA + NF, V1_RESTANTES: 0, V2_INVALIDOS: 0, CAMPOS_ORIGINAIS_ALTERADOS: 0, STATUS_EM_REVISAO: 3 });
    expect(v.j.OWNERSHIP_HASH_BEFORE).toBe(v.j.OWNERSHIP_HASH_AFTER); expect(Object.values(v.j.OWNERS_AFTER).sort()).toEqual([NF, NA]);
    const depois = await lerCarteiras();
    for (const [k, a] of Object.entries(antes)) { const d = depois[k]; for (const f of C2.CAMPOS_OWNERSHIP) expect(d[f]).toBe(a[f]); expect(d.schemaVersion).toBe('carteira-v2'); expect(d.versao).toBe(2); expect(d.ultimoEventoId).toBe('MIGRACAO_N3526_ONDA1_GC_' + k.slice(3)); }
    // conflito não escolheu owner: os dois lados do grupo 1 mantêm seus donos e ambos EM_REVISAO
    expect(depois['GC:' + idsA[0]]).toMatchObject({ status: 'EM_REVISAO', ownerUid: ADE, conflito: { donosDiferentes: true, forca: 'FORTE', relacionados: ['GC:' + idsF[0]] } });
    expect(depois['GC:' + idsF[0]]).toMatchObject({ status: 'EM_REVISAO', ownerUid: FAB });
    expect(depois['GC:' + idsA[1]].conflito.relacionados).toEqual(['GC:' + SEM[0]]);
    expect((await db.doc('carteira_comercial/GC:' + SEM[0]).get()).exists).toBe(false);          // irmão sem carteira: NADA criado
    for (const s of SEM) expect(depois['GC:' + s]).toBeUndefined();                              // clientes sem carteira continuam sem carteira
    expect(depois['GC:' + idsA[0]].clienteMr4Id).toBe('crm0'); expect(depois['GC:' + idsA[10]].clienteMr4Id).toBeNull();
    expect((await db.collection('carteira_comercial_historico').get()).size).toBe(NA + NF);   // histórico intacto
  });
  test('reexecução é recusada (já v2) e rollback devolve exatamente o estado v1 sem tocar ownership', async () => {
    expect(rodar(['--mode=execute', `--backup-dir=${bdir}`, `--expected-signature=${sig}`, `--confirm=${NA + NF}`], { B2_GC_FIXTURE: fixture }).code).toBe(2);
    const r = rodar(['--mode=rollback', `--backup-dir=${bdir}`, `--confirm=${NA + NF}`]); expect(r.code).toBe(0); expect(r.j.revertidas).toBe(NA + NF);
    const volta = await lerCarteiras(); expect(volta).toEqual(antes);                      // documento a documento idêntico ao backup
    expect(rodar(['--mode=verify', `--backup-dir=${bdir}`]).code).toBe(0);
  });
});
