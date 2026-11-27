'use strict';
// INF-01/INF-12 — EQUIVALÊNCIA entre a varredura completa (processarVendas, referência) e a execução incremental, mais trava e fail-closed.
// Padrão: Firestore em memória. EQUIV_EMULADOR=host:porta roda os mesmos cenários no emulador (dois projetos isolados).
const EMU = process.env.EQUIV_EMULADOR || null;
if (EMU) process.env.FIRESTORE_EMULATOR_HOST = EMU;
const R = require('../lib/reativacao120'); const OPS = require('../lib/reativacaoOps'); const PV = require('../lib/reativacaoVendas'); const INC = require('../lib/reativacaoIncremental');
const { agoraNoFusoGc } = require('../lib/carteiraRegra'); const FAKE = require('./helpers/fakeFirestore');
jest.setTimeout(240000);

const VD1 = 'inc-vd1', VD2 = 'inc-vd2', GES = 'inc-ges', CORTE = '2026-09-27', T0 = '2026-09-26T13:59:45.769Z', D0 = '2026-10-07';
const COMPARADAS = ['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_reativacao_decisoes', 'carteira_comercial_revisoes', 'audit_log', 'carteira_comercial_config'];
const TODAS = [...COMPARADAS, 'carteira_reativacao_decisoes_sombra', 'carteira_comercial_devolucoes', 'carteira_comercial_restricoes', 'identidade_conflitos', 'vendas_gc', 'users', 'sistema_usuarios', 'interacoes_fila', 'clientes', 'sync_state', 'reativacao_estado'];
const dia = (base, n) => R.somarDias(base, n);

let admin;
async function novaLoja(nome) {
  if (!EMU) return { db: FAKE.criarFake(), FV: FAKE.FieldValue };
  admin = admin || require('firebase-admin');
  const projectId = 'demo-inc-' + nome; const app = admin.apps.find(a => a && a.name === projectId) || admin.initializeApp({ projectId }, projectId);
  await fetch(`http://${EMU}/emulator/v1/projects/${projectId}/databases/(default)/documents`, { method: 'DELETE' });
  return { db: app.firestore(), FV: admin.firestore.FieldValue };
}

/** Um "mundo" = loja + relógio comercial. As mutações imitam o sync: escrevem em vendas_gc e avançam o cursor confirmado. */
async function criarMundo(nome) {
  const { db, FV } = await novaLoja(nome);
  const m = { db, FV, hoje: D0, minuto: 0, cursor: '2026-10-01 00:00:00', recon: '2026-10-01T00:00:00.000Z' };
  m.agora = () => new Date(Date.parse(m.hoje + 'T12:00:00.000Z') + m.minuto * 60000).toISOString();               // minuto negativo = madrugada UTC
  m.sync = async (extra = {}) => db.doc('sync_state/perfil360').set({ status: 'READY', modifiedSinceCursor: m.cursor, lastReconciliationAt: m.recon, lastBootstrapAt: T0, ...extra });
  const carimbo = () => { m.cursor = agoraNoFusoGc(m.agora()); return m.cursor; };
  m.venda = async (id, cli, data, gcVend, ex = {}) => { await db.doc('vendas_gc/' + id).set({ id: String(id), cliente_id: String(cli), data, vendedor_id: String(gcVend), nome_situacao: 'Concretizada', valor_total: '100', cadastrado_em: data + ' 12:00:00', modificado_em: carimbo(), ...ex }); await m.sync(); };
  m.alterar = async (id, ex) => { await db.doc('vendas_gc/' + id).update({ modificado_em: carimbo(), ...ex }); await m.sync(); };
  m.excluir = async id => db.doc('vendas_gc/' + id).delete();
  m.devolucao = async (docId, vendaId, tipo) => db.doc('carteira_comercial_devolucoes/' + docId).set({ vendaId: String(vendaId), tipo });
  m.carteira = async (gc, owner, ex = {}) => db.doc('carteira_comercial/GC:' + gc).set({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: owner === VD1 ? '111' : '222', criadoEm: T0, atualizadoEm: T0, versao: 2,
    status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: null, conflito: null, ultimoEventoId: 'E', ...ex });
  m.reservar = async (gc, destino, owner, liberadoEm, ciclo) => OPS.liberarReserva(db, FV, { chave: R.chaveReativacao('GC:' + gc, ciclo), portfolioId: 'GC:' + gc, ciclo, tipo: owner ? 'CARTEIRA' : 'SEM_CARTEIRA', ownerUid: owner || null, destinoUid: destino, liberadoEm, nomeCliente: 'C' + gc, agoraIso: liberadoEm + 'T09:00:00.000Z' });
  m.cfg = async (extra = {}) => db.doc('carteira_comercial_config/reativacao').set({ modo: 'ATIVO', corte: CORTE, ...extra });
  await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' });
  for (const [uid, role, mods, cc] of [[VD1, 'funcionario', ['fila-comercial-operar'], '111'], [VD2, 'funcionario', ['fila-comercial-operar'], '222'], [GES, 'gestor', [], null]]) {
    await db.doc('users/' + uid).set({ role, ativo: true });
    await db.doc('sistema_usuarios/' + uid).set({ nome: uid, modulos: mods, admin: false, ...(cc ? { carteiraComercial: { podePossuirCarteira: true, ativoComercialmente: true, gestaoClickVendedorId: cc, pausaTemporaria: false, desligado: false }, filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } } : {}) });
  }
  await m.cfg(); await m.sync();
  return m;
}
/** Estado de negócio, sem os campos que dependem do relógio real do servidor. */
async function retrato(m) {
  const out = {};
  for (const c of COMPARADAS) {
    const s = await m.db.collection(c).get();
    out[c] = s.docs.map(d => { const x = { ...d.data() }; delete x.at; return [d.id, x]; }).sort((a, b) => (a[0] < b[0] ? -1 : 1));
  }
  return out;
}
/** Par referência × incremental: toda mutação é aplicada nos dois; cada rodada compara o estado persistido. */
async function criarPar() {
  const ref = await criarMundo('ref'), inc = await criarMundo('inc'); let n = 0;
  const par = {
    ref, inc,
    async ambos(fn) { await fn(ref); await fn(inc); },
    async rodar({ comparar = true, opcoes = {} } = {}) {
      n++; ref.minuto = inc.minuto = inc.minuto + 7;
      const runId = 'run-' + n; const agoraIso = inc.agora();
      const lancou = e => ({ status: 'LANCOU', erro: e.message });                          // erro propagado: tem de ser o MESMO nos dois
      const a = await PV.processarVendas(ref.db, ref.FV, { agoraIso, runId }).catch(lancou);
      const b = await INC.executarReativacaoVendas(inc.db, inc.FV, { agoraIso, runId, ...opcoes }).catch(lancou);
      if (comparar) { expect([b.status, b.erro, b.aplicadas]).toEqual([a.status, a.erro, a.aplicadas]); expect(await retrato(inc)).toEqual(await retrato(ref)); }
      return { a, b };
    },
    avancar(dias = 1) { for (const m of [ref, inc]) { m.hoje = dia(m.hoje, dias); m.minuto = 0; } },
  };
  return par;
}
/** Base comum: clientes com histórico antigo, um deles com reserva de reativação para a outra vendedora. */
async function semear(par) {
  await par.ambos(async m => {
    await m.carteira(300, VD1, { cicloAncoraEm: '2026-05-01' }); await m.venda(1, 300, dia(D0, -150), '111'); await m.reservar(300, VD2, VD1, dia(D0, -2), dia(D0, -150));
    await m.carteira(301, VD1); await m.venda(2, 301, dia(D0, -60), '111');
    await m.carteira(302, VD2); await m.venda(3, 302, dia(D0, -150), '222'); await m.reservar(302, VD1, VD2, dia(D0, -2), dia(D0, -150));
    for (let i = 0; i < 40; i++) await m.venda(1000 + i, 500 + (i % 8), dia('2025-01-01', i), '999', { modificado_em: '2025-03-01 10:00:00' });   // massa antiga
    m.cursor = agoraNoFusoGc(m.agora()); await m.sync();
  });
}
const prontos = async () => { const par = await criarPar(); await semear(par); const r = await par.rodar(); expect(r.b).toMatchObject({ status: 'OK', execucao: 'COMPLETA', motivo: 'SEM_ESTADO', estadoSalvo: true }); return par; };
const incremental = r => expect(r.b).toMatchObject({ status: 'OK', execucao: 'INCREMENTAL', motivo: null, estadoSalvo: true });
const dados = async (m, caminho) => (await m.db.doc(caminho).get()).data();
const todos = async (m, c) => (await m.db.collection(c).get()).docs.map(d => d.data());

describe('equivalência: incremental × varredura completa', () => {
  test('primeira execução é completa; sem novidade a seguinte é incremental, sem candidatas relevantes e com muito menos leituras de vendas', async () => {
    const par = await criarPar(); await semear(par);
    await par.ambos(async m => { m.hoje = dia(D0, 5); m.cursor = agoraNoFusoGc(m.agora()); await m.sync(); });   // base fora da janela de 72 h
    const p = await par.rodar(); expect(p.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'SEM_ESTADO', estadoSalvo: true }); expect(p.b.leiturasPorColecao.vendas_gc).toBeGreaterThanOrEqual(43);
    const s = await par.rodar(); incremental(s); expect(s.b.candidatas).toBe(0); expect(s.b.clientesAfetados).toBe(0); expect(s.b.leiturasPorColecao.vendas_gc).toBeLessThanOrEqual(3); expect(s.b.leiturasPorColecao.users).toBeUndefined();
  });
  test('venda nova (transfere pela reserva), venda do dono (renova) e venda da gestão (neutra)', async () => {
    const par = await prontos();
    await par.ambos(async m => { await m.venda(10, 300, m.hoje, '222'); await m.venda(11, 301, m.hoje, '111'); await m.venda(12, 301, m.hoje, '999'); });
    const r = await par.rodar(); incremental(r); expect(r.b.aplicadas).toBe(2); expect(r.b.clientesAfetados).toBe(2); expect((await dados(par.inc, 'carteira_comercial/GC:300')).ownerUid).toBe(VD2);
    const r2 = await par.rodar(); incremental(r2); expect(r2.b.novas).toBe(0); expect(r2.b.clientesAfetados).toBe(0);
  });
  test('venda alterada: vendedor/data/valor mudam ⇒ nova revisão; regravação sem mudança não gera trabalho', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 301, dia(m.hoje, -1), '111')); await par.rodar();
    await par.ambos(m => m.alterar(10, { vendedor_id: '222' })); let r = await par.rodar(); incremental(r); expect(r.b.novasRevisoes).toBe(1);
    await par.ambos(m => m.alterar(10, {})); r = await par.rodar(); incremental(r); expect(r.b.novasRevisoes).toBe(0); expect(r.b.clientesAfetados).toBe(0);
    await par.ambos(m => m.alterar(10, { valor_total: '0' })); r = await par.rodar(); incremental(r); expect(r.b.novasRevisoes).toBe(1);
    await par.ambos(m => m.venda(11, 301, m.hoje, '999')); await par.rodar();
    await par.ambos(m => m.alterar(11, { cliente_id: '302' })); r = await par.rodar(); incremental(r); expect(r.b.novasRevisoes).toBe(1); expect(r.b.clientesAfetados).toBe(1);
  });
  test('cancelamento: reverte a transferência; a execução seguinte registra a mesma revisão que a completa; renovação cancelada vira revisão', async () => {
    const par = await prontos();
    await par.ambos(async m => { await m.venda(10, 300, m.hoje, '222'); await m.venda(11, 301, m.hoje, '111'); }); await par.rodar();
    await par.ambos(async m => { await m.alterar(10, { nome_situacao: 'Cancelada' }); await m.alterar(11, { nome_situacao: 'Cancelada' }); });
    let r = await par.rodar(); incremental(r); expect(r.b.reversoes).toMatchObject({ executadas: 1, renovacoesInvalidadas: 1 }); expect((await dados(par.inc, 'carteira_comercial/GC:300')).ownerUid).toBe(VD1);
    r = await par.rodar(); incremental(r); r = await par.rodar(); incremental(r); expect((await todos(par.inc, 'carteira_comercial_revisoes')).length).toBe(2);
  });
  test('inválida antiga continua sendo reavaliada fora da janela de 72 h (a lista vem do estado)', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 300, m.hoje, '222')); await par.rodar();
    await par.ambos(async m => { await m.venda(13, 300, m.hoje, '222'); }); await par.rodar();
    await par.ambos(m => m.alterar(10, { nome_situacao: 'Cancelada' })); let r = await par.rodar(); expect(r.b.reversoes.ambiguas).toBe(1);
    expect((await dados(par.inc, 'reativacao_estado/vendas')).invalidas).toEqual(['10']);
    for (let i = 0; i < 5; i++) { par.avancar(1); await par.ambos(async m => { await m.venda(900 + i, 600, m.hoje, '999'); }); r = await par.rodar(); r = await par.rodar(); incremental(r); }
    expect(r.b.reversoes.ambiguas).toBe(1);
  });
  test('reversão AMBÍGUA que depois fica possível: reavaliada fora da janela, sem a venda mudar, e executada como na completa', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 300, m.hoje, '222')); await par.rodar();
    await par.ambos(async m => { await m.db.doc('sistema_usuarios/' + VD1).update({ bloqueado: true }); await m.alterar(10, { nome_situacao: 'Cancelada' }); });
    let r = await par.rodar(); incremental(r); expect(r.b.reversoes).toMatchObject({ ambiguas: 1, executadas: 0 });
    par.avancar(5); await par.ambos(m => m.venda(900, 600, m.hoje, '999')); await par.rodar();                      // o cursor avança: a venda 10 sai da janela
    r = await par.rodar(); incremental(r); expect(r.b.candidatas).toBe(1); expect(r.b.reversoes.ambiguas).toBe(1);
    await par.ambos(m => m.db.doc('sistema_usuarios/' + VD1).update({ bloqueado: false })); r = await par.rodar(); incremental(r); expect(r.b.reversoes.executadas).toBe(1);
    expect((await dados(par.inc, 'carteira_comercial/GC:300')).ownerUid).toBe(VD1);
  });
  test('venda antiga modificada: pós-corte antiga volta pela marca d’água; pré-corte não gera nada', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 301, dia(m.hoje, -3), '111')); await par.rodar();
    par.avancar(10); await par.ambos(m => m.venda(11, 600, m.hoje, '999')); let r = await par.rodar(); expect(r.b.motivo).toBe('RECONCILIACAO_DIARIA');
    await par.ambos(async m => { await m.alterar(10, { vendedor_id: '222' }); await m.alterar(1, { valor_total: '777' }); });
    r = await par.rodar(); incremental(r); expect(r.b.novasRevisoes).toBe(1); expect(r.b.clientesAfetados).toBe(1);
  });
  test('reconciliação do sync grava venda com modificado_em ANTIGO ⇒ marcador muda ⇒ completa', async () => {
    const par = await prontos();
    await par.ambos(async m => { await m.db.doc('vendas_gc/20').set({ id: '20', cliente_id: '300', data: m.hoje, vendedor_id: '222', nome_situacao: 'Concretizada', valor_total: '10', modificado_em: '2026-01-01 00:00:00', cadastrado_em: m.hoje + ' 08:00:00' }); m.recon = m.hoje + 'T03:30:00.000Z'; await m.sync(); });
    const r = await par.rodar(); expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'SYNC_RECONCILIOU' }); expect(r.b.aplicadas).toBe(1);
  });
  test('venda excluída ⇒ total diminui ⇒ completa e reversão', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 300, m.hoje, '222')); await par.rodar();
    await par.ambos(m => m.excluir(10)); const r = await par.rodar(); expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'VENDAS_REMOVIDAS' }); expect(r.b.reversoes.executadas).toBe(1);
  });
  test('LIMITE CONHECIDO: exclusão compensada por inclusão no mesmo intervalo só é vista na reconciliação diária (e converge)', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 300, m.hoje, '222')); await par.rodar();
    await par.ambos(async m => { await m.excluir(10); await m.venda(30, 600, m.hoje, '999'); });
    const r = await par.rodar({ comparar: false }); incremental(r); expect((await dados(par.inc, 'carteira_comercial/GC:300')).ownerUid).toBe(VD2); expect((await dados(par.ref, 'carteira_comercial/GC:300')).ownerUid).toBe(VD1);
    par.avancar(1); const c = await par.rodar({ comparar: false }); expect(c.b.motivo).toBe('RECONCILIACAO_DIARIA'); expect((await dados(par.inc, 'carteira_comercial/GC:300')).ownerUid).toBe(VD1);
  });
  test('fora de ordem: venda com data anterior a uma já decidida vai para a gestão', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(12, 301, m.hoje, '111')); await par.rodar();
    await par.ambos(m => m.venda(11, 301, dia(m.hoje, -4), '222')); const r = await par.rodar(); incremental(r); expect(r.b.foraDeOrdem).toEqual(['11']); expect(r.b.decisoes.FORA_DE_ORDEM).toBe(1);
  });
  test('venda pré-datada: vira válida quando a data chega, sem ser regravada', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 301, dia(m.hoje, 6), '111')); await par.rodar();
    for (let i = 0; i < 7; i++) { par.avancar(1); await par.rodar(); const r = await par.rodar(); incremental(r); }
    expect((await todos(par.inc, 'carteira_reativacao_decisoes')).map(d => d.decisao).sort()).toEqual(['IGNORAR_INVALIDA', 'RENOVAR_OWNER']);
  });
  test('virada do dia UTC antes da completa: pré-datada sem modificação há mais de 72 h é pega pela consulta por data, em execução incremental', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 301, dia(m.hoje, 5), '111')); await par.rodar();
    par.avancar(4); await par.ambos(m => m.venda(11, 600, m.hoje, '999')); expect((await par.rodar()).b.motivo).toBe('RECONCILIACAO_DIARIA');
    await par.ambos(async m => { m.hoje = dia(m.hoje, 1); m.minuto = -11 * 60; });                         // 01:xx UTC = 22:xx de Fortaleza do dia anterior
    const r = await par.rodar(); incremental(r); expect(r.b.novasRevisoes).toBe(1); expect(r.b.aplicadas).toBe(1);
  });
  test('devolução TOTAL criada e depois removida (venda não é modificada)', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 300, m.hoje, '222')); await par.rodar();
    par.avancar(5); await par.rodar();
    await par.ambos(m => m.devolucao('d1', 10, 'PARCIAL')); let r = await par.rodar(); incremental(r); expect(r.b.reversoes.candidatas).toBe(0);
    await par.ambos(m => m.devolucao('d1', 10, 'TOTAL')); r = await par.rodar(); incremental(r); expect(r.b.novasRevisoes).toBe(1); expect(r.b.reversoes.executadas).toBe(1);
    r = await par.rodar(); incremental(r);
    await par.ambos(m => m.db.doc('carteira_comercial_devolucoes/d1').delete()); r = await par.rodar(); incremental(r); expect(r.b.novasRevisoes).toBe(1);
  });
  test('conflito de identidade (carteira irmã e registro persistente) bloqueia igual nos dois modos', async () => {
    const par = await prontos();
    await par.ambos(async m => { await m.carteira(400, VD1, { conflito: { revisao: 'PENDENTE', relacionados: ['GC:301'] } }); await m.db.doc('identidade_conflitos/c1').set({ status: 'PENDENTE', membros: ['GC:302'] });
      await m.venda(10, 301, m.hoje, '111'); await m.venda(11, 302, m.hoje, '222'); });
    const r = await par.rodar(); incremental(r); expect(r.b.decisoes).toEqual({ BLOQUEADO_CONFLITO: 2 });
  });
});

describe('falha no meio, estado corrompido e configuração (fail-closed)', () => {
  const comFalha = async fn => { const orig = OPS.aplicarDecisaoVenda; let n = 0; OPS.aplicarDecisaoVenda = async (...a) => { if (++n === 2) throw new Error('FALHA_INJETADA'); return orig(...a); }; try { return await fn(); } finally { OPS.aplicarDecisaoVenda = orig; } };
  test('erro ao aplicar a 2ª venda: disjuntor, estado não avança; religado, a completa converge', async () => {
    const par = await prontos();
    await par.ambos(async m => { await m.venda(10, 300, m.hoje, '222'); await m.venda(11, 301, m.hoje, '111'); });
    const antes = await dados(par.inc, 'reativacao_estado/vendas');
    par.ref.minuto = par.inc.minuto += 7; const agoraIso = par.inc.agora();
    const a = await comFalha(() => PV.processarVendas(par.ref.db, par.ref.FV, { agoraIso, runId: 'f' }));
    const b = await comFalha(() => INC.executarReativacaoVendas(par.inc.db, par.inc.FV, { agoraIso, runId: 'f' }));
    expect([a.status, b.status]).toEqual(['DISJUNTOR_ERRO', 'DISJUNTOR_ERRO']); expect(await retrato(par.inc)).toEqual(await retrato(par.ref));
    const depois = await dados(par.inc, 'reativacao_estado/vendas'); expect(depois.pendente).toBe(true); expect(depois.marca).toBe(antes.marca);
    expect((await par.rodar()).b.status).toBe('DESLIGADO');
    await par.ambos(m => m.cfg()); const r = await par.rodar(); expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'EXECUCAO_ANTERIOR_INCOMPLETA', estadoSalvo: true }); expect(r.b.aplicadas).toBe(1);
  });
  test('queda depois de escritas (consulta de eventos falha): próxima execução é completa e converge; trava é liberada', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 300, m.hoje, '222'));
    const orig = par.inc.db.collection.bind(par.inc.db);
    par.inc.db.collection = n => { const c = orig(n); if (n === 'carteira_comercial_historico') { const w = c.where.bind(c); c.where = (f, ...x) => { if (f === 'chaveIdempotencia') throw new Error('QUEDA_INJETADA'); return w(f, ...x); }; } return c; };
    par.inc.minuto += 7;
    await expect(INC.executarReativacaoVendas(par.inc.db, par.inc.FV, { agoraIso: par.inc.agora(), runId: 'q' })).rejects.toThrow('QUEDA_INJETADA');
    par.inc.db.collection = orig;
    expect((await dados(par.inc, 'reativacao_estado/vendas')).pendente).toBe(true); expect((await dados(par.inc, 'reativacao_estado/lease')).expiraEm).toBe(0);
    await PV.processarVendas(par.ref.db, par.ref.FV, { agoraIso: par.inc.agora(), runId: 'q' });
    const r = await par.rodar(); expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'EXECUCAO_ANTERIOR_INCOMPLETA' });
  });
  test('falha de leitura na carga incremental ⇒ completa na MESMA execução', async () => {
    const par = await prontos();
    await par.ambos(m => m.venda(10, 300, m.hoje, '222'));
    const orig = par.inc.db.collection.bind(par.inc.db);
    par.inc.db.collection = n => { const c = orig(n); if (n === 'vendas_gc') { const w = c.where.bind(c); c.where = (f, ...x) => { if (f === 'modificado_em') throw new Error('INDICE_AUSENTE'); return w(f, ...x); }; } return c; };
    const r = await par.rodar(); par.inc.db.collection = orig;
    expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'ERRO_NA_LEITURA_INCREMENTAL', estadoSalvo: true, aplicadas: 1 });
  });
  test('volume acima do limite ⇒ completa', async () => {
    const par = await prontos(); await par.ambos(m => m.venda(10, 300, m.hoje, '222'));
    const r = await par.rodar({ opcoes: { limites: { candidatas: 0, clientes: 0 } } }); expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'VOLUME_ALTO' });
  });
  const mexer = async (m, ex, reassinar) => { const e = { ...(await dados(m, 'reativacao_estado/vendas')), ...ex }; if (reassinar) e.integridade = INC.integridadeDe(e); await m.db.doc('reativacao_estado/vendas').set(e); };
  test.each([
    ['marca d’água adulterada', { marca: '2030-01-01 00:00:00' }, false, 'ESTADO_INVALIDO'], ['lixo no lugar da marca', { marca: 'x' }, true, 'ESTADO_INVALIDO'], ['versão desconhecida', { versao: 99 }, true, 'ESTADO_INVALIDO'],
    ['marca além do cursor do sync (reassinada)', { marca: '2030-01-01 00:00:00' }, true, 'CURSOR_INCONSISTENTE'], ['dia no futuro', { hoje: '2030-01-01' }, true, 'CURSOR_INCONSISTENTE'],
    ['assinatura de outra regra', { assinatura: 'outra' }, true, 'CONFIGURACAO_OU_REGRA_ALTERADA'], ['total de decisões maior que o real', { totalDecisoes: 999 }, true, 'DECISOES_REMOVIDAS'],
    ['completa antiga demais', { completaEm: '2026-10-01T00:00:00.000Z' }, true, 'RECONCILIACAO_VENCIDA'],
  ])('cursor corrompido (%s) ⇒ completa e se recupera', async (_, ex, reassinar, motivo) => {
    const par = await prontos(); await par.ambos(m => m.venda(10, 300, m.hoje, '222')); await mexer(par.inc, ex, reassinar);
    const r = await par.rodar(); expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo, estadoSalvo: true }); incremental(await par.rodar());
  });
  test('sync não READY ⇒ completa sem salvar estado; corte alterado ⇒ completa; incremental=false ⇒ sempre completa', async () => {
    const par = await prontos();
    await par.ambos(m => m.sync({ status: 'ERROR' })); let r = await par.rodar(); expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'SYNC_NAO_CONFIAVEL', estadoSalvo: false });
    await par.ambos(m => m.sync()); r = await par.rodar(); expect(r.b.motivo).toBe('EXECUCAO_ANTERIOR_INCOMPLETA');
    await par.ambos(m => m.cfg({ corte: '2026-04-01' })); r = await par.rodar(); expect(r.b.motivo).toBe('CONFIGURACAO_OU_REGRA_ALTERADA');
    await par.ambos(m => m.cfg({ corte: '2026-04-01', incremental: false })); for (let i = 0; i < 2; i++) { r = await par.rodar(); expect(r.b).toMatchObject({ execucao: 'COMPLETA', motivo: 'INCREMENTAL_DESATIVADO' }); }
  });
  test('uma completa por dia a partir das 05:00 de Fortaleza', async () => {
    expect(INC.diaReferencia('2026-10-08T07:59:00.000Z')).toBe('2026-10-07'); expect(INC.diaReferencia('2026-10-08T08:00:00.000Z')).toBe('2026-10-08');
    const par = await prontos(); incremental(await par.rodar()); par.avancar(1); expect((await par.rodar()).b.motivo).toBe('RECONCILIACAO_DIARIA'); incremental(await par.rodar());
  });
  test('DESLIGADO e DRY não escrevem trava nem estado', async () => {
    const m = await criarMundo('inc');
    for (const modo of ['DESLIGADO', 'DRY']) { await m.cfg({ modo }); await INC.executarReativacaoVendas(m.db, m.FV, { agoraIso: m.agora() }); }
    expect((await m.db.collection('reativacao_estado').get()).size).toBe(0);
  });
  test('motor não B3 ⇒ nada é lido de vendas e nada é aplicado', async () => {
    const par = await prontos(); await par.ambos(m => m.db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'R2' }));
    const r = await par.rodar(); expect(r.b).toMatchObject({ status: 'MOTOR_NAO_B3', execucao: 'NENHUMA' }); expect(r.b.leiturasPorColecao.vendas_gc).toBeLessThanOrEqual(1);
  });
});

describe('INF-12 — trava', () => {
  test('trava ativa de outra execução ⇒ OUTRA_EXECUCAO sem ler vendas nem escrever; vencida é assumida', async () => {
    const par = await prontos(); await par.ambos(m => m.venda(10, 300, m.hoje, '222'));
    await par.inc.db.doc(INC.REF_LEASE).set({ detentor: 'outra', adquiridaEm: Date.now(), expiraEm: Date.now() + 60000 });
    const antes = await retrato(par.inc); const estado = await dados(par.inc, INC.REF_ESTADO);
    const r = await INC.executarReativacaoVendas(par.inc.db, par.inc.FV, { agoraIso: par.inc.agora() }); expect(r).toMatchObject({ status: 'OUTRA_EXECUCAO', execucao: 'NENHUMA' }); expect(r.leiturasPorColecao.vendas_gc).toBeUndefined();
    expect(await retrato(par.inc)).toEqual(antes); expect(await dados(par.inc, INC.REF_ESTADO)).toEqual(estado);
    await par.inc.db.doc(INC.REF_LEASE).set({ detentor: 'outra', adquiridaEm: 0, expiraEm: Date.now() - 1 });
    expect((await par.rodar()).b.aplicadas).toBe(1);
  });
  test('duas execuções simultâneas ⇒ só uma processa', async () => {
    const par = await prontos(); await par.ambos(m => m.venda(10, 300, m.hoje, '222')); par.inc.minuto += 7;
    const rs = await Promise.all([1, 2].map(() => INC.executarReativacaoVendas(par.inc.db, par.inc.FV, { agoraIso: par.inc.agora(), runId: 'c' })));
    expect(rs.map(r => r.status).sort()).toEqual(['OK', 'OUTRA_EXECUCAO']); expect((await todos(par.inc, 'carteira_comercial_historico')).length).toBe(1);
  });
  test('quem perdeu a trava não grava estado', async () => {
    const par = await prontos(); const antes = await dados(par.inc, INC.REF_ESTADO);
    const orig = PV.processarVendas; PV.processarVendas = async (...a) => { const r = await orig(...a); await par.inc.db.doc(INC.REF_LEASE).set({ detentor: 'outra', expiraEm: Date.now() + 60000 }); return r; };
    try { par.inc.minuto += 7; const r = await INC.executarReativacaoVendas(par.inc.db, par.inc.FV, { agoraIso: par.inc.agora() }); expect(r.estadoSalvo).toBe(false); } finally { PV.processarVendas = orig; }
    expect((await dados(par.inc, INC.REF_ESTADO)).atualizadoEm).toBe(antes.atualizadoEm); expect((await dados(par.inc, INC.REF_LEASE)).detentor).toBe('outra');
  });
  test('log só com enums e contagens (sem ids de venda/cliente)', async () => {
    const par = await prontos(); await par.ambos(m => m.venda(987654, 765432, m.hoje, '111')); const { b } = await par.rodar();
    const linha = JSON.stringify(INC.resumoLog(b)); expect(linha).not.toMatch(/987654|765432|GC:|nome/i); expect(INC.resumoLog(b).leituras).toBe(Object.values(b.leiturasPorColecao).reduce((x, y) => x + y, 0));
  });
});

describe('equivalência aleatória (sequências com semente)', () => {
  const sorteio = semente => { let s = semente; return n => { s = (s * 48271) % 2147483647; return s % n; }; };
  const sementes = EMU ? [1, 2] : Array.from({ length: 60 }, (_, i) => i + 1);
  const contagem = { passos: 0, incrementais: 0, aplicadas: 0, reversoes: 0, revisoes: 0, foraDeOrdem: 0, lancou: 0 };
  test.each(sementes)('semente %i', async semente => {
    const par = await prontos(); const rnd = sorteio(semente * 7919); let prox = 100; const vivas = [];
    const clientes = [300, 301, 302, 303, 304], vendedores = ['111', '222', '999', '111', '222'];
    for (let passo = 0; passo < (EMU ? 15 : 30); passo++) {
      if (rnd(5) === 0) par.avancar(1 + rnd(3));
      let excluiu = false;
      for (let k = 0, n = 1 + rnd(3); k < n && !excluiu; k++) {
        const acao = vivas.length ? rnd(11) : 0; const id = vivas.length ? vivas[rnd(vivas.length)] : null;
        const cli = clientes[rnd(clientes.length)], vend = vendedores[rnd(vendedores.length)], delta = rnd(14) - 9;
        if (acao <= 2) { const novo = prox++; vivas.push(novo); await par.ambos(m => m.venda(novo, cli, dia(m.hoje, delta), vend)); }
        else if (acao === 3) await par.ambos(m => m.alterar(id, { nome_situacao: 'Cancelada' }));
        else if (acao === 4) { const valor = String(rnd(3) * 50); await par.ambos(m => m.alterar(id, { nome_situacao: 'Concretizada', valor_total: valor })); }   // sorteio FORA da mutação: igual nos dois
        else if (acao === 5) await par.ambos(m => m.alterar(id, { vendedor_id: vend }));
        else if (acao === 6) await par.ambos(m => m.alterar(id, { data: dia(m.hoje, delta) }));
        else if (acao === 7) await par.ambos(m => m.alterar(id, { cliente_id: String(cli) }));
        else if (acao === 8) { const tipo = rnd(2) ? 'TOTAL' : 'PARCIAL', d = 'd' + rnd(4); await par.ambos(m => m.devolucao(d, id, tipo)); }
        else if (acao === 9 && k === 0) { excluiu = true; vivas.splice(vivas.indexOf(id), 1); await par.ambos(m => m.excluir(id)); }   // exclusão sozinha (ver LIMITE CONHECIDO)
        else if (acao === 10) await par.ambos(async m => { const g = clientes[delta & 3]; if ((await dados(m, 'carteira_comercial/GC:' + g))) { try { await m.reservar(g, VD2, VD1, m.hoje, dia(D0, -150)); } catch (_) { /* recusa idêntica nos dois */ } } });
      }
      const { a, b } = await par.rodar();
      contagem.passos++; contagem.incrementais += b.execucao === 'INCREMENTAL' ? 1 : 0; contagem.aplicadas += a.aplicadas || 0; contagem.reversoes += (a.reversoes && a.reversoes.executadas) || 0;
      contagem.foraDeOrdem += (a.foraDeOrdem || []).length; contagem.revisoes += a.novasRevisoes || 0;
      if (a.status === 'LANCOU') { contagem.lancou++; break; }                                                  // a própria regra aborta (igual nos dois) a cada execução
      if (a.status !== 'OK') await par.ambos(m => m.cfg());                                                    // disjuntor: religa os dois
    }
  });
  afterAll(() => {                                                                                                             // o sorteio precisa exercitar de verdade
    process.stdout.write('equivalencia-aleatoria ' + JSON.stringify(contagem) + '\n');
    if (contagem.passos > 500) { expect(contagem.incrementais).toBeGreaterThan(contagem.passos / 2); for (const k of ['aplicadas', 'reversoes', 'revisoes', 'foraDeOrdem']) expect(contagem[k]).toBeGreaterThan(0); }
  });
});
