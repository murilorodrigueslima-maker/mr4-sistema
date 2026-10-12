'use strict';
// Fase 5 — ativação controlada: visualização gerencial provisória LIGADA; compensação/folga reais DESLIGADAS (sem acordo coletivo). Sintético.
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080'; process.env.GCLOUD_PROJECT = 'mr4-ponto';
const fs = require('fs'), path = require('path'), cp = require('child_process');
const admin = require('firebase-admin'); if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const B = require('../lib/pontoBanco'); const M = B.M;
jest.setTimeout(120000);
const root = path.resolve(__dirname, '../..');
const AGORA = new Date('2026-10-12T15:00:00Z');
const pol = args => JSON.parse(cp.spawnSync('node', [path.join(root, 'functions/scripts/banco_politica.js'), ...args], { encoding: 'utf8' }).stdout.trim().split('\n')[0]);

describe('política de ativação (script)', () => {
  test('visualização gerencial: aceita cctPreview + normaId; recusa misturar com ativação real; ativação real exige base jurídica', () => {
    expect(pol(['--cctPreview=true', '--normaId=cct-ce000233-2026-v1'])).toMatchObject({ ok: true, modo: 'DRY-RUN', politica: { cctPreview: true, normaId: 'cct-ce000233-2026-v1' } });
    expect(pol(['--cctPreview=true', '--compensacaoAtiva=true', '--baseJuridica=x'])).toMatchObject({ ok: false });
    expect(pol(['--compensacaoAtiva=true', '--acumulativoAtivo=true'])).toMatchObject({ ok: false });
    expect(pol(['--permiteSaldoNegativo=true'])).toMatchObject({ ok: false });
  });
});

describe('com a política de PRÉVIA nenhuma operação real funciona (emulador)', () => {
  const COLS = ['funcionarios', 'registros', 'justificativas', 'creditos_jornada', 'espelhos', 'banco_horas_lancamentos', 'banco_horas_saldo', 'banco_horas_config', 'banco_horas_normas', 'users', 'sistema_usuarios'];
  const limpar = async () => { for (const c of COLS) { const s = await db.collection(c).get(); await Promise.all(s.docs.map(d => d.ref.delete())); } };
  const req = d => ({ auth: { uid: 'adm' }, data: d });
  const erro = p => p.then(() => 'OK', e => (e.code || '') + ':' + (e.message || ''));
  let seq = 0; const reg = (f, data, tipo, hora) => db.collection('registros').doc('r' + (++seq)).set({ funcId: f, data, tipo, hora: hora + ':00' });
  beforeEach(async () => {
    await limpar();
    await db.doc('users/adm').set({ role: 'gestor', ativo: true }); await db.doc('sistema_usuarios/adm').set({ modulos: ['ponto'], admin: true, email: 'a@x' });
    await db.doc('funcionarios/FA').set({ nome: 'FA', jornada: 8, controleBancoHoras: true, inicioBancoHoras: '2026-08-03' });
    await db.doc('banco_horas_config/politica').set({ cctPreview: true, normaId: 'cct-ce000233-2026-v1' });
    await db.doc('banco_horas_normas/cct-ce000233-2026-v1').set({ id: 'cct-ce000233-2026-v1', ativa: false });
    await reg('FA', '2026-09-22', 'entrada', '08:00');
  });
  afterAll(limpar);
  test('compensar, folga, exceção e estorno: todos recusados (BANCO_DESLIGADO); nada gravado', async () => {
    const o = { db, now: () => AGORA };
    expect(await erro(B.compensarHandler(req({ funcId: 'FA', dataAusencia: '2026-09-22', minutos: 480, motivo: 'Teste de ativação' }), o))).toMatch(/BANCO_DESLIGADO/);
    expect(await erro(B.folgaHandler(req({ funcId: 'FA', data: '2026-10-14', periodo: 'DIA_INTEIRO', motivo: 'Teste de ativação' }), o))).toMatch(/BANCO_DESLIGADO/);
    expect(await erro(B.excecaoHandler(req({ funcId: 'FA', data: '2026-10-20', minutos: 60, motivo: 'Teste de ativação aqui' }), o))).toMatch(/BANCO_DESLIGADO|SEM_NORMA/);
    expect(await erro(B.estornarHandler(req({ lancamentoId: 'FA_2026-09-22', motivo: 'Teste de ativação' }), { db }))).toMatch(/not-found/);
    expect((await db.collection('banco_horas_lancamentos').get()).size).toBe(0);
    expect((await db.collection('banco_horas_saldo').get()).size).toBe(0);
  });
});

describe('saldo atravessa os meses; negativo é apenas exibido', () => {
  const dia = (data, saldoMin) => ({ data, saldoMin, contaNoSaldo: true, status: 'ok' });
  test('mês positivo → negativo → positivo: saldo anterior de cada mês = saldo final do anterior; sem zerar', () => {
    const r = M.calcBancoAcumulado([{ mes: '2026-08', dias: [dia('2026-08-03', 300)] }, { mes: '2026-09', dias: [dia('2026-09-01', -900)] }, { mes: '2026-10', dias: [dia('2026-10-01', 120)] }], []);
    expect(r.map(x => x.saldoAnterior)).toEqual([0, 300, -600]);
    expect(r.map(x => x.saldoFinal)).toEqual([300, -600, -480]);
  });
  test('norma sem acordo: ciclo indefinido e status explícito; nenhum ciclo é inventado', () => {
    const NORMA = { id: 'n', origem: { registro: 'CE000233/2026', clausula: '28ª' }, vigencia: { inicio: '2026-01-01', fim: '2027-12-31' }, bancoValidoAte: '2026-12-31', apuracaoDias: 120, compensacaoDias: 30, fatorFolgaPorHoraExtra: 1.5,
      limiteNegativoMesMin: 240, limiteExtraDiarioMin: 120, adicionalHoraExtra: 0.55, exigeAcordoColetivo: true, saldoNegativoFimCiclo: 'ZERAR', rescisaoSaldoNegativo: 'ZERAR_SEM_COBRANCA', rescisaoSaldoPositivo: 'PAGAR_HORA_EXTRA' };
    const r = M.analisarBancoCct(NORMA, { hoje: '2026-10-12', acordo: null, dias: [], compensacoes: [], excecoes: [] });
    expect(r.status).toBe('SEM_ACORDO_COLETIVO'); expect(r.ciclo).toBeNull(); expect(r.ciclos).toEqual([]);
  });
});

describe('interface e permissões (estático)', () => {
  const g = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8'), f = fs.readFileSync(path.join(root, 'modulos/ponto-func.html'), 'utf8');
  test('banner de saldos provisórios, sem desconto em folha; funcionário só vê com acumulativoAtivo (desligado)', () => {
    expect(g).toMatch(/SALDOS PROVISÓRIOS — visualização gerencial/);
    expect(g).toMatch(/nenhum desconto em folha ou rescisão/);
    expect(g).toMatch(/if\(!cfg\.acumulativoAtivo&&!cfg\.cctPreview\)/);
    expect(f).toMatch(/if\(!cfg\.acumulativoAtivo\)return/);
  });
  test('todas as operações sensíveis exigem login e autorização no código (autorizar) e leem a política antes de gravar', () => {
    const lib = fs.readFileSync(path.join(root, 'functions/lib/pontoBanco.js'), 'utf8');
    for (const h of ['compensarHandler', 'estornarHandler', 'excecaoHandler', 'folgaHandler']) {
      const i = lib.indexOf('async function ' + h); const corpo = lib.slice(i, i + 2600);
      expect(corpo).toMatch(/unauthenticated/); expect(corpo).toMatch(/autorizar\(store, uid/);
    }
    expect((lib.match(/BANCO_DESLIGADO/g) || []).length).toBeGreaterThanOrEqual(2);
  });
});
