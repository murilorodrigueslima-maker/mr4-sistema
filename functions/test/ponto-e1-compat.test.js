'use strict';
/**
 * COMPATIBILIDADE — as PÁGINAS REAIS (a publicada, em cache nos aparelhos = commit 890594c, e a do repositório) executam o
 * fluxo legítimo de hoje contra as Rules do repositório e os handlers reais das Functions. Emuladores; dados fictícios.
 *   FIRESTORE_EMULATOR_HOST=localhost:8310 npx jest --runInBand test/ponto-e1-compat
 * RULES_REF=<commit> usa as Rules daquele commit (para provar cada etapa separadamente).
 */
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8310';
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const adminSdk = require('firebase-admin');
const { abrirPagina, assentar, ler, REF_TELAS_ANTIGAS } = require('./helpers/ponto-pagina');
const C = require('./helpers/ponto-cenario');
const J = require('../lib/pontoJustificativa');
const PB = require('../lib/pontoBatida');
const { HttpsError } = require('firebase-functions/v2/https');
jest.setTimeout(90000);

const [HOST, PORT] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
if (!['localhost', '127.0.0.1'].includes(HOST)) throw new Error('Só roda no emulador local.');
const PROJECT = 'demo-ponto-compat';
const RULES = ler('modulos/firestore.rules', process.env.RULES_REF || undefined);
const { G, AD, DR, E, E2 } = C.A_UIDS;
const { F, DIA, NOME } = C;
const app = adminSdk.initializeApp({ projectId: PROJECT }, 'compat'); const adm = app.firestore();
let env;
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: RULES, host: HOST, port: Number(PORT) } }); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(c => C.semear(c.firestore())); });
afterAll(async () => { if (env) { await env.clearFirestore(); await env.cleanup(); } await app.delete(); });

const callables = {
  pontoJustificativaDecidir: r => J.decidirJustificativaHandler(r, { db: adm, now: () => new Date('2026-09-30T15:00:00Z') }),
};
const abrir = (pagina, uid, ref, prompt) => abrirPagina(pagina, { db: env.authenticatedContext(uid, { email: uid + '@exemplo.test' }).firestore(), uid, ref, prompt, callables });
const col = async (c, campo, v) => (await adm.collection(c).where(campo, '==', v).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const um = async p => { const s = await adm.doc(p).get(); return s.exists ? s.data() : null; };
const ok = p => { expect(p.erros.filter(e => /permission|PERMISSION|insufficient/i.test(e))).toEqual([]); expect(p.avisos.join('|')).not.toMatch(/sem permissão|Não foi possível|permission/i); };

const TELAS = [['tela PUBLICADA (em cache)', REF_TELAS_ANTIGAS], ['tela do repositório', undefined]];

describe.each(TELAS)('%s — funcionário', (_n, ref) => {
  test('abre, lê o próprio ponto e envia justificativa de batida e de ausência (com anexo)', async () => {
    const p = await abrir('ponto-func.html', E, ref);
    expect(p.run('funcAtivo.id')).toBe(F.E);
    await p.run('renderBancoFunc()'); await p.run('renderJustifFunc()'); await p.run('renderEspelhosFunc()'); await p.run("verMinhaFolha()");
    const envia = async (campos) => { for (const [k, v] of Object.entries(campos)) p.set(k, v); await p.run('enviarJustificativa()'); await assentar(); };
    await envia({ 'justif-data': '2026-09-29', 'justif-tipo-ocorr': 'ponto_nao_batido', 'justif-desc': 'Esqueci de registrar a saída ao fim do dia', 'justif-batida': 'saida', 'justif-horario': '17:05' });
    p.el('justif-anexo').files = [];
    await envia({ 'justif-data': '2026-09-24', 'justif-tipo-ocorr': 'Atestado médico', 'justif-desc': 'consulta' });
    ok(p);
    const novas = (await col('justificativas', 'funcId', F.E)).filter(j => j.authUid === E);
    expect(novas.map(j => j.status)).toEqual(['pendente', 'pendente']);
    expect(novas.every(j => j.funcNome === NOME[F.E] && j.lancadoPorGestor === false)).toBe(true);
  });
  test('dual-role justifica o próprio ponto como funcionário (pelo painel do funcionário)', async () => {
    const p = await abrir('ponto-func.html', DR, ref);
    for (const [k, v] of Object.entries({ 'justif-data': '2026-09-24', 'justif-tipo-ocorr': 'Atestado médico', 'justif-desc': 'consulta' })) p.set(k, v);
    await p.run('enviarJustificativa()'); await assentar();
    ok(p); expect((await col('justificativas', 'authUid', DR))).toHaveLength(1);
  });
});

describe.each(TELAS)('%s — gestão', (_n, ref) => {
  const lancar = async (p, c) => { for (const [k, v] of Object.entries({ 'gest-func': F.E2, 'gest-data': '', 'gest-data-fim': '', 'gest-tipo': '', 'gest-obs': '', ...c })) p.set(k, v); await p.run('lancarOcorrenciaGestor()'); await assentar(); };

  test.each([['gestor', G], ['administrador', AD], ['dual-role', DR]])('%s: ocorrências, férias, folga, relançamento do mesmo dia e feriados', async (_x, uid) => {
    const p = await abrir('ponto.html', uid, ref);
    await lancar(p, { 'gest-data': '2026-09-21', 'gest-tipo': 'Atestado médico', 'gest-obs': 'atestado' });
    await lancar(p, { 'gest-data': '2026-09-21', 'gest-tipo': 'Folga compensatória' });                       // sobrescreve o crédito do dia
    await lancar(p, { 'gest-data': '2026-09-14', 'gest-data-fim': '2026-09-16', 'gest-tipo': 'Férias' });
    await lancar(p, { 'gest-data': '2026-09-17', 'gest-tipo': 'Falta injustificada' });
    p.set('feriado-func-sel', F.E2); await p.run('aplicarFeriados2026()'); await assentar();
    ok(p);
    const cred = await col('creditos_jornada', 'funcId', F.E2);
    expect(cred.find(c => c.data === '2026-09-21')).toMatchObject({ minutos: 0, motivo: 'Folga compensatória' });
    expect(cred.filter(c => c.motivo === 'Férias')).toHaveLength(3);
    expect((await col('justificativas', 'funcId', F.E2)).length).toBeGreaterThanOrEqual(6 + 19);
  });

  test('proposta de marcação, análise, par/aprovação e rejeição pelo servidor; exclusão de pendente', async () => {
    const p = await abrir('ponto.html', G, ref);
    p.run(`_reg.itens=[{f:{id:'${F.E2}',nome:'${NOME[F.E2]}'},data:'2026-09-29'}]`);
    for (const [k, v] of Object.entries({ 'pend-tipo': 'entrada', 'pend-hora': '08:00', 'pend-evid': 'Registro da portaria fictícia' })) p.set(k, v);
    await p.run('proporMarcacao(0)'); await assentar();
    const prop = (await col('justificativas', 'funcId', F.E2))[0];
    expect(prop).toMatchObject({ status: 'pendente', lancadoPorGestor: true, propostoPorUid: G });
    // aprovação do pedido do funcionário (servidor) a partir da tela
    p.run("justifAtualId='j-pend'; window._ctxJustif={}"); p.set('justif-obs-gestor', 'Conferido na portaria fictícia'); p.el('justif-conferi').checked = true;
    await p.run("responderJustificativa('aprovado')"); await assentar();
    expect(await um('justificativas/j-pend')).toMatchObject({ status: 'aprovado', decididaPeloServidor: true, respondidoPorUid: G });
    p.run("justifAtualId='j-dual'"); p.set('justif-obs-gestor', 'Sem comprovação');
    await p.run("responderJustificativa('rejeitado')"); await assentar();
    expect((await um('justificativas/j-dual')).status).toBe('rejeitado');
    if (ref) { await p.run(`excluirOcorrencia('${prop.id}')`); await assentar(); expect(await um('justificativas/' + prop.id)).toBeNull(); }
    ok(p);
  });

  test('cadastro: criar, editar, avaliar e salvar o próprio cadastro (dados pessoais)', async () => {
    const p = await abrir('ponto.html', DR, ref);
    const campos = c => { for (const k of ['f-nome', 'f-cpf', 'f-rg', 'f-nasc', 'f-tel', 'f-end', 'f-cargo', 'f-admissao', 'f-salario', 'f-obs', 'f-email', 'f-perfil']) p.set(k, ''); p.set('f-modalidade', 'PRESENCIAL'); p.set('f-jornada', '8'); for (const [k, v] of Object.entries(c)) p.set(k, v); };
    campos({ 'f-nome': 'Nova Pessoa Fictícia' }); p.run('editFuncId=null'); await p.run('salvarFuncionario()'); await assentar();
    expect((await col('funcionarios', 'nome', 'Nova Pessoa Fictícia'))).toHaveLength(1);
    campos({ 'f-nome': NOME[F.E], 'f-jornada': '6', 'f-modalidade': 'HOME_OFFICE' }); p.run(`editFuncId='${F.E}'`); await p.run('salvarFuncionario()'); await assentar();
    expect(await um('funcionarios/' + F.E)).toMatchObject({ jornada: '6', modalidade: 'HOME_OFFICE' });
    campos({ 'f-nome': NOME[F.DR], 'f-tel': '0000' }); p.run(`editFuncId='${F.DR}'`); await p.run('salvarFuncionario()'); await assentar();
    expect(await um('funcionarios/' + F.DR)).toMatchObject({ telefone: '0000', jornada: '8' });
    p.run(`avalFuncId='${F.E}'`); await p.run('salvarAvaliacao()'); await assentar();
    ok(p);
  });
});

describe('fechamento do mês — gestão envia, funcionário assina, gestão reabre, funcionário assina a revisão', () => {
  const MES = '2026-09';
  test.each(TELAS)('gestão na %s', async (_n, refGestao) => {
    await adm.doc('funcionarios/' + F.E2).update({ inicioBancoHoras: '2026-10-01' });     // setembro sem pendências
    const g = await abrir('ponto.html', G, refGestao, 'Revisão fictícia do período');
    const enviar = async () => { g.set('esp-func', F.E2); g.set('esp-mes', MES); await g.run('gerarEspelho()'); await assentar(); await g.run(`enviarParaAssinar('esp-novo','${F.E2}','${MES}','Setembro/2026')`); await assentar(); };
    await enviar();
    let v1 = (await col('espelhos', 'funcId', F.E2))[0];
    expect(v1).toMatchObject({ id: 'esp-novo', assinado: false, versao: 1 });
    const hash1 = v1.hashSnapshot;
    await g.run(`enviarParaAssinar('esp-novo','${F.E2}','${MES}','Setembro/2026')`); await assentar();   // reenvio idêntico
    await new Promise(r => setTimeout(r, 5)); await enviar();                                            // regerar e reenviar
    expect((await um('espelhos/esp-novo')).hashSnapshot).not.toBe(hash1);
    // funcionário assina na tela corrigida (E0)
    const assinar = async id => { const f = await abrir('ponto-func.html', E2, undefined); await f.run(`abrirAssinar('${id}','${F.E2}','${MES}','Setembro/2026')`); await assentar(); f.run('iniciarCanvas()'); await f.run('confirmarAssinatura()'); await assentar(); ok(f); };
    await assinar('esp-novo');
    v1 = await um('espelhos/esp-novo'); expect(v1).toMatchObject({ assinado: true, assinadoPor: NOME[F.E2] });
    // reabertura com justificativa
    g.run("invalidarCache('espelhos')"); g.set('esp-func', F.E2); g.set('esp-mes', MES); await g.run('gerarEspelho()'); await assentar();
    await g.run(`iniciarRevisaoPeriodo('${F.E2}','${MES}')`); await assentar();
    const todos = await col('espelhos', 'funcId', F.E2); expect(todos).toHaveLength(2);
    const v2 = todos.find(e => e.versao === 2);
    expect(v2).toMatchObject({ versaoAnteriorId: 'esp-novo', motivoRevisao: 'Revisão fictícia do período', assinado: false });
    expect(await um('espelhos/esp-novo')).toMatchObject({ assinado: true, snapshot: v1.snapshot, versaoSucessoraId: v2.id, revisaoEmAndamento: true });
    await assinar(v2.id);
    expect((await um('espelhos/' + v2.id)).assinado).toBe(true);
    ok(g);
  });
});

describe('batida (servidor) segue igual para clientes novos e antigos', () => {
  test('sequência completa sem e com intenção', async () => {
    const bater = x => PB.registrarBatidaTx(adm, { funcId: F.E2, uid: E2, func: { nome: NOME[F.E2] }, data: '2026-09-29', modalidade: 'PRESENCIAL', dentroRaio: true, lat: null, lng: null, horaCliente: null, facialScore: null, foto: null,
      requestId: null, tipoEsperado: null, agoraMs: Date.now(), cooldownOverrideMs: 0, LABEL_PONTO: { entrada: 'Entrada', saida_almoco: 'Saída almoço', retorno_almoco: 'Retorno almoço', saida: 'Saída' }, HttpsError, serverTimestamp: () => adminSdk.firestore.FieldValue.serverTimestamp(), ...x, });
    for (const [hora, extra] of [['08:00:00', {}], ['12:00:00', {}], ['13:00:00', { requestId: 'intencao-3333', tipoEsperado: 'retorno_almoco' }], ['17:00:00', { requestId: 'intencao-4444', tipoEsperado: 'saida' }]])
      expect((await bater({ hora, ...extra })).status).toBe('REGISTRADO');
  });
});
