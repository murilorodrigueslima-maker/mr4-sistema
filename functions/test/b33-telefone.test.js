'use strict';
// Telefone do cliente nos cartões/ficha de reativação: autorização no backend, escolha celular>comercial, nada persistido/logado, WhatsApp. EMULADOR.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const R = require('../lib/reativacao120'); const OPS = require('../lib/reativacaoOps'); const CT = require('../lib/contatoReativacao'); const GC = require('../lib/contatoGc');
jest.setTimeout(120000);
const ADE = 'tel-ade', FAB = 'tel-fab', CAM = 'tel-cam', GES = 'tel-ges', SEM = 'tel-sem', BLOQ = 'tel-bloq', HOJE = '2026-10-08', T0 = '2026-09-26T13:59:45.769Z', dia = n => R.somarDias(HOJE, -n);
const NUM_ADE = '85999912345', NUM_FAB = '85988776655';                                                                          // números sintéticos de teste
const COLS = ['carteira_comercial', 'carteira_reativacoes', 'carteira_comercial_restricoes', 'users', 'sistema_usuarios', 'audit_log', 'carteira_comercial_historico', 'vendas_gc'];
const limpar = async cols => { for (const c of cols) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const v2 = (gc, owner) => ({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: '1', criadoEm: T0, atualizadoEm: T0, versao: 2, status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: null, conflito: null, ultimoEventoId: 'E' });
const req = (uid, d) => ({ auth: uid ? { uid } : null, data: d }); const erro = p => p.then(() => 'OK', e => e.code || e.message);
const chamadas = []; const lookup = async gc => { chamadas.push(gc); return gc === '600' ? { celular: '(85) 99991-2345', telefone: '(85) 3222-1000' } : gc === '601' ? { telefone: '(85) 8877-6655' } : gc === '602' ? { telefone: '(85) 3222-1000' } : gc === '603' ? {} : null; };
const h = (uid, opp, extra = {}) => CT.contatoReativacaoHandler(req(uid, { opportunityInstanceId: opp }), { db, lookup, now: () => new Date(HOJE + 'T13:00:00Z'), ...extra });
let O = {};
beforeAll(async () => {
  await limpar(COLS);
  for (const [uid, role, mods, ativo, bl] of [[ADE, 'funcionario', ['fila-comercial-operar'], true, false], [FAB, 'funcionario', ['fila-comercial-operar'], true, false], [CAM, 'funcionario', ['fila-comercial-gestao'], true, false], [GES, 'gestor', [], true, false], [SEM, 'funcionario', ['ponto'], true, false], [BLOQ, 'funcionario', ['fila-comercial-operar'], true, true]]) {
    await db.doc('users/' + uid).set({ role, ativo }); await db.doc('sistema_usuarios/' + uid).set({ nome: uid, modulos: mods, admin: false, ...(bl ? { bloqueado: true } : {}) }); }
  for (const [gc, dono, dest] of [[600, FAB, ADE], [601, ADE, FAB], [602, FAB, ADE], [603, FAB, ADE]]) {
    await db.doc('carteira_comercial/GC:' + gc).set(v2(String(gc), dono));
    const r = await OPS.liberarReserva(db, FieldValue, { chave: R.chaveReativacao('GC:' + gc, dia(150)), portfolioId: 'GC:' + gc, ciclo: dia(150), tipo: 'CARTEIRA', ownerUid: dono, destinoUid: dest, liberadoEm: HOJE, nomeCliente: 'Cliente ' + gc, agoraIso: HOJE + 'T09:00:00Z' }); O[gc] = r.doc.opportunityInstanceId; }
});
afterAll(async () => { await limpar(COLS); });

describe('escolha do contato (puro)', () => {
  test('prioriza celular/WhatsApp; celular antigo de 10 dígitos ganha o 9; sem celular usa o comercial; nada válido ⇒ null', () => {
    expect(GC.escolherContato({ celular: '(85) 99991-2345', telefone: '(85) 3222-1000' })).toEqual({ tipo: 'CELULAR', numero: NUM_ADE, exibicao: '(85) 99991-2345', whatsapp: '55' + NUM_ADE });
    expect(GC.escolherContato({ telefone: '(85) 3222-1000', contatos: [{ contato: { celular: '85 98877-6655' } }] })).toMatchObject({ tipo: 'CELULAR', numero: NUM_FAB });
    expect(GC.escolherContato({ telefone: '(85) 8877-6655' })).toMatchObject({ tipo: 'CELULAR', numero: '85988776655', whatsapp: '5585988776655' });
    expect(GC.escolherContato({ telefone: '(85) 3222-1000' })).toEqual({ tipo: 'COMERCIAL', numero: '8532221000', exibicao: '(85) 3222-1000', whatsapp: null });
    expect(GC.escolherContato({ celular: '123', telefone: '', fax: '00000000000' })).toBeNull(); expect(GC.escolherContato(null)).toBeNull();
  });
});

describe('autorização no backend', () => {
  test('o vendedor reservado recebe o telefone; o outro vendedor NÃO (Ademir × Fabiana), sem consultar o GestãoClick', async () => {
    chamadas.length = 0;
    const r = await h(ADE, O[600]); expect(r).toEqual({ bloqueado: false, tipo: 'CELULAR', exibicao: '(85) 99991-2345', whatsapp: '5585999912345' }); expect(chamadas).toEqual(['600']);
    chamadas.length = 0; expect(await erro(h(FAB, O[600]))).toBe('permission-denied'); expect(await erro(h(ADE, O[601]))).toBe('permission-denied'); expect(chamadas).toEqual([]);          // negado ⇒ lookup nunca chamado
    expect((await h(FAB, O[601])).whatsapp).toBe('5585988776655');
  });
  test('gestão (proprietário e Camila) pode; sem módulo, bloqueado, anônimo, oportunidade inexistente e pedido inválido não', async () => {
    for (const u of [GES, CAM]) expect((await h(u, O[600])).tipo).toBe('CELULAR');
    for (const u of [SEM, BLOQ]) expect(await erro(h(u, O[600]))).toBe('permission-denied'); expect(await erro(h(null, O[600]))).toBe('unauthenticated');
    expect(await erro(h(ADE, 'abcdefabcdefabcd'))).toBe('permission-denied'); expect(await erro(h(ADE, 'xyz'))).toBe('invalid-argument');
    expect(await erro(CT.contatoReativacaoHandler(req(ADE, { opportunityInstanceId: O[600], telefone: '1' }), { db, lookup }))).toBe('invalid-argument');
  });
  test('reserva vencida/encerrada deixa de liberar o contato ao vendedor (a gestão continua podendo consultar reservas ativas)', async () => {
    expect(await erro(CT.contatoReativacaoHandler(req(ADE, { opportunityInstanceId: O[600] }), { db, lookup, now: () => new Date('2026-10-20T13:00:00Z') }))).toBe('permission-denied');
    const ref = (await db.collection('carteira_reativacoes').where('portfolioId', '==', 'GC:602').get()).docs[0].ref; await ref.update({ estado: 'ENCERRADA' }); expect(await erro(h(ADE, O[602]))).toBe('permission-denied'); await ref.update({ estado: 'RESERVADA' });
  });
  test('NÃO CONTATAR: nada é retornado nem consultado; sem telefone cadastrado e falha do GestãoClick tratados', async () => {
    await db.doc('carteira_comercial_restricoes/GC:602').set({ naoContatar: true }); chamadas.length = 0; expect(await h(ADE, O[602])).toEqual({ bloqueado: true, motivo: 'NAO_CONTATAR' }); expect(chamadas).toEqual([]); await db.doc('carteira_comercial_restricoes/GC:602').delete();
    expect((await h(ADE, O[603])).tipo).toBe('SEM_TELEFONE'); expect((await h(ADE, O[602])).tipo).toBe('COMERCIAL');
    await db.collection('carteira_reativacoes').doc((await db.collection('carteira_reativacoes').where('portfolioId', '==', 'GC:603').get()).docs[0].id).update({ ultimoTeste: 1 });
    expect(await erro(h(ADE, O[600], { lookup: async () => { throw new Error('GC fora do ar'); } }))).toBe('unavailable'); expect(await erro(h(ADE, O[600], { lookup: async () => null }))).toBe('unavailable');
  });
});

describe('o número não vaza para lugar nenhum', () => {
  test('nada gravado: nenhum documento do Firestore (reservas, carteiras, restrições, AUDITORIA) contém os números; auditoria só tem quem/quando/cliente', async () => {
    await h(ADE, O[600]); await h(GES, O[601]); const todos = JSON.stringify(await Promise.all(COLS.map(async c => (await db.collection(c).get()).docs.map(d => d.data()))));
    for (const n of [NUM_ADE, NUM_FAB, '99991-2345', '98877-6655', '3222-1000', '8532221000']) expect(todos).not.toContain(n);
    const aud = (await db.collection('audit_log').where('action', '==', 'REACTIVATION_CONTACT_VIEWED').get()).docs.map(d => d.data()); expect(aud.length).toBeGreaterThan(0);
    expect(aud.every(a => a.category === 'COMMERCIAL' && a.actorUid && a.metadata && Object.keys(a.metadata).join() === 'tipo')).toBe(true);
  });
  test('o código do backend não registra o número (sem console.* no módulo) e não altera owner/reservas/histórico', async () => {
    expect(fs.readFileSync(path.join(__dirname, '../lib/contatoReativacao.js'), 'utf8')).not.toMatch(/console\./); expect(fs.readFileSync(path.join(__dirname, '../lib/contatoGc.js'), 'utf8')).not.toMatch(/console\./);
    const antes = JSON.stringify((await db.collection('carteira_comercial').get()).docs.map(d => d.data())) + JSON.stringify((await db.collection('carteira_reativacoes').get()).docs.map(d => [d.id, d.data().estado, d.data().destinoUid]));
    await h(ADE, O[600]); await h(FAB, O[601]); const depois = JSON.stringify((await db.collection('carteira_comercial').get()).docs.map(d => d.data())) + JSON.stringify((await db.collection('carteira_reativacoes').get()).docs.map(d => [d.id, d.data().estado, d.data().destinoUid]));
    expect(depois).toBe(antes); expect((await db.collection('carteira_comercial_historico').get()).size).toBe(0);
  });
});

describe('tela (crm.html)', () => {
  const html = fs.readFileSync(path.join(__dirname, '../../modulos/crm.html'), 'utf8'), idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8');
  test('botão "Ver telefone" no cartão e na ficha; WhatsApp abre wa.me em nova aba com noopener; sem armazenamento local do número', () => {
    expect(html).toContain("httpsCallable(funcs, 'crmContatoReativacao')"); expect(html).toContain('Ver telefone'); expect(html).toMatch(/https:\/\/wa\.me\/\$\{esc\(c\.whatsapp\)\}" target="_blank" rel="noopener noreferrer"/);
    expect(html).toMatch(/\$\{rt \? `<div class="hist contato">\$\{contatoHtml\(id\)\}<\/div>` : ''\}/); expect(html).toMatch(/rv \? `<span class="contato">\$\{contatoHtml\(rv\.opportunityInstanceId\)\}<\/span>`/);
    expect(html).not.toMatch(/localStorage|sessionStorage|indexedDB/); expect(html).not.toMatch(/console\.(log|info|warn)\([^)]*(exibicao|whatsapp)/);
  });
  test('Function dedicada com os segredos do GestãoClick (crmConsulta continua sem segredos)', () => {
    expect(idx).toMatch(/exports\.crmContatoReativacao = onCall\(\{ region: REGION, secrets: \['GC_ACCESS_TOKEN', 'GC_SECRET_ACCESS_TOKEN'\] \}/); expect(idx).toMatch(/exports\.crmConsulta\s+= onCall\(\{ region: REGION \}/);
  });
});
