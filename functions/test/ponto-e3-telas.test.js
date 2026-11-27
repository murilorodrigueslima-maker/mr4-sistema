'use strict';
/**
 * PONTO INTEGRIDADE E3 — telas (páginas REAIS contra Rules + handlers reais; EMULADOR; dados fictícios).
 *   FIRESTORE_EMULATOR_HOST=localhost:8310 npx jest --runInBand test/ponto-e3
 */
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8310';
const { initializeTestEnvironment } = require('@firebase/rules-unit-testing');
const adminSdk = require('firebase-admin');
const crypto = require('crypto'), vm = require('vm');
const { abrirPagina, assentar, ler } = require('./helpers/ponto-pagina');
const C = require('./helpers/ponto-cenario');
const J = require('../lib/pontoJustificativa');
jest.setTimeout(120000);

const [HOST, PORT] = process.env.FIRESTORE_EMULATOR_HOST.split(':');
if (!['localhost', '127.0.0.1'].includes(HOST)) throw new Error('Só roda no emulador local.');
const PROJECT = 'demo-ponto-e3t';
const { G, DR, E, E2 } = C.A_UIDS; const { F, NOME } = C;
const M = {}; vm.createContext(M); vm.runInContext(ler('modulos/ponto-regras.js'), M);
const app = adminSdk.initializeApp({ projectId: PROJECT }, 'e3'); const adm = app.firestore();
let env;
beforeAll(async () => { env = await initializeTestEnvironment({ projectId: PROJECT, firestore: { rules: ler('modulos/firestore.rules', process.env.RULES_REF || undefined), host: HOST, port: Number(PORT) } }); });
beforeEach(async () => { await env.clearFirestore(); await env.withSecurityRulesDisabled(c => C.semear(c.firestore())); });
afterAll(async () => { if (env) { await env.clearFirestore(); await env.cleanup(); } await app.delete(); });

const callables = { pontoJustificativaDecidir: r => J.decidirJustificativaHandler(r, { db: adm, now: () => new Date('2026-09-30T15:00:00Z') }) };
const abrir = (pagina, uid, prompt) => abrirPagina(pagina, { db: env.authenticatedContext(uid, { email: uid + '@exemplo.test' }).firestore(), uid, prompt, callables });
const um = async p => { const s = await adm.doc(p).get(); return s.exists ? s.data() : null; };
const col = async (c, campo, v) => (await adm.collection(c).where(campo, '==', v).get()).docs.map(d => ({ id: d.id, ...d.data() }));
const hashDe = s => crypto.createHash('sha256').update(M.canonicalizarSnapshot(s)).digest('hex');

describe('Gestão', () => {
  test('Inativar/Reativar no lugar de apagar: exige motivo, registra responsável, some dos painéis e lançamentos', async () => {
    const curto = await abrir('ponto.html', G, 'abc'); await curto.run(`inativarFunc('${F.E2}')`); await assentar();
    expect((await um('funcionarios/' + F.E2)).inativo).toBeUndefined();
    const p = await abrir('ponto.html', G, 'Encerramento fictício do vínculo'); await p.run(`inativarFunc('${F.E2}')`); await assentar();
    expect(await um('funcionarios/' + F.E2)).toMatchObject({ nome: NOME[F.E2], inativo: true, inativadoPorUid: G, motivoInativacao: 'Encerramento fictício do vínculo' });
    await p.run('renderHoje()'); await p.run('renderFuncionarios()'); await assentar();
    expect(p.el('tbody-hoje').innerHTML).not.toContain(NOME[F.E2]);
    expect(p.el('gest-func').innerHTML).not.toContain(NOME[F.E2]);
    expect(p.el('esp-func').innerHTML).toContain(NOME[F.E2]);                       // histórico continua consultável
    expect(p.el('lista-funcionarios').innerHTML).toMatch(/Inativo[\s\S]*Reativar/);
    expect(p.el('lista-funcionarios').innerHTML).not.toMatch(/removerFunc|>Remover</);
    await p.run(`reativarFunc('${F.E2}')`); await assentar();
    expect((await um('funcionarios/' + F.E2)).inativo).toBe(false);
  });
  test('Cancelar pedido pendente = rejeição com motivo pelo servidor (nada é apagado); proposta da gestão ganha "Analisar"', async () => {
    await adm.doc('justificativas/prop').set({ id: 'prop', funcId: F.E2, funcNome: NOME[F.E2], data: '2026-09-29', motivo: 'Ponto não batido', tipoPonto: 'entrada', horarioPonto: '08:00', status: 'pendente', lancadoPorGestor: true });
    const p = await abrir('ponto.html', G, 'Pedido em duplicidade');
    p.set('fil-justif', 'todos'); await p.run('renderJustificativas()'); await assentar();
    const h = p.el('lista-justificativas').innerHTML;
    expect(h).toContain("abrirJustifGestor('prop')"); expect(h).toContain("cancelarOcorrencia('prop')"); expect(h).not.toContain('excluirOcorrencia');
    await p.run("cancelarOcorrencia('prop')"); await assentar();
    expect(await um('justificativas/prop')).toMatchObject({ status: 'rejeitado', respondidoPorUid: G, obsGestor: 'Cancelada pela gestão: Pedido em duplicidade', decididaPeloServidor: true });
  });
  test('lançamentos manuais identificam responsável e hora do servidor (justificativa e crédito)', async () => {
    const p = await abrir('ponto.html', DR);
    for (const [k, v] of Object.entries({ 'gest-func': F.E2, 'gest-data': '2026-09-21', 'gest-data-fim': '', 'gest-tipo': 'Atestado médico', 'gest-obs': '' })) p.set(k, v);
    await p.run('lancarOcorrenciaGestor()'); await assentar();
    for (const d of [(await col('justificativas', 'funcId', F.E2))[0], (await col('creditos_jornada', 'funcId', F.E2))[0]]) {
      expect(d.lancadoPorUid).toBe(DR); expect(typeof d.lancadoEm.toMillis).toBe('function');
    }
  });
  test('painel Hoje usa o motor do dia; Registros marca ajuste com "J"', async () => {
    const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date());
    for (const [t, h] of [['entrada', '08:00'], ['saida_almoco', '12:00'], ['retorno_almoco', '13:00'], ['saida', '17:00']]) await adm.doc(`registros/h_${t}`).set({ funcId: F.E2, funcNome: NOME[F.E2], data: hoje, tipo: t, tipoLabel: t, hora: h + ':00', ...(t === 'saida' ? { lancadoPorJustificativa: true } : {}) });
    const p = await abrir('ponto.html', G);
    await p.run('renderHoje()'); await assentar(); expect(p.el('tbody-hoje').innerHTML).toContain(M.fmtMin(480));
    p.set('fil-func-reg', F.E2); p.set('fil-mes', hoje.slice(0, 7)); await p.run('renderRegistros()'); await assentar();
    expect(p.el('tbody-registros').innerHTML).toMatch(/17:00 <sup[^>]*>J<\/sup>/);
    expect(p.el('tbody-registros').innerHTML).not.toMatch(/08:00 <sup/);
  });
  test('fechamento do mês, versões preservadas e histórico de alterações', async () => {
    await adm.doc('espelhos/v2').set({ id: 'v2', funcId: F.E, mes: C.MES_FECHADO, versao: 2, versaoAnteriorId: 'esp-assinado', assinado: false, motivoRevisao: 'Revisão fictícia', snapshot: { dias: [], totais: {}, geradoEm: '2026-09-01T00:00:00Z' }, hashSnapshot: 'h2' });
    await adm.doc('ponto_trilha/t1').set({ funcId: F.E, mes: C.MES_FECHADO, evento: 'MES_REABERTO', autorUid: G, justificativa: { motivoRevisao: 'Revisão fictícia' }, criadoEm: new Date() });
    await adm.doc('espelhos/esp-assinado').update({ snapshot: { engineVersao: '4.0.0', dias: [], totais: { trabMin: 0, saldo: 0 }, geradoEm: '2026-08-31T12:00:00Z' } });
    const p = await abrir('ponto.html', G);
    p.set('esp-mes', C.MES_FECHADO); await p.run('renderFechamento()'); await assentar();
    expect(p.el('fechamento-mes').innerHTML).toMatch(/Reaberto — v2 aguardando assinatura[\s\S]*Revisão fictícia/);
    expect(p.run("situacaoFechamento([]).chave")).toBe('NAO_ENVIADO');
    p.set('esp-func', F.E); await p.run('gerarEspelho()'); await assentar();
    expect(p.el('espelho-conteudo').innerHTML).toMatch(/Versões deste espelho[\s\S]*v2[\s\S]*v1/);
    await p.run("verVersaoEspelho('esp-assinado')"); await assentar();
    expect(p.el('espelho-extra').innerHTML).toMatch(/Versão v1 — cópia guardada \(assinada\)/);
    await p.run(`verHistoricoPonto('${F.E}','${C.MES_FECHADO}')`); await assentar();
    expect(p.el('espelho-extra').innerHTML).toMatch(/Mês reaberto/);
  });
});

describe('Funcionário', () => {
  const MES = '2026-09', DIA_FOLGA = '2026-09-15';
  test('D19: espelho com folga compensatória do banco é anotado na exibição e PODE ser assinado; snapshot e hash intactos', async () => {
    const func = { id: F.E2, nome: NOME[F.E2], cargo: 'Teste', jornada: '8', modalidade: 'PRESENCIAL', inicioBancoHoras: DIA_FOLGA };
    await adm.doc('funcionarios/' + F.E2).set({ nome: func.nome, cargo: 'Teste', jornada: '8', inicioBancoHoras: DIA_FOLGA, afastamentoBanco: { inicio: '2026-09-16', fim: '2026-09-30', tipo: 'FERIAS' } });
    await adm.doc(`banco_horas_lancamentos/${F.E2}_${DIA_FOLGA}`).set({ funcId: F.E2, tipo: 'FOLGA_COMPENSATORIA', data: DIA_FOLGA, dataAusencia: DIA_FOLGA, minutos: 480, periodo: 'DIA_INTEIRO' });
    const g = await abrir('ponto.html', G);
    g.set('esp-func', F.E2); g.set('esp-mes', MES); await g.run('gerarEspelho()'); await assentar();
    expect(g.el('espelho-conteudo').innerHTML).toContain('Folga compensatória (banco de horas) dia inteiro');
    await g.run(`enviarParaAssinar('esp-folga','${F.E2}','${MES}','Setembro/2026')`); await assentar();
    const antes = await um('espelhos/esp-folga');
    expect(JSON.stringify(antes.snapshot)).not.toContain('banco de horas');
    expect(antes.geradoPorUid).toBe(G);
    // a folga é um dia com falta no motor: não há pendência de ponto, então a assinatura é permitida
    const f = await abrir('ponto-func.html', E2);
    await f.run(`abrirAssinar('esp-folga','${F.E2}','${MES}','Setembro/2026')`); await assentar();
    expect(f.el('espelho-para-assinar').innerHTML).toContain('Folga compensatória (banco de horas)');
    f.run('iniciarCanvas()'); await f.run('confirmarAssinatura()'); await assentar();
    const depois = await um('espelhos/esp-folga');
    expect(depois).toMatchObject({ assinado: true, hashAssinado: antes.hashSnapshot });
    expect(depois.assinadoPorUid).toBe(process.env.RULES_REF ? undefined : E2);   // RULES_REF = Rules anteriores à E1 (caminho de compatibilidade)
    expect(depois.snapshot).toEqual(antes.snapshot);
    expect(hashDe(depois.snapshot)).toBe(depois.hashAssinado);
  });
  test('D20: antes de o dia fechar, hoje não vira falta no saldo; mesma função nas duas telas', () => {
    const r = (tipo, hora) => ({ tipo, hora: hora + ':00' });
    expect(M.corteBancoMes([], '2026-09-15', '2026-09-14')).toBe('2026-09-14');
    expect(M.corteBancoMes([r('entrada', '08:00')], '2026-09-15', '2026-09-14')).toBe('2026-09-14');
    expect(M.corteBancoMes([r('entrada', '08:00'), r('saida_almoco', '12:00'), r('retorno_almoco', '13:00'), r('saida', '17:00')], '2026-09-15', '2026-09-14')).toBe('2026-09-15');
    for (const p of ['modulos/ponto.html', 'modulos/ponto-func.html']) expect(ler(p)).toContain('corteBancoMes(');
  });
  test('D04: tela Registros e o mês escolhem o mesmo crédito', () => {
    const d = '2026-09-15', func = { id: 'fx', jornada: 8 };
    const cs = [{ id: 'a', funcId: 'fx', data: d, minutos: 480, motivo: 'Atestado médico' }, { id: 'b', funcId: 'fx', data: d, minutos: 0, motivo: 'Folga compensatória' }];
    for (const lista of [cs, [...cs].reverse()]) {
      expect(M.calcDia(func, d, [], M.creditoDoDia(lista, 'fx', d), []).saldoMin).toBe(M.calcMes(func, [], lista, [], '2026-09', d).dias.find(x => x.data === d).saldoMin);
    }
  });
  test('D19: anotação não altera o objeto recebido', () => {
    const s = { dias: [{ data: DIA_FOLGA, ocorrencia: '' }] }, l = [{ id: 'x', tipo: 'FOLGA_COMPENSATORIA', data: DIA_FOLGA, minutos: 240, periodo: 'HORAS' }];
    expect(M.anotarFolgasExibicao(s, l).dias[0].ocorrencia).toMatch(/04:00|4h/);
    expect(s.dias[0].ocorrencia).toBe('');
    expect(M.anotarFolgasExibicao(s, [...l, { tipo: 'ESTORNO', estornaId: 'x' }])).toBe(s);
  });
});
