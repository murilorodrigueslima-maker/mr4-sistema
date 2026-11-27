'use strict';
/**
 * PONTO INTEGRIDADE E2 — trilha append-only e correções de servidor (EMULADOR; dados fictícios).
 *   node scripts/testes/rodar.js -- test/ponto-e2
 */

if (!/^(localhost|127\.0\.0\.1):\d+$/.test(process.env.FIRESTORE_EMULATOR_HOST)) throw new Error('Só roda no emulador local.');
const PROJECT = 'demo-ponto-e2';
process.env.GCLOUD_PROJECT = PROJECT; process.env.PONTO_COOLDOWN_MS = '0';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: PROJECT });
const db = admin.firestore(); const FieldValue = admin.firestore.FieldValue;
const crypto = require('crypto'), vm = require('vm');
const T = require('../lib/pontoTrilha');
const J = require('../lib/pontoJustificativa');
const { _registrarPontoHandler: bater } = require('../index');
const { ler } = require('./helpers/ponto-pagina');
const M = {}; vm.createContext(M); vm.runInContext(ler('modulos/ponto-regras.js'), M);
jest.setTimeout(90000);

const F = 'e2-fx', G = 'e2-gestor', U = 'e2-func';
const COLS = ['users', 'sistema_usuarios', 'funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'ponto_trilha', 'ponto_trilha_blobs', 'ponto_justificativas_decisoes', 'ponto_justificativas_lock', 'ponto_meses_protegidos'];
const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
beforeEach(async () => {
  await limpar();
  await db.doc('users/' + G).set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/' + G).set({ modulos: ['ponto'], admin: false, email: 'g@exemplo.test' });
  await db.doc('users/' + U).set({ role: 'funcionario', ativo: true, funcionarioId: F });
  await db.doc('funcionarios/' + F).set({ nome: 'Pessoa Fictícia', jornada: 8, modalidade: 'HOME_OFFICE' });
});
afterAll(async () => { await limpar(); await Promise.all(admin.apps.map(a => a.delete())); });

let seq = 0;
const snap = d => ({ exists: d !== null, data: () => d, id: 'x' });
const evento = (id, antes, depois, x = {}) => ({ id: 'ev-' + (++seq), time: '2026-11-26T12:00:00Z', authType: 'app_user', authId: G, params: { id }, data: { before: snap(antes), after: snap(depois) }, ...x });
const gravar = (ev, col) => T.registrar(ev, col, { db, FieldValue, logger: { warn() {}, error() {} } });
const trilha = async () => (await db.collection('ponto_trilha').get()).docs.map(d => ({ id: d.id, ...d.data() }));
const grande = c => 'data:image/png;base64,' + c.repeat(5000);

describe('Trilha append-only', () => {
  test('autor vem do contexto de autenticação (não do que o documento declara); natureza batida × ajuste', async () => {
    await gravar(evento('r1', null, { funcId: F, data: '2026-11-02', tipo: 'entrada', hora: '08:00:00' }, { authType: 'service_account', authId: 'sa' }), 'registros');
    await gravar(evento('corr_j', null, { funcId: F, data: '2026-11-02', tipo: 'saida', hora: '17:00:00', lancadoPorJustificativa: true, aprovadoPorUid: 'declarado' }), 'registros');
    const t = (await trilha()).sort((a, b) => a.docId.localeCompare(b.docId));
    expect(t[0]).toMatchObject({ evento: 'CORRECAO_REGISTRADA', natureza: 'AJUSTE_ADMINISTRATIVO', autorUid: G, autorPapel: 'gestor', declarado: { aprovadoPorUid: 'declarado' }, funcId: F, mes: '2026-11' });
    expect(t[1]).toMatchObject({ evento: 'BATIDA_REGISTRADA', natureza: 'BATIDA_ORIGINAL', autorUid: null, autorTipo: 'SYSTEM' });
  });
  test('autor é resolvido por ID ou e-mail e o contexto bruto fica guardado', async () => {
    await db.doc('users/' + G).set({ role: 'gestor', ativo: true, email: 'g@exemplo.test' });
    await gravar(evento('a', null, { funcId: F, data: '2026-11-02' }, { authType: 'unknown', authId: G }), 'justificativas');
    await gravar(evento('b', null, { funcId: F, data: '2026-11-02' }, { authType: 'unknown', authId: 'g@exemplo.test' }), 'justificativas');
    await gravar(evento('c', null, { funcId: F, data: '2026-11-02' }, { authType: 'unknown', authId: 'ninguem@exemplo.test' }), 'justificativas');
    const t = Object.fromEntries((await trilha()).map(x => [x.docId, x]));
    expect(t.a).toMatchObject({ autorUid: G, autorTipo: 'USER', autorPapel: 'gestor', autorAuthId: G, autorAuthType: 'unknown' });
    expect(t.b).toMatchObject({ autorUid: G, autorTipo: 'USER', autorAuthId: 'g@exemplo.test' });
    expect(t.c).toMatchObject({ autorUid: null, autorAuthId: 'ninguem@exemplo.test' });
  });
  test('exclusão e alteração preservam o conteúdo anterior, inclusive anexo/foto grandes', async () => {
    const j = { funcId: F, data: '2026-11-02', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false, anexo: grande('A') };
    await gravar(evento('j1', j, null), 'justificativas');
    await gravar(evento(F, { nome: 'N', jornada: 8, foto: grande('B') }, { nome: 'N', jornada: 6, foto: grande('C') }), 'funcionarios');
    const t = await trilha(); const ex = t.find(x => x.evento === 'JUSTIFICATIVA_EXCLUIDA'), al = t.find(x => x.evento === 'CADASTRO_ALTERADO');
    expect(ex.antes.motivo).toBe('Atestado médico');
    expect((await db.doc('ponto_trilha_blobs/' + ex.antes.anexo.sha256).get()).data().conteudo).toBe(j.anexo);
    expect(al).toMatchObject({ camposAlterados: ['foto', 'jornada'], antes: { jornada: 8 }, depois: { jornada: 6 } });
    expect((await db.doc('ponto_trilha_blobs/' + al.antes.foto.sha256).get()).data().conteudo).toBe(grande('B'));
    expect((await db.collection('ponto_trilha_blobs').get()).size).toBe(2);                 // conteúdo novo (ainda no documento) não é duplicado
  });
  test('crédito sobrescrito mantém antes e depois; escrita sem mudança não gera evento; reentrega não duplica nem sobrescreve', async () => {
    const a = { funcId: F, data: '2026-11-03', minutos: 480, motivo: 'Feriado municipal' }, b = { ...a, minutos: 0, motivo: 'Folga compensatória' };
    const ev = evento('cred', a, b);
    expect((await gravar(ev, 'creditos_jornada')).gravado).toBe(true);
    expect((await gravar({ ...ev, data: { before: snap(a), after: snap({ ...b, minutos: 999 }) } }, 'creditos_jornada')).gravado).toBe(false);
    expect((await gravar(evento('cred', b, { ...b }), 'creditos_jornada')).gravado).toBe(false);
    const t = await trilha(); expect(t).toHaveLength(1);
    expect(t[0]).toMatchObject({ evento: 'CREDITO_ALTERADO', antes: { minutos: 480, motivo: 'Feriado municipal' }, depois: { minutos: 0 } });
  });
  test('fechamento: envio, reenvio (versão anterior preservada), assinatura com hash conferido, reabertura com motivo, conclusão', async () => {
    const func = { id: F, nome: 'Pessoa Fictícia', jornada: 8, inicioBancoHoras: '2026-10-01' };
    const s1 = JSON.parse(JSON.stringify({ ...M.buildEspelhoSnapshot(func, [], [], [], '2026-09', '2026-11-26'), geradoEm: 'g1', funcId: F }));
    const h = s => crypto.createHash('sha256').update(M.canonicalizarSnapshot(s)).digest('hex');
    const e1 = { funcId: F, mes: '2026-09', versao: 1, versaoAnteriorId: null, assinado: false, snapshot: s1, hashSnapshot: h(s1) };
    const s2 = { ...s1, geradoEm: 'g2' }, e2 = { ...e1, snapshot: s2, hashSnapshot: h(s2) };
    const ass = { ...e2, assinado: true, assinaturaImg: grande('S'), hashAssinado: e2.hashSnapshot, assinadoPor: 'Pessoa Fictícia' };
    const reab = { ...ass, revisaoEmAndamento: true, versaoSucessoraId: 'v2', motivoRevisao: 'Motivo fictício' };
    for (const [a, b, x] of [[null, e1], [e1, e2], [e2, ass, { authId: U }], [ass, reab], [reab, { ...reab, substituido: true, revisaoEmAndamento: false }, { authType: 'service_account' }]]) await gravar(evento('esp1', a, b, x), 'espelhos');
    const t = (await trilha()).sort((a, b) => Number(a.id.slice(3)) - Number(b.id.slice(3)));
    expect(t.map(x => x.evento)).toEqual(['ESPELHO_ENVIADO', 'ESPELHO_REENVIADO', 'ESPELHO_ASSINADO', 'MES_REABERTO', 'REVISAO_CONCLUIDA']);
    expect(t[1].antes.snapshot.geradoEm).toBe('g1');
    expect(t[2]).toMatchObject({ autorUid: U, assinatura: { hashConfere: true } });
    expect(t[3].justificativa.motivoRevisao).toBe('Motivo fictício');
  });
  test('D13: assinatura sobre snapshot trocado sem trocar o hash fica registrada como divergente', async () => {
    const s = JSON.parse(JSON.stringify({ ...M.buildEspelhoSnapshot({ id: F, nome: 'N', jornada: 8 }, [], [], [], '2026-09', '2026-11-26'), geradoEm: 'g', funcId: F }));
    const antes = { funcId: F, mes: '2026-09', assinado: false, snapshot: { ...s, totais: { ...s.totais, saldo: -999 } }, hashSnapshot: crypto.createHash('sha256').update(M.canonicalizarSnapshot(s)).digest('hex') };
    await gravar(evento('esp2', antes, { ...antes, assinado: true, hashAssinado: antes.hashSnapshot }), 'espelhos');
    expect((await trilha())[0].assinatura.hashConfere).toBe(false);
  });
  test('o código da trilha não altera nem apaga: só create()', () => {
    const src = ler('functions/lib/pontoTrilha.js');
    expect(src).not.toMatch(/\.(set|update|delete)\(\s*[{)]|ref\.(set|update|delete)\(/);
  });
});

describe('Decisão de justificativas', () => {
  const o = { db, now: () => new Date('2026-10-20T15:00:00Z') };
  const req = d => ({ auth: { uid: G }, data: d });
  const erro = p => p.then(() => 'OK', e => e.message);
  const pedido = { funcId: F, funcNome: 'Pessoa Fictícia', data: '2026-10-07', motivo: 'Ponto não batido', descricao: '', tipoPonto: 'saida', horarioPonto: '18:00', status: 'pendente', lancadoPorGestor: false };
  test('D11: "evidenciaGestao" em pedido do funcionário é ignorada; em lançamento da gestão vale', async () => {
    await db.doc('justificativas/a').set({ ...pedido, id: 'a', evidenciaGestao: 'gravada pelo funcionário' });
    expect(await erro(J.decidirJustificativaHandler(req({ ids: ['a'], decisao: 'APROVAR' }), o))).toBe('EVIDENCIA_OBRIGATORIA_JUSTIFICATIVA_ANTIGA');
    await db.doc('justificativas/b').set({ ...pedido, id: 'b', data: '2026-10-08', lancadoPorGestor: true, evidenciaGestao: 'Registro da portaria fictícia', propostoPorUid: G });
    expect(await J.decidirJustificativaHandler(req({ ids: ['b'], decisao: 'APROVAR' }), o)).toMatchObject({ ok: true });
    expect((await db.doc('registros/corr_b').get()).data()).toMatchObject({ inseridoManualmente: true, origemSolicitacao: 'GESTAO', propostoPorUid: G, aprovadoPorUid: G, lancadoPorJustificativa: true });
  });
  test('correção: original preservado e a correção identificada como manual, com responsável', async () => {
    await db.doc('registros/o1').set({ funcId: F, data: '2026-10-19', tipo: 'saida', hora: '17:00:00' });
    await db.doc('justificativas/c').set({ ...pedido, id: 'c', data: '2026-10-19' });
    await J.decidirJustificativaHandler(req({ ids: ['c'], decisao: 'APROVAR', obs: 'Conferido' }), o);
    expect((await db.doc('registros/o1').get()).data()).toMatchObject({ hora: '17:00:00', substituidoPor: 'corr_c' });
    expect((await db.doc('registros/corr_c').get()).data()).toMatchObject({ origemSolicitacao: 'FUNCIONARIO', propostoPorUid: null, observacaoAprovacao: 'Conferido', valorOriginal: [{ id: 'o1', hora: '17:00:00', tipo: 'saida' }] });
  });
  test('D18: o crédito anterior fica na trilha da decisão; o novo identifica o responsável', async () => {
    await db.doc(`creditos_jornada/cred_${F}_2026-10-07`).set({ funcId: F, data: '2026-10-07', minutos: 240, motivo: 'Feriado municipal', criadoEm: '2026-10-01T00:00:00Z' });
    await db.doc('justificativas/d').set({ id: 'd', funcId: F, data: '2026-10-07', motivo: 'Atestado médico', status: 'pendente', lancadoPorGestor: false });
    await J.decidirJustificativaHandler(req({ ids: ['d'], decisao: 'APROVAR' }), o);
    const dec = (await db.collection('ponto_justificativas_decisoes').get()).docs[0].data();
    expect(dec.creditoAnterior).toMatchObject({ id: `cred_${F}_2026-10-07`, minutos: 240, motivo: 'Feriado municipal' });
    expect(dec.creditoNovo).toMatchObject({ minutos: 480, motivo: 'Atestado médico' });
    expect((await db.doc(`creditos_jornada/cred_${F}_2026-10-07`).get()).data()).toMatchObject({ minutos: 480, lancadoPorUid: G });
  });
});

describe('D06: cadastro inativado não registra ponto; ativo segue igual', () => {
  const req = { auth: { uid: U, token: {} }, data: {} };
  test('inativo é recusado; reativado registra', async () => {
    await db.doc('funcionarios/' + F).update({ inativo: true });
    await expect(bater(req)).rejects.toThrow(/Cadastro inativo/);
    expect((await db.collection('registros').get()).size).toBe(0);
    await db.doc('funcionarios/' + F).update({ inativo: false });
    await expect(bater(req)).resolves.toMatchObject({ ok: true, tipo: 'entrada' });
  });
});
