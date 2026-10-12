'use strict';
// Fase 4.1 — correção retroativa dos sábados: classificação (pura), idempotência e preservação do histórico (emulador). Dados sintéticos.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path'), crypto = require('crypto');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore(); const { FieldValue } = admin.firestore;
const S = require('../scripts/ponto_sabados_corrigir'); const B = require('../lib/pontoBanco');
jest.setTimeout(120000);
let seq = 0;
const reg = (funcId, data, tipo, hora) => ({ id: 'r' + (++seq), funcId, data, tipo, hora: hora + ':00' });
const sab = (funcId, data, e, sa, ra, s) => [['entrada', e], ['saida_almoco', sa], ['retorno_almoco', ra], ['saida', s]].filter(x => x[1]).map(([t, h]) => reg(funcId, data, t, h));
const F = { id: 'F1', nome: 'X', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-05-02' };
// 4 sábados "limpos" (2 marcações) para comprovar a escala + casos de teste
const LIMPOS = ['2026-05-02', '2026-05-09', '2026-05-16', '2026-05-23'].flatMap(d => sab('F1', d, '08:30', null, null, '12:00'));
const cls = (regs, extra = {}, cred = [], just = [], esp = []) => S.classificar({ ...F, ...extra }, [...LIMPOS, ...regs], cred, just, esp);
const item = (r, ds) => r.itens.find(x => x.data === ds);

describe('classificação', () => {
  test('intervalo nulo (sa==ra) e ra==saída: ELEGÍVEIS, com horários preservados e critérios', () => {
    const r = cls([...sab('F1', '2026-06-06', '08:36', '12:03', '12:03', '12:10'), ...sab('F1', '2026-06-13', '08:40', '12:00', '12:05', '12:05')]);
    expect(item(r, '2026-06-06')).toMatchObject({ classe: 'ELEGIVEL', marcas: { e: '08:36', sa: '12:03', ra: '12:03', s: '12:10' }, depois: { status: 'ok', trabalhadoMin: 214, saldoMin: 4 } });
    expect(item(r, '2026-06-13')).toMatchObject({ classe: 'ELEGIVEL', depois: { trabalhadoMin: 200, saldoMin: -10 } });   // intervalo de 5 min (12:00–12:05) continua descontado
    expect(item(r, '2026-06-06').criterios).toEqual(expect.arrayContaining(['INTERVALO_NULO']));
  });
  test('atraso e saída antecipada são calculados, não "corrigidos": ficam com o saldo real', () => {
    const r = cls([...sab('F1', '2026-06-06', '09:10', '12:00', '12:00', '12:00'), ...sab('F1', '2026-06-13', '08:30', '11:20', '11:20', '11:20')]);
    expect(item(r, '2026-06-06').depois).toMatchObject({ trabalhadoMin: 170, saldoMin: -40 });
    expect(item(r, '2026-06-13').depois).toMatchObject({ trabalhadoMin: 170, saldoMin: -40 });
  });
  test('PENDENTES com motivo: marcações faltantes, ordem inválida, fora do padrão do funcionário, total fora da jornada, ocorrência no dia', () => {
    const r = cls([
      ...sab('F1', '2026-06-06', '08:30', null, '12:05', null),                      // faltantes
      ...sab('F1', '2026-06-13', '08:30', '12:10', '12:05', '12:30'),                // ordem inválida
      ...sab('F1', '2026-06-20', '10:30', '14:00', '14:00', '14:00'),                // entrada fora do padrão (≈08:30)
      ...sab('F1', '2026-06-27', '08:30', '14:50', '14:50', '14:50'),                // total 6h20 (fora da jornada)
      ...sab('F1', '2026-07-04', '08:30', '12:00', '12:00', '12:00'),                // com justificativa
    ], {}, [{ funcId: 'F1', data: '2026-07-04', motivo: 'Atraso justificado', minutos: 10 }], []);
    expect(item(r, '2026-06-06').motivo).toBe('MARCACOES_FALTANTES');
    expect(item(r, '2026-06-13').motivo).toBe('PADRAO_DE_MARCACOES_FORA_DA_CAUSA_INTERVALO_NULO');
    expect(item(r, '2026-06-20').motivo).toBe('ENTRADA_FORA_DO_PADRAO_DO_FUNCIONARIO');
    expect(item(r, '2026-06-27').motivo).toBe('TOTAL_FORA_DA_JORNADA_DE_SABADO');
    expect(item(r, '2026-07-04').motivo).toBe('OUTRA_OCORRENCIA_NO_DIA_REVISAO_MANUAL');
  });
  test('sem evidência de escala (poucos sábados limpos), sem início do banco, fora do banco: PENDENTE', () => {
    const regs = sab('F1', '2026-06-06', '08:30', '12:00', '12:00', '12:00');
    const r = S.classificar({ ...F }, regs, [], [], []);                                            // nenhum sábado limpo
    expect(item(r, '2026-06-06').motivo).toBe('ESCALA_DESCONHECIDA_SEM_EVIDENCIA_SUFICIENTE');
    expect(item(cls(sab('F1', '2026-06-06', '08:30', '12:00', '12:00', '12:00'), { inicioBancoHoras: undefined }), '2026-06-06').motivo).toBe('SEM_DATA_DE_INICIO_DO_BANCO');
    expect(item(cls(sab('F1', '2026-06-06', '08:30', '12:00', '12:00', '12:00'), { controleBancoHoras: false }), '2026-06-06')).toBeUndefined();   // fora do banco: o motor nem conta o dia
  });
  test('MÊS ASSINADO: nunca corrigido; só relatório da divergência', () => {
    const r = cls(sab('F1', '2026-06-06', '08:36', '12:03', '12:03', '12:10'), {}, [], [], [{ funcId: 'F1', mes: '2026-06', assinado: true }]);
    expect(item(r, '2026-06-06')).toMatchObject({ classe: 'ASSINADO', divergencia: { status: 'ok', trabalhadoMin: 214, saldoMin: 4 } });
    expect(r.itens.filter(x => x.classe === 'ELEGIVEL')).toHaveLength(0);
  });
  test('sábados a partir do corte não entram (já usam a regra nova); dias já ok não aparecem', () => {
    const r = cls(sab('F1', '2026-10-17', '08:30', '12:00', '12:00', '12:00'));
    expect(r.itens).toHaveLength(0);
  });
  test('impacto antes × depois: pendências caem e horas aumentam só pelos dias corrigidos', () => {
    const regs = [...LIMPOS, ...sab('F1', '2026-06-06', '08:36', '12:03', '12:03', '12:10')];
    const imp = S.impacto({ ...F, inicioBancoHoras: '2026-05-02' }, regs, [], [], { '2026-06-06': true }, '2026-06-10');
    expect(imp.pendenciasAntes - imp.pendenciasDepois).toBeGreaterThanOrEqual(1);
    expect(imp.deltaHorasMin).toBe(214);
  });
});

describe('aplicação (emulador): idempotente, auditável, histórico intacto, motor passa a usar o conjunto', () => {
  const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'ponto_sabado_correcoes', 'banco_horas_config', 'banco_horas_lancamentos', 'banco_horas_saldo'];
  const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
  const hash = async c => crypto.createHash('sha1').update(JSON.stringify((await db.collection(c).orderBy('__name__').get()).docs.map(d => [d.id, d.data()]))).digest('hex');
  beforeEach(limpar); afterAll(limpar);
  test('aplicar 2×: 1ª cria, 2ª não cria nada; registros/justificativas/espelhos/funcionários idênticos', async () => {
    await db.doc('funcionarios/F1').set({ nome: 'X', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-05-02' });
    const regs = [...LIMPOS, ...sab('F1', '2026-06-06', '08:36', '12:03', '12:03', '12:10')];
    for (const r of regs) { const { id, ...d } = r; await db.collection('registros').doc(id).set(d); }
    await db.doc('espelhos/F1_2026-05').set({ funcId: 'F1', mes: '2026-05', assinado: true });
    const antes = await Promise.all(['registros', 'justificativas', 'creditos_jornada', 'espelhos', 'funcionarios'].map(hash));
    const r = S.classificar({ id: 'F1', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-05-02' }, regs, [], [], []);
    const el = r.itens.filter(x => x.classe === 'ELEGIVEL');
    expect(el).toHaveLength(1);
    expect(await S.aplicarCorrecoes(db, FieldValue, el)).toEqual({ criados: 1, existentes: 0 });
    expect(await S.aplicarCorrecoes(db, FieldValue, el)).toEqual({ criados: 0, existentes: 1 });
    const doc = (await db.doc('ponto_sabado_correcoes/F1_2026-06-06').get()).data();
    expect(doc).toMatchObject({ ativa: true, tipo: 'SABADO_INTERVALO_NULO', antes: { status: 'incompleto' }, depois: { status: 'ok', trabalhadoMin: 214 }, marcas: { sa: '12:03', ra: '12:03' } });
    expect(doc.autorizacao).toMatch(/Proprietário/);
    expect(await Promise.all(['registros', 'justificativas', 'creditos_jornada', 'espelhos', 'funcionarios'].map(hash))).toEqual(antes);
    // o motor do backend passa a usar o conjunto corrigido
    await db.doc('banco_horas_config/politica').set({ acumulativoAtivo: true, compensacaoAtiva: true });
    const x = await db.runTransaction(tx => B.carregarBanco(tx, db, 'F1', '2026-06-10'));
    const jun = x.meses.find(m => m.mes === '2026-06').dias.find(d => d.data === '2026-06-06');
    expect(jun).toMatchObject({ contaNoSaldo: true, saldoMin: 4, status: 'ok' });
    // reverter (ativa:false) devolve o dia ao estado anterior
    await db.doc('ponto_sabado_correcoes/F1_2026-06-06').update({ ativa: false });
    const y = await db.runTransaction(tx => B.carregarBanco(tx, db, 'F1', '2026-06-10'));
    expect(y.meses.find(m => m.mes === '2026-06').dias.find(d => d.data === '2026-06-06')).toMatchObject({ contaNoSaldo: false, status: 'incompleto' });
  });
});

describe('estáticos', () => {
  const root = path.resolve(__dirname, '../..');
  test('script não escreve em marcações/justificativas/espelhos/cadastro; telas decoram sem enumerar; regras sem escrita de cliente', () => {
    const sc = fs.readFileSync(path.join(root, 'functions/scripts/ponto_sabados_corrigir.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//, '');
    expect(sc).not.toMatch(/collection\('(registros|justificativas|creditos_jornada|espelhos|funcionarios)'\)\.doc\([^)]*\)\.(set|update|delete)/);
    const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8'), f = fs.readFileSync(path.join(root, 'modulos/ponto-func.html'), 'utf8');
    expect(g).toMatch(/Object\.defineProperty\(f,'sabadosCorrigidos',\{value:m\[f\.id\]\|\|\{\},enumerable:false/); expect(g).toMatch(/window\._sabCorr = getDocs\(collection\(db, 'ponto_sabado_correcoes'\)\)/);
    expect(f).toMatch(/Object\.defineProperty\(window\._funcAtivo, 'sabadosCorrigidos', \{value: m, enumerable: false/);
    expect(fs.readFileSync(path.join(root, 'modulos/firestore.rules'), 'utf8')).toMatch(/match \/ponto_sabado_correcoes\/\{cid\}[\s\S]{0,400}allow write: if false;/);
    expect(fs.readFileSync(path.join(root, 'functions/lib/ponto-regras.copy.js'), 'utf8')).toBe(fs.readFileSync(path.join(root, 'modulos/ponto-regras.js'), 'utf8'));
  });
});
