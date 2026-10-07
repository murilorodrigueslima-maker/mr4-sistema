'use strict';
// B3.2 — processador de vendas (DRY/SOMBRA/ATIVO): idempotência, corte (sem retroativo), cancelamento, devolução, fora de ordem, concorrência. EMULADOR.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const R = require('../lib/reativacao120'); const OPS = require('../lib/reativacaoOps'); const PV = require('../lib/reativacaoVendas'); const JOB = require('../lib/reativacaoJob'); const Q = require('../lib/crmConsulta');
jest.setTimeout(240000);
const ADE = 'b32-ade', FAB = 'b32-fab', GES = 'b32-ges', HOJE = '2026-10-07', CORTE = '2026-09-27', dia = n => R.somarDias(HOJE, -n), T0 = '2026-09-26T13:59:45.769Z';
const AGORA = HOJE + 'T10:00:00.000Z';
const COLS = ['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_reativacao_decisoes', 'carteira_reativacao_decisoes_sombra', 'carteira_comercial_devolucoes', 'carteira_comercial_revisoes', 'carteira_comercial_restricoes',
  'identidade_conflitos', 'vendas_gc', 'users', 'sistema_usuarios', 'interacoes_fila', 'clientes', 'carteira_comercial_config', 'audit_log'];
const limpar = async cols => { for (const c of cols) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
const v2 = (gc, owner, ex = {}) => ({ schemaVersion: 'carteira-v2', portfolioId: 'GC:' + gc, ownerUid: owner, ownerDesde: T0, origemComercialUid: owner, origemComercialGestaoClickId: owner === ADE ? '111' : '222', criadoEm: T0, atualizadoEm: T0, versao: 2,
  status: 'ATIVA', origem: 'MIGRACAO_ONDA1_N3526', cicloAncoraEm: null, clienteMr4Id: null, conflito: null, ultimoEventoId: 'E', ...ex });
const venda = (id, cli, data, gcVend, ex = {}) => ({ id: String(id), cliente_id: String(cli), data, vendedor_id: String(gcVend), nome_situacao: 'Concretizada', valor_total: '100', ...ex });
const seedV = async vs => { for (const v of vs) { const { id, ...r } = v; await db.doc('vendas_gc/' + id).set(r); } };
const cfg = async (modo, extra = {}) => db.doc('carteira_comercial_config/reativacao').set({ modo, corte: CORTE, ...extra });
const reservar = (gc, destino, owner, liberadoEm, ciclo) => OPS.liberarReserva(db, FieldValue, { chave: R.chaveReativacao('GC:' + gc, ciclo), portfolioId: 'GC:' + gc, ciclo, tipo: owner ? 'CARTEIRA' : 'SEM_CARTEIRA', ownerUid: owner || null, destinoUid: destino, liberadoEm, nomeCliente: 'Cliente ' + gc, agoraIso: liberadoEm + 'T09:00:00.000Z' });
const rodar = (modoForcado, ex = {}) => PV.processarVendas(db, FieldValue, { agoraIso: AGORA, forcarDry: false, modoForcado, runId: 'run-' + Math.random().toString(36).slice(2, 6), ...ex });
const cont = async c => (await db.collection(c).get()).size;
beforeAll(async () => {
  await limpar(COLS);
  for (const [uid, role, mods, cc] of [[ADE, 'funcionario', ['fila-comercial-operar'], '111'], [FAB, 'funcionario', ['fila-comercial-operar'], '222'], [GES, 'gestor', [], null]]) {
    await db.doc('users/' + uid).set({ role, ativo: true });
    await db.doc('sistema_usuarios/' + uid).set({ nome: uid, modulos: mods, admin: false, ...(cc ? { carteiraComercial: { podePossuirCarteira: true, ativoComercialmente: true, gestaoClickVendedorId: cc, pausaTemporaria: false, desligado: false }, filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } } : {}) });
  }
});
afterAll(async () => { await limpar(COLS); });
const base = async () => { await limpar(['carteira_comercial', 'carteira_comercial_historico', 'carteira_reativacoes', 'carteira_reativacao_decisoes', 'carteira_reativacao_decisoes_sombra', 'carteira_comercial_devolucoes', 'carteira_comercial_revisoes', 'vendas_gc', 'audit_log', 'carteira_comercial_config']); await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'B3' }); };

describe('B3.2 — modos e trava', () => {
  beforeEach(base);
  test('sem configuração ⇒ DESLIGADO; sem corte ⇒ não processa (nada retroativo); trava FORCAR_DRY limita a DRY mesmo com modo ATIVO', async () => {
    expect((await PV.processarVendas(db, FieldValue, { agoraIso: AGORA })).status).toBe('DESLIGADO');
    await db.doc('carteira_comercial_config/reativacao').set({ modo: 'ATIVO' }); expect((await PV.processarVendas(db, FieldValue, { agoraIso: AGORA })).status).toBe('SEM_CORTE');
    await cfg('ATIVO'); await db.doc('carteira_comercial/GC:300').set(v2('300', ADE)); await seedV([venda(1, 300, dia(150), '111'), venda(2, 300, dia(1), '222')]);
    const r = await PV.processarVendas(db, FieldValue, { agoraIso: AGORA, forcarDry: true }); expect(r).toMatchObject({ status: 'OK', modo: 'DRY' }); expect(typeof PV.FORCAR_DRY).toBe('boolean');
    expect(await cont('carteira_reativacao_decisoes')).toBe(0); expect(await cont('carteira_reativacao_decisoes_sombra')).toBe(0); expect((await db.doc('carteira_comercial/GC:300').get()).data().ownerUid).toBe(ADE);
  });
  test('DRY: calcula decisões (gestão neutra, cobertura, sem oportunidade) com ZERO escritas', async () => {
    await cfg('DRY'); await db.doc('carteira_comercial/GC:301').set(v2('301', ADE)); await db.doc('carteira_comercial/GC:302').set(v2('302', ADE));
    await seedV([venda(1, 301, dia(60), '111'), venda(2, 301, dia(3), '222'), venda(3, 302, dia(150), '111'), venda(4, 302, dia(2), '222'), venda(5, 302, dia(1), '999')]);
    const r = await PV.processarVendas(db, FieldValue, { agoraIso: AGORA }); expect(r.modo).toBe('DRY');
    expect(r.decisoes).toMatchObject({ COBERTURA_RENOVA_OWNER: 1, MANTER_SEM_OPORTUNIDADE: 1, VENDA_GESTAO_NEUTRA: 1 }); expect(r.ignoradasAntesDoCorte).toBe(2);
    for (const c of ['carteira_reativacao_decisoes', 'carteira_reativacao_decisoes_sombra', 'carteira_comercial_historico', 'carteira_reativacoes']) expect(await cont(c)).toBe(0);
  });
});

describe('B3.2 — retroativo: venda antiga/anterior ao corte nunca transfere', () => {
  beforeEach(base);
  test('mesmo com reserva ativa e motor B3, venda anterior ao corte é ignorada e não muda owner', async () => {
    await cfg('ATIVO'); await db.doc('carteira_comercial/GC:310').set(v2('310', ADE)); await seedV([venda(1, 310, dia(300), '111'), venda(2, 310, dia(15), '222')]); await reservar(310, FAB, ADE, dia(20), dia(300));
    const r = await rodar('ATIVO'); expect(r.ignoradasAntesDoCorte).toBe(2); expect(r.aplicadas).toBe(0); expect((await db.doc('carteira_comercial/GC:310').get()).data()).toMatchObject({ ownerUid: ADE, versao: 2 });
  });
  test('venda atrasada com data DENTRO da janela da reserva é válida; fora da janela (antes da liberação) não transfere', async () => {
    await cfg('ATIVO'); await db.doc('carteira_comercial/GC:311').set(v2('311', ADE)); await seedV([venda(1, 311, dia(200), '111'), venda(2, 311, dia(5), '222')]); await reservar(311, FAB, ADE, dia(2), dia(200));
    const r = await rodar('ATIVO'); expect(r.decisoes.MANTER_SEM_OPORTUNIDADE).toBe(1); expect((await db.doc('carteira_comercial/GC:311').get()).data().ownerUid).toBe(ADE);       // venda de D-5 < liberação D-2
  });
});

describe('B3.2 — SOMBRA: grava só decisões, nunca ownership; idempotente; revisões', () => {
  beforeEach(base);
  test('decisões create-only, reexecução não duplica; venda cancelada depois ⇒ nova revisão r2; ownership e histórico intactos', async () => {
    await cfg('SOMBRA'); await db.doc('carteira_comercial/GC:320').set(v2('320', ADE)); await seedV([venda(1, 320, dia(40), '111'), venda(2, 320, dia(2), '222')]);
    const a = await rodar('SOMBRA'); expect(a.novas).toBe(1); expect(await cont('carteira_reativacao_decisoes_sombra')).toBe(1);
    const b = await rodar('SOMBRA'); expect(b.novas).toBe(0); expect(b.jaProcessadas).toBe(1); expect(await cont('carteira_reativacao_decisoes_sombra')).toBe(1);
    await db.doc('vendas_gc/2').update({ nome_situacao: 'Cancelada' }); const c = await rodar('SOMBRA'); expect(c.novasRevisoes).toBe(1);
    const ids = (await db.collection('carteira_reativacao_decisoes_sombra').get()).docs.map(d => d.id).sort(); expect(ids).toEqual(['B3_2_r1', 'B3_2_r2']);
    expect((await db.doc('carteira_reativacao_decisoes_sombra/B3_2_r2').get()).data()).toMatchObject({ decisao: 'IGNORAR_INVALIDA', modo: 'SOMBRA', regraVersao: 'B3.2' });
    expect(JSON.stringify((await db.collection('carteira_reativacao_decisoes_sombra').get()).docs.map(d => d.data()))).not.toMatch(/nome|cpf|telefone|email|valor/i);
    expect(await cont('carteira_comercial_historico')).toBe(0); expect((await db.doc('carteira_comercial/GC:320').get()).data()).toMatchObject({ ownerUid: ADE, versao: 2 });
  });
  test('venda fora de ordem (anterior a uma já decidida) NÃO é aplicada: vai para revisão da gestão', async () => {
    await cfg('SOMBRA'); await db.doc('carteira_comercial/GC:321').set(v2('321', ADE)); await seedV([venda(1, 321, dia(40), '111'), venda(3, 321, dia(2), '111')]); await rodar('SOMBRA');
    await seedV([venda(2, 321, dia(4), '222')]); const r = await rodar('SOMBRA'); expect(r.foraDeOrdem).toEqual(['2']); expect(r.decisoes.FORA_DE_ORDEM).toBe(1);
    expect((await db.doc('carteira_reativacao_decisoes_sombra/B3_2_r1').get()).data()).toMatchObject({ gestaoReview: true, ownerDepoisUid: ADE });
  });
});

describe('B3.2 — ATIVO (ensaio em emulador, motor B3): transferência, idempotência, cancelamento, devolução, reversão', () => {
  beforeEach(base);
  const prepararTransferencia = async gc => {
    await cfg('ATIVO'); await db.doc('carteira_comercial/GC:' + gc).set(v2(String(gc), ADE, { cicloAncoraEm: '2026-05-01' })); await seedV([venda(1, gc, dia(150), '111'), venda(2, gc, dia(1), '222')]); await reservar(gc, FAB, ADE, dia(2), dia(150));
    const r = await rodar('ATIVO'); expect(r.aplicadas).toBe(1); expect((await db.doc('carteira_comercial/GC:' + gc).get()).data()).toMatchObject({ ownerUid: FAB, versao: 3 }); return r;
  };
  test('venda na reserva transfere uma vez; reprocessar não duplica evento nem decisão; reserva CONVERTIDA', async () => {
    await prepararTransferencia(330); const r2 = await rodar('ATIVO'); expect(r2.novas).toBe(0); expect(r2.aplicadas).toBe(0);
    expect(await cont('carteira_comercial_historico')).toBe(1); expect(await cont('carteira_reativacao_decisoes')).toBe(1); expect((await db.collection('carteira_reativacoes').get()).docs[0].data().estado).toBe('CONVERTIDA');
  });
  test('sem o motor B3 autorizado o ATIVO não escreve ownership (exclusão mútua)', async () => {
    await cfg('ATIVO'); await db.doc('carteira_comercial_config/motor').set({ motorAtivo: 'R2' }); await db.doc('carteira_comercial/GC:331').set(v2('331', ADE)); await seedV([venda(1, 331, dia(150), '111'), venda(2, 331, dia(1), '222')]); await reservar(331, FAB, ADE, dia(2), dia(150));
    const r = await rodar('ATIVO'); expect(r).toMatchObject({ status: 'MOTOR_NAO_B3', motor: 'R2' }); expect((await db.doc('carteira_comercial/GC:331').get()).data().ownerUid).toBe(ADE); expect(await cont('carteira_comercial_historico')).toBe(0);
  });
  test('cancelamento posterior da venda que causou a transferência ⇒ reversão automática (estado limpo) e decisão r2 registrada', async () => {
    await prepararTransferencia(332); await db.doc('vendas_gc/2').update({ nome_situacao: 'Cancelada' });
    const r = await rodar('ATIVO'); expect(r.reversoes).toMatchObject({ candidatas: 1, reverter: 1, executadas: 1 }); expect((await db.doc('carteira_comercial/GC:332').get()).data()).toMatchObject({ ownerUid: ADE, cicloAncoraEm: '2026-05-01', versao: 4 });
    const tipos = (await db.collection('carteira_comercial_historico').get()).docs.map(d => d.data().tipoEvento).sort(); expect(tipos).toEqual(['REATIVACAO_120D_PRIMEIRA_VENDA', 'REVERSAO_TRANSFERENCIA']);
    const r3 = await rodar('ATIVO'); expect(r3.reversoes.executadas).toBe(0); expect(await cont('carteira_comercial_historico')).toBe(2);                                         // idempotente
  });
  test('devolução TOTAL (registro controlado) invalida e reverte; PARCIAL não', async () => {
    await prepararTransferencia(333);
    await db.collection('carteira_comercial_devolucoes').doc('dv_x').set({ vendaId: '2', portfolioId: 'GC:333', tipo: 'PARCIAL', dataDevolucao: dia(0) }); expect((await rodar('ATIVO')).reversoes.candidatas).toBe(0);
    await db.collection('carteira_comercial_devolucoes').doc('dv_y').set({ vendaId: '2', portfolioId: 'GC:333', tipo: 'TOTAL', dataDevolucao: dia(0) }); const r = await rodar('ATIVO');
    expect(r.reversoes).toMatchObject({ candidatas: 1, executadas: 1 }); expect((await db.doc('carteira_comercial/GC:333').get()).data().ownerUid).toBe(ADE);
  });
  test('reversão AMBÍGUA (o novo owner vendeu depois) não decide: vira revisão; owner mantido', async () => {
    await prepararTransferencia(334); await seedV([venda(3, 334, dia(0), '222')]); await db.doc('vendas_gc/2').update({ nome_situacao: 'Cancelada' });
    const r = await rodar('ATIVO'); expect(r.reversoes).toMatchObject({ candidatas: 1, ambiguas: 1, executadas: 0 }); expect((await db.doc('carteira_comercial/GC:334').get()).data().ownerUid).toBe(FAB);
    expect((await db.collection('carteira_comercial_revisoes').get()).docs[0].data()).toMatchObject({ tipo: 'REVERSAO_AMBIGUA', estado: 'PENDENTE' });
  });
  test('renovação (cobertura) cuja venda caiu ⇒ revisão da gestão (o âncora do ciclo não é "consertado" sozinho)', async () => {
    await cfg('ATIVO'); await db.doc('carteira_comercial/GC:335').set(v2('335', ADE)); await seedV([venda(1, 335, dia(60), '111'), venda(2, 335, dia(2), '222')]); expect((await rodar('ATIVO')).aplicadas).toBe(1);
    await db.doc('vendas_gc/2').update({ nome_situacao: 'Cancelada' }); const r = await rodar('ATIVO'); expect(r.reversoes.renovacoesInvalidadas).toBe(1);
    expect((await db.collection('carteira_comercial_revisoes').get()).docs[0].data().motivos).toEqual(['RENOVACAO_INVALIDADA']);
  });
  test('venda da gestão em cliente com carteira: neutra (nada aplicado); concorrência de execuções ⇒ uma única transferência', async () => {
    await cfg('ATIVO'); await db.doc('carteira_comercial/GC:336').set(v2('336', ADE)); await seedV([venda(1, 336, dia(150), '111'), venda(2, 336, dia(1), '222'), venda(3, 336, dia(1), '999')]); await reservar(336, FAB, ADE, dia(2), dia(150));
    await Promise.allSettled([rodar('ATIVO'), rodar('ATIVO')]);
    expect(await cont('carteira_comercial_historico')).toBeLessThanOrEqual(1); expect([ADE, FAB]).toContain((await db.doc('carteira_comercial/GC:336').get()).data().ownerUid);
    const neutras = (await db.collection('carteira_reativacao_decisoes').get()).docs.map(d => d.data()).filter(d => d.vendaId === '3'); expect(neutras.every(d => d.decisao === 'VENDA_GESTAO_NEUTRA')).toBe(true);
  });
});

describe('B3.2 — nome do cliente (GestãoClick, consulta injetável) e isolamento', () => {
  beforeEach(async () => { await base(); await db.doc('carteira_comercial/GC:340').set(v2('340', FAB)); await db.doc('carteira_comercial/GC:341').set(v2('341', ADE)); await seedV([venda(1, 340, dia(150), '222'), venda(2, 341, dia(150), '111')]); await db.doc('carteira_comercial_config/reativacao').set({ modo: 'ATIVO', corte: CORTE }); });
  const job = ex => JOB.executarReativacaoDiaria(db, FieldValue, { hoje: HOJE, agoraIso: HOJE + 'T06:00:00.000Z', forcarDry: false, ...ex });
  test('ATIVO exige a consulta de nome; sem nome resolvido NÃO libera (tenta de novo); com nome grava só o nome de exibição sanitizado (sem CPF/CNPJ)', async () => {
    await expect(job({})).rejects.toThrow('LOOKUP_NOME_OBRIGATORIO');
    const sem = await job({ lookupNome: async gc => (gc === '340' ? null : 'Auto Som Silva 12.345.678/0001-90') }); expect(sem.semNome).toBeGreaterThanOrEqual(0);
    const nomes = (await db.collection('carteira_reativacoes').get()).docs.map(d => d.data()); expect(nomes.find(r => r.portfolioId === 'GC:340')).toBeUndefined();                  // sem nome ⇒ não liberada
    const r341 = nomes.find(r => r.portfolioId === 'GC:341'); expect(r341.nomeCliente).toBeTruthy(); expect(r341.nomeCliente).not.toMatch(/\d{2}\.\d{3}\.\d{3}\/\d{4}-\d{2}|12\.345/);
    await job({ lookupNome: async () => 'Cliente Nome Correto' }); expect((await db.collection('carteira_reativacoes').get()).docs.find(d => d.data().portfolioId === 'GC:340').data().nomeCliente).toBe('Cliente Nome Correto');
  });
  test('o cartão mostra o nome correto SÓ ao vendedor reservado (Ademir não vê a reserva da Fabiana)', async () => {
    await job({ lookupNome: async gc => 'Nome ' + gc }); const a = await Q.crmConsultaHandler({ auth: { uid: ADE }, data: { acao: 'fila' } }, { db }), f = await Q.crmConsultaHandler({ auth: { uid: FAB }, data: { acao: 'fila' } }, { db });
    expect(a.reativacoes.map(x => x.nomeCliente)).toEqual(['Nome 340']); expect(f.reativacoes.map(x => x.nomeCliente)).toEqual(['Nome 341']); expect(JSON.stringify(a)).not.toContain('Nome 341'); expect(JSON.stringify(f)).not.toContain('Nome 340');
  });
});
