'use strict';
// B3.3 — ativação piloto: limites persistentes (5), corte por instante, saúde/disjuntor, kill switch, agendadores desligados por padrão. EMULADOR.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const R = require('../lib/reativacao120'); const OPS = require('../lib/reativacaoOps'); const PV = require('../lib/reativacaoVendas'); const JOB = require('../lib/reativacaoJob'); const SA = require('../lib/reativacaoSaude'); const Q = require('../lib/crmConsulta');
jest.setTimeout(240000);
const ADE = 'b33-ade', FAB = 'b33-fab', HOJE = '2026-10-08', dia = n => R.somarDias(HOJE, -n), T0 = '2026-09-26T13:59:45.769Z';
const AGORA = HOJE + 'T09:00:00.000Z'; const erro = p => p.then(() => 'OK', e => e.code || e.message);
const COLS = ['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_reativacao_decisoes', 'carteira_reativacao_decisoes_sombra', 'carteira_comercial_restricoes', 'identidade_conflitos', 'vendas_gc', 'users', 'sistema_usuarios', 'interacoes_fila', 'carteira_comercial_config', 'audit_log', 'carteira_comercial_devolucoes', 'carteira_comercial_revisoes'];
const limpar = async cols => { for (const c of cols) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const v2 = (gc, owner, ex = {}) => ({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: owner === ADE ? '111' : '222', criadoEm: T0, atualizadoEm: T0, versao: 2, status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: null, conflito: null, ultimoEventoId: 'E', ...ex });
const venda = (id, cli, data, gcVend, ex = {}) => ({ id: String(id), cliente_id: String(cli), data, vendedor_id: String(gcVend), nome_situacao: 'Concretizada', valor_total: '100', ...ex });
const seedV = async vs => { for (const v of vs) { const { id, ...r } = v; await db.doc('vendas_gc/' + id).set(r); } };
const nomes = async gc => 'Cliente ' + gc;
beforeAll(async () => { await limpar(COLS); for (const [uid, role, mods, cc] of [[ADE, 'funcionario', ['fila-comercial-operar'], '111'], [FAB, 'funcionario', ['fila-comercial-operar'], '222']]) { await db.doc('users/' + uid).set({ role, ativo: true });
  await db.doc('sistema_usuarios/' + uid).set({ nome: uid, modulos: mods, admin: false, carteiraComercial: { podePossuirCarteira: true, ativoComercialmente: true, gestaoClickVendedorId: cc, pausaTemporaria: false, desligado: false }, filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } }); } });
afterAll(async () => { await limpar(COLS); });
const preparar = async n => { await limpar(['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_reativacao_decisoes', 'vendas_gc', 'audit_log', 'carteira_comercial_config', 'interacoes_fila', 'identidade_conflitos', 'carteira_comercial_restricoes']);
  for (let i = 1; i <= n; i++) { const dono = i % 2 ? ADE : FAB; await db.doc('carteira_comercial/GC:' + (400 + i)).set(v2(String(400 + i), dono)); await seedV([venda(i, 400 + i, dia(130 + i), dono === ADE ? '111' : '222', { valor_total: String(100 + i) })]); }
  await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' }); await db.doc('carteira_comercial_config/reativacao').set({ modo: 'ATIVO', corte: HOJE, corteTs: AGORA, ativadoEm: AGORA, limiteDiario: 5, maxReservasAtivas: 5, incluirSemCarteira: false, piloto: true }); };
const job = ex => JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE, agoraIso: AGORA, lookupNome: nomes, ...ex });

describe('B3.3 — piloto: exatamente 5 por vendedor, limites persistentes, só carteiras existentes', () => {
  test('1ª execução libera 5 para Ademir e 5 para Fabiana (somente clientes COM carteira); sem carteira fica fora; owners intactos', async () => {
    await preparar(40); await seedV([venda(900, 999, dia(200), '999')]);                                          // comprador SEM carteira ≥120d: fora do piloto
    const r = await job({}); expect(r).toMatchObject({ status: 'ATIVO', criadas: 10 });
    const rs = (await db.collection('carteira_reativacoes').get()).docs.map(d => d.data()); expect(rs.filter(x => x.destinoUid === ADE)).toHaveLength(5); expect(rs.filter(x => x.destinoUid === FAB)).toHaveLength(5);
    expect(rs.every(x => x.tipo === 'CARTEIRA' && x.ownerUid && x.ownerUid !== x.destinoUid)).toBe(true); expect(rs.find(x => x.portfolioId === 'GC:999')).toBeUndefined();
    for (const x of rs) expect((await db.doc('carteira_comercial/' + x.portfolioId).get()).data().ownerUid).toBe(x.ownerUid);
    expect((await db.collection('carteira_comercial').get()).size).toBe(40);
  });
  test('execuções seguintes NÃO ampliam: mesmo dia = 0 novas; dias seguintes enquanto as 5 ativas existirem = 0 novas (teto de ativas); nunca chega a 10', async () => {
    const r2 = await job({}); expect(r2.criadas).toBe(0);
    const r3 = await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: R.somarDias(HOJE, 1), agoraIso: R.somarDias(HOJE, 1) + 'T09:00:00.000Z', lookupNome: nomes }); expect(r3.criadas).toBe(0);
    const ativas = (await db.collection('carteira_reativacoes').where('estado', '==', 'RESERVADA').get()).docs.map(d => d.data()); expect(ativas.filter(x => x.destinoUid === ADE)).toHaveLength(5); expect(ativas.filter(x => x.destinoUid === FAB)).toHaveLength(5);
  });
  test('o teto é imposto TAMBÉM na transação do servidor (liberarReserva): a 6ª reserva ativa do vendedor é recusada mesmo se o planejador falhar', async () => {
    const mk = async gc => { await db.doc('carteira_comercial/GC:' + gc).set(v2(String(gc), FAB)); return OPS.liberarReserva(db, FieldValue, { chave: R.chaveReativacao('GC:' + gc, dia(150)), portfolioId: 'GC:' + gc, ciclo: dia(150), tipo: 'CARTEIRA', ownerUid: FAB, destinoUid: ADE, liberadoEm: R.somarDias(HOJE, 3), nomeCliente: 'X', agoraIso: AGORA, limiteDiario: 5, maxAtivas: 5 }); };
    expect(await erro(mk(7001))).toBe('resource-exhausted');
  });
  test('depois que as reservas expiram/convertem abre-se vaga; o limite diário continua 5 (não vira 10)', async () => {
    const d2 = R.somarDias(HOJE, 8); await OPS.expirarReservas(db, d2, FieldValue);
    const r = await JOB.executarReativacaoDiaria(db, FieldValue, { hoje: d2, agoraIso: d2 + 'T09:00:00.000Z', lookupNome: nomes }); expect(r.criadas).toBe(10);
    const doDia = (await db.collection('carteira_reativacoes').where('liberadoEm', '==', d2).get()).docs.map(d => d.data()); expect(doDia.filter(x => x.destinoUid === ADE)).toHaveLength(5); expect(doDia.filter(x => x.destinoUid === FAB)).toHaveLength(5);
  });
  test('NENHUMA carteira foi transferida só por completar 120 dias (owners idênticos aos de entrada)', async () => {
    const owners = (await db.collection('carteira_comercial').get()).docs.map(d => [d.id, d.data().ownerUid]); for (const [id, o] of owners.filter(([id]) => Number(id.slice(3)) < 7000)) expect(o).toBe(Number(id.slice(3)) % 2 ? ADE : FAB); expect((await db.collection('carteira_comercial_historico').get()).size).toBe(0);
  });
});

describe('B3.3 — corte por INSTANTE de ativação (nada retroativo)', () => {
  test('vendas cadastradas antes do instante de ativação são ignoradas (mesmo no mesmo dia); depois, processadas', async () => {
    await preparar(2); await db.doc('carteira_comercial/GC:420').set(v2('420', ADE)); const ant = venda(20, 420, HOJE, '222', { cadastrado_em: '2026-10-08 05:59:59' }), dep = venda(21, 420, HOJE, '111', { cadastrado_em: '2026-10-08 06:30:00' }), semTs = venda(22, 420, HOJE, '111');
    await seedV([venda(19, 420, dia(60), '111'), ant, dep, semTs]);                                             // corteTs = 09:00Z = 06:00 Fortaleza
    const r = await PV.processarVendas(db, FieldValue, { agoraIso: AGORA, forcarDry: false, modoForcado: 'DRY' }); expect(r.vendasAvaliadas).toBe(1);                                  // só a das 06:30; 05:59 e sem timestamp (mesmo dia) ficam de fora
    expect(r.decisoes).toEqual({ RENOVAR_OWNER: 1 });
  });
});

describe('B3.3 — saúde e disjuntor', () => {
  test('estado saudável passa; violação (owner mudou sem evento) DESLIGA o motor sem apagar nada', async () => {
    await preparar(4); await job({}); expect((await SA.verificarSaude(db, { cfg: { limiteDiario: 5, maxReservasAtivas: 5 } })).ok).toBe(true);
    await db.doc('carteira_comercial/GC:401').update({ ownerUid: FAB });                                         // alteração indevida simulada (sem histórico) — sem evento não há como cruzar…
    await db.collection('carteira_comercial_historico').doc('ev_x').set({ portfolioId: 'GC:401', tipoEvento: 'REATIVACAO_120D_PRIMEIRA_VENDA', ownerNovoUid: ADE, criadoEm: AGORA, versaoCarteiraDepois: 3, referencias: { reservaChave: 'inexistente' } });
    const h = await SA.verificarSaude(db, { cfg: { limiteDiario: 5, maxReservasAtivas: 5 } }); expect(h.ok).toBe(false); expect(h.violacoes.map(v => v.tipo)).toEqual(expect.arrayContaining(['OWNER_DIVERGE_DO_HISTORICO', 'TRANSFERENCIA_SEM_RESERVA_VALIDA']));
    const antes = { c: (await db.collection('carteira_comercial').get()).size, r: (await db.collection('carteira_reativacoes').get()).size, h: (await db.collection('carteira_comercial_historico').get()).size };
    const out = await job({ agoraIso: AGORA }); expect(out.status).toBe('DISJUNTOR');
    expect((await db.doc('carteira_comercial_config/reativacao').get()).data()).toMatchObject({ modo: 'DESLIGADO', disjuntor: { origem: 'JOB_DIARIO' } });
    expect({ c: (await db.collection('carteira_comercial').get()).size, r: (await db.collection('carteira_reativacoes').get()).size, h: (await db.collection('carteira_comercial_historico').get()).size }).toEqual(antes);        // nada apagado
    expect((await db.collection('audit_log').where('action', '==', 'REACTIVATION_CIRCUIT_BREAKER').get()).size).toBe(1); expect((await job({})).status).toBe('DESLIGADO');
  });
  test('oportunidade duplicada e limite excedido são detectados', async () => {
    await preparar(2); await job({}); const doc = (await db.collection('carteira_reativacoes').get()).docs[0]; await db.collection('carteira_reativacoes').doc('rv_dup').set({ ...doc.data(), chave: 'REATIV:GC:999:2026-01-01' });
    const h = await SA.verificarSaude(db, { cfg: { limiteDiario: 1, maxReservasAtivas: 1 } }); expect(h.violacoes.map(v => v.tipo)).toEqual(expect.arrayContaining(['OPORTUNIDADE_DUPLICADA', 'LIMITE_PILOTO_EXCEDIDO', 'LIMITE_DIARIO_EXCEDIDO']));
  });
  test('erro no processamento de vendas aciona o disjuntor (ATIVO)', async () => {
    await preparar(2); await db.doc('carteira_comercial/GC:430').set(v2('430', ADE)); await seedV([venda(30, 430, dia(60), '111', { cadastrado_em: '2026-10-08 07:00:00' }), venda(31, 430, HOJE, '222', { cadastrado_em: '2026-10-08 07:10:00' })]);
    await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' }); const orig = OPS.aplicarDecisaoVenda; OPS.aplicarDecisaoVenda = async () => { throw new Error('falha simulada'); };
    try { const r = await PV.processarVendas(db, FieldValue, { agoraIso: AGORA }); expect(r.status).toBe('DISJUNTOR_ERRO'); } finally { OPS.aplicarDecisaoVenda = orig; }
    expect((await db.doc('carteira_comercial_config/reativacao').get()).data().modo).toBe('DESLIGADO');
  });
});

describe('B3.3 — desligado por padrão e kill switch', () => {
  test('sem configuração nada acontece (agendadores nascem desligados); motor R2 ou NENHUM impedem o ATIVO', async () => {
    await limpar(['carteira_comercial_config', 'carteira_reativacoes']); expect((await job({})).status).toBe('DESLIGADO'); expect((await PV.processarVendas(db, FieldValue, { agoraIso: AGORA })).status).toBe('DESLIGADO');
    await db.doc('carteira_comercial_config/reativacao').set({ modo: 'ATIVO', corte: HOJE }); await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'R2' });
    expect((await job({})).status).toBe('MOTOR_NAO_B3'); expect((await PV.processarVendas(db, FieldValue, { agoraIso: AGORA })).status).toBe('MOTOR_NAO_B3'); expect((await db.collection('carteira_reativacoes').get()).size).toBe(0);
  });
  test('kill switch: modo DESLIGADO + motor NENHUM para novas automações e preserva reservas, carteiras e histórico', async () => {
    await preparar(4); await job({}); const n = (await db.collection('carteira_reativacoes').get()).size; expect(n).toBeGreaterThan(0);
    await db.doc('carteira_comercial_config/reativacao').set({ modo: 'DESLIGADO' }, { merge: true }); await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'NENHUM' });
    expect((await job({ hoje: R.somarDias(HOJE, 9), agoraIso: R.somarDias(HOJE, 9) + 'T09:00:00Z' })).status).toBe('DESLIGADO'); expect((await PV.processarVendas(db, FieldValue, { agoraIso: AGORA })).status).toBe('DESLIGADO'); expect((await db.collection('carteira_reativacoes').get()).size).toBe(n);
    const f = await Q.crmConsultaHandler({ auth: { uid: ADE }, data: { acao: 'fila' } }, { db }); expect(f.reativacoes.length).toBeGreaterThan(0);                         // reservas existentes continuam visíveis/trabalháveis
  });
  test('agendadores existem no index.js (06:00 Fortaleza e de hora em hora) e o kill switch/saúde/ativação têm scripts', () => {
    const idx = fs.readFileSync(path.join(__dirname, '../index.js'), 'utf8'); expect(idx).toMatch(/exports\.reativacaoDiaria = onSchedule\(\{\s*schedule: '0 6 \* \* \*', timeZone: 'America\/Fortaleza'/); expect(idx).toMatch(/exports\.reativacaoVendas = onSchedule\(\{\s*schedule: '50 \* \* \* \*'/);
    for (const f of ['b3_desligar.js', 'b3_saude.js', 'b3_3_ativar.js']) expect(fs.existsSync(path.join(__dirname, '../scripts', f))).toBe(true);
    expect(fs.readFileSync(path.join(__dirname, '../scripts/b3_desligar.js'), 'utf8')).not.toMatch(/\.delete\(|recursiveDelete/);                               // kill switch nunca apaga
  });
});
