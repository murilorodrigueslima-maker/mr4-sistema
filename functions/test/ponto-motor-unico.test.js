'use strict';
// PONTO MR4 2.0 — Motor único (engine 4.0.0). Fixtures fictícias.
// Cada fixture é executada UMA VEZ pelo motor (calcMes) e as duas visualizações (Banco, Espelho) + pendências +
// bloqueio de assinatura são verificadas contra esse MESMO resultado: BANK_VS_MIRROR_DIVERGENCES=0.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8'), ctx);
const { calcDia, calcMes, calcBancoMes, buildEspelhoSnapshot, renderEspelhoRowsHTML, podeAssinarEspelho,
  canonicalizarSnapshot, snapshotsEquivalentes, fmtMin } = ctx;

const F = { id: 'fx', nome: 'Fixture', cargo: 'Teste', jornada: 8 };
const T = '2026-09-15', SAB = '2026-09-12', DOM = '2026-09-13', MES = '2026-09';
let seq = 0;
const reg = (data, tipo, hora, x = {}) => ({ id: 'r' + String(++seq).padStart(4, '0'), funcId: 'fx', data, tipo, hora: hora + ':00', ...x });
const dia = (d, e, sa, ra, s, x) => [e && reg(d, 'entrada', e, x), sa && reg(d, 'saida_almoco', sa, x), ra && reg(d, 'retorno_almoco', ra, x), s && reg(d, 'saida', s, x)].filter(Boolean);
const cred = (data, motivo, minutos) => ({ id: 'cred_fx_' + data, funcId: 'fx', data, motivo, minutos });
const just = (data, motivo, x = {}) => ({ id: 'j' + (++seq), funcId: 'fx', data, motivo, status: 'aprovado', ...x });

/** Executa o motor UMA vez e deriva as duas visualizações; afirma a paridade e devolve tudo. */
function rodar({ data, regs = [], creditos = [], justificativas = [], func = F, mes = MES, hoje }) {
  hoje = hoje || data;
  const m = calcMes(func, regs, creditos, justificativas, mes, hoje);              // ← motor, 1 execução
  const banco = calcBancoMes(func, regs, creditos, mes, hoje, justificativas);   // visualização Banco
  const esp = buildEspelhoSnapshot(func, regs, creditos, justificativas, mes, hoje); // visualização Espelho
  // PARIDADE: Banco e Espelho = motor (mesmos totais, mesmas pendências, mesmo resultado por dia)
  expect([banco.trabMin, banco.esperMin, banco.saldo, banco.diasTrab]).toEqual([m.totais.trabMin, m.totais.esperMin, m.totais.saldo, m.totais.diasTrab]);
  expect([esp.totais.trabMin, esp.totais.esperMin, esp.totais.saldo, esp.totais.diasTrab]).toEqual([m.totais.trabMin, m.totais.esperMin, m.totais.saldo, m.totais.diasTrab]);
  expect(banco.pendencias).toEqual(m.pendencias);
  expect(esp.totais.pendencias).toBe(m.pendencias.length);
  m.dias.forEach((d, i) => {
    const e = esp.dias[i];
    expect([e.data, e.status, e.pendente, e.jornadaDia, e.trabalhadoMin, e.abonadoMin, e.saldoDia])
      .toEqual([d.data, d.status, d.pendente, d.jornadaPrevistaMin, d.trabalhadoMin, d.abonadoMin, d.contaNoSaldo ? d.saldoMin : null]);
  });
  const d = m.dias.find(x => x.data === data);
  const linha = renderEspelhoRowsHTML({ ...esp, dias: esp.dias.filter(x => x.data === data) }).replace(/<[^>]+>/g, '|').replace(/\|+/g, '|');
  const assinatura = podeAssinarEspelho(banco.pendencias, justificativas, mes);
  return { m, d, banco, esp, linha, assinatura };
}
const saldoDoDia = r => r.d.saldoMin;

describe('Regras de jornada (comportamento preservado)', () => {
  test('DIA_NORMAL', () => { const r = rodar({ data: T, regs: dia(T, '08:00', '12:00', '13:00', '17:00') }); expect(r.d).toMatchObject({ trabalhadoMin: 480, saldoMin: 0, status: 'ok', pendente: false }); });
  test('ATRASO', () => { const r = rodar({ data: T, regs: dia(T, '08:30', '12:00', '13:00', '17:00') }); expect(r.d).toMatchObject({ trabalhadoMin: 450, saldoMin: -30 }); });
  test('HORA_EXTRA', () => { const r = rodar({ data: T, regs: dia(T, '08:00', '12:00', '13:00', '18:00') }); expect(r.d).toMatchObject({ trabalhadoMin: 540, saldoMin: 60 }); });
  test('ALMOCO_NORMAL', () => { const r = rodar({ data: T, regs: dia(T, '08:00', '12:00', '13:00', '17:00') }); expect(r.d.saldoMin).toBe(0); });
  test('ALMOCO_MENOR (30 min) — PRESERVE_CURRENT_BEHAVIOR (LUNCH_MINIMUM_RULE=NEEDS_FUTURE_BUSINESS_DECISION)', () => {
    const r = rodar({ data: T, regs: dia(T, '08:00', '12:00', '12:30', '17:00') }); expect(r.d).toMatchObject({ trabalhadoMin: 510, saldoMin: 30 });
  });
  test('ALMOCO_MAIOR (2h)', () => { const r = rodar({ data: T, regs: dia(T, '08:00', '12:00', '14:00', '17:00') }); expect(r.d).toMatchObject({ trabalhadoMin: 420, saldoMin: -60 }); });
  test('BATIDA_INCOMPLETA → PENDENTE, fora do saldo, bloqueia assinatura', () => {
    const r = rodar({ data: T, regs: dia(T, '08:00', '12:00', '13:00', null) });
    expect(r.d).toMatchObject({ status: 'incompleto', pendente: true, contaNoSaldo: false, pendencias: [{ tipo: 'PONTO_INCOMPLETO' }] });
    expect(r.assinatura.pode).toBe(false);
  });
  test('FALTA → −jornada no Banco e no Espelho', () => { const r = rodar({ data: T }); expect(r.d).toMatchObject({ status: 'falta', saldoMin: -480 }); expect(r.linha).toContain('Falta|-8h00'); });
  test('FALTA_JUSTIFICADA (com crédito) → saldo 0', () => {
    const r = rodar({ data: T, creditos: [cred(T, 'Consulta médica', 480)], justificativas: [just(T, 'Consulta médica')] });
    expect(r.d).toMatchObject({ status: 'credito', abonadoMin: 480, saldoMin: 0, pendente: false });
  });
  test('HOME_OFFICE (com ponto, sem crédito) → igual ao presencial, sem inconsistência', () => {
    const r = rodar({ data: T, regs: dia(T, '08:00', '12:00', '13:00', '17:00', { modalidade: 'HOME_OFFICE' }), justificativas: [just(T, 'Home Office')] });
    expect(r.d).toMatchObject({ trabalhadoMin: 480, saldoMin: 0, pendente: false, ocorrencia: 'Home Office' });
  });
  test('SABADO (3h30) e férias (saldo 0) preservados', () => {
    expect(rodar({ data: SAB, regs: dia(SAB, '08:30', null, null, '12:00') }).d.saldoMin).toBe(0);
    expect(rodar({ data: T, regs: dia(T, '08:00', '12:00', '13:00', '19:00'), creditos: [cred(T, 'Férias', 480)] }).d.saldoMin).toBe(0);
  });
});

describe('R1 — Feriado', () => {
  const fer = [cred(T, 'Feriado nacional', 480)], jf = [just(T, 'Feriado nacional', { lancadoPorGestor: true })];
  test('FERIADO_NAO_TRABALHADO → saldo 0', () => { expect(rodar({ data: T, creditos: fer, justificativas: jf }).d).toMatchObject({ saldoMin: 0, abonadoMin: 480, status: 'credito' }); });
  test('FERIADO_TRABALHADO_4H → +4h (não vira dia comum)', () => {
    const r = rodar({ data: T, regs: dia(T, '08:00', null, null, '12:00'), creditos: fer, justificativas: jf });
    expect(r.d).toMatchObject({ trabalhadoMin: 240, saldoMin: 240 });
    expect(r.linha).toContain('4h00 + 8h00 abono|+4h00');
  });
  test('FERIADO_TRABALHADO_8H → +8h', () => { expect(saldoDoDia(rodar({ data: T, regs: dia(T, '08:00', '12:00', '13:00', '17:00'), creditos: fer, justificativas: jf }))).toBe(480); });
  test('FERIADO_INCOMPLETO → PENDENTE (não fecha o dia) e bloqueia assinatura', () => {
    const r = rodar({ data: T, regs: dia(T, '08:00', null, null, null), creditos: fer, justificativas: jf });
    expect(r.d).toMatchObject({ status: 'incompleto', pendente: true, contaNoSaldo: false });
    expect(r.assinatura.pode).toBe(false);
  });
  test('feriado em domingo trabalhado → só as horas trabalhadas (crédito não soma em cima)', () => {
    expect(saldoDoDia(rodar({ data: DOM, regs: dia(DOM, '08:00', null, null, '12:00'), creditos: [cred(DOM, 'Feriado nacional', 480)] }))).toBe(240);
  });
});

describe('R2 — Atestado', () => {
  const at = m => [cred(T, 'Atestado médico', m)], ja = [just(T, 'Atestado médico')];
  test('ATESTADO_INTEGRAL → saldo 0', () => { expect(rodar({ data: T, creditos: at(480), justificativas: ja }).d).toMatchObject({ abonadoMin: 480, saldoMin: 0 }); });
  test('ATESTADO_PARCIAL: trabalhou 4h → TRABALHADO=4h ABONADO=4h SALDO=0', () => {
    const r = rodar({ data: T, regs: dia(T, '08:00', null, null, '12:00'), creditos: at(480), justificativas: ja });
    expect(r.d).toMatchObject({ trabalhadoMin: 240, abonadoMin: 240, saldoMin: 0 });
  });
  test('atestado respeita os minutos do crédito (2h de atestado + 4h trabalhadas → −2h)', () => {
    expect(rodar({ data: T, regs: dia(T, '08:00', null, null, '12:00'), creditos: at(120), justificativas: ja }).d).toMatchObject({ abonadoMin: 120, saldoMin: -120 });
  });
  test('abono nunca passa do necessário (9h trabalhadas + atestado → +1h, abono 0)', () => {
    expect(rodar({ data: T, regs: dia(T, '08:00', '12:00', '13:00', '18:00'), creditos: at(480), justificativas: ja }).d).toMatchObject({ abonadoMin: 0, saldoMin: 60 });
  });
});

describe('R3 — Justificativa aprovada sem crédito = DATA_INCONSISTENCY', () => {
  test('JUSTIFICATIVA_SEM_CREDITO → pendência administrativa; não abona e não desconta', () => {
    const r = rodar({ data: T, justificativas: [just(T, 'Consulta médica')] });
    expect(r.d).toMatchObject({ status: 'inconsistente', pendente: true, contaNoSaldo: false, pendencias: [{ tipo: 'DATA_INCONSISTENCY', motivo: 'JUSTIFICATIVA_SEM_CREDITO' }] });
    expect(r.m.totais.saldo - rodar({ data: T, hoje: '2026-09-14' }).m.totais.saldo).toBe(0);   // nenhum débito silencioso
    expect(r.assinatura).toMatchObject({ pode: false });
    expect(r.assinatura.motivo).toMatch(/inconsist/i);
    expect(r.linha).toContain('Inconsistência');
  });
  test('motivos sem crédito (Home Office, Falta injustificada…) não são inconsistência', () => {
    expect(rodar({ data: T, justificativas: [just(T, 'Falta injustificada', { lancadoPorGestor: true })] }).d).toMatchObject({ status: 'falta', pendente: false });
  });
  test('crédito sem minutos não abona por conta própria → DATA_INCONSISTENCY', () => {
    expect(rodar({ data: T, creditos: [{ data: T, motivo: 'Atestado médico' }] }).d.pendencias[0]).toEqual({ tipo: 'DATA_INCONSISTENCY', motivo: 'CREDITO_SEM_MINUTOS' });
  });
});

describe('R4 — Correção', () => {
  test('CORRECAO (Fase 0): original substituído fica gravado mas não conta; vale a correção', () => {
    const regs = [reg(T, 'entrada', '09:00', { substituidoPor: 'corr_j1' }), reg(T, 'entrada', '08:00', { lancadoPorJustificativa: true }), ...dia(T, null, '12:00', '13:00', '17:00')];
    const r = rodar({ data: T, regs });
    expect(r.d).toMatchObject({ entrada: '08:00', saldoMin: 0 });
    expect(regs).toHaveLength(5);
  });
  const ts = iso => ({ seconds: Date.parse(iso) / 1000, nanoseconds: 0 });
  const dupla = (ordem, a, b) => {
    const c1 = reg(T, 'entrada', '08:10', { lancadoPorJustificativa: true, ...a });
    const c2 = reg(T, 'entrada', '08:40', { lancadoPorJustificativa: true, ...b });
    return [...(ordem ? [c1, c2] : [c2, c1]), ...dia(T, null, '12:00', '13:00', '17:00')];
  };
  test('CORRECAO_DUPLA_LEGADA → vale a MAIS RECENTE, independente da ordem retornada', () => {
    const a = { criadoEm: '2026-09-15T12:00:00Z' }, b = { criadoEm: '2026-09-16T09:00:00Z' };
    for (const ordem of [true, false]) expect(rodar({ data: T, regs: dupla(ordem, a, b) }).d).toMatchObject({ entrada: '08:40', saldoMin: -40 });
    // aprovadoEm (Timestamp) tem prioridade sobre criadoEm
    const r = rodar({ data: T, regs: dupla(true, { aprovadoEm: ts('2026-09-17T10:00:00Z'), criadoEm: '2026-09-15T12:00:00Z' }, { criadoEm: '2026-09-16T09:00:00Z' }) });
    expect(r.d.entrada).toBe('08:10');
  });
  test('correção dupla sem timestamp ou com empate → DATA_INCONSISTENCY (não escolhe)', () => {
    expect(rodar({ data: T, regs: dupla(true, {}, { criadoEm: '2026-09-16T09:00:00Z' }) }).d.pendencias[0]).toEqual({ tipo: 'DATA_INCONSISTENCY', motivo: 'CORRECAO_DUPLA_SEM_TIMESTAMP' });
    const mesmo = { criadoEm: '2026-09-16T09:00:00Z' };
    const r = rodar({ data: T, regs: dupla(true, mesmo, mesmo) });
    expect(r.d).toMatchObject({ status: 'inconsistente', pendente: true, pendencias: [{ tipo: 'DATA_INCONSISTENCY', motivo: 'CORRECAO_DUPLA_EMPATE' }] });
    expect(r.assinatura.pode).toBe(false);
  });
});

describe('R5 — Dia incompleto + justificativa', () => {
  test('JUSTIFICATIVA_COM_DIA_INCOMPLETO: correção de batida não completa outras batidas → PENDENTE', () => {
    const r = rodar({ data: T, regs: [reg(T, 'entrada', '08:00', { lancadoPorJustificativa: true }), ...dia(T, null, '12:00', '13:00', null)],
      justificativas: [just(T, 'Ponto não batido', { tipoPonto: 'entrada', horarioPonto: '08:00' })] });
    expect(r.d).toMatchObject({ status: 'incompleto', pendente: true, contaNoSaldo: false });
    expect(r.assinatura.pode).toBe(false);
  });
  test('correção que completa o dia → ok', () => {
    const r = rodar({ data: T, regs: [...dia(T, '08:00', '12:00', '13:00', null), reg(T, 'saida', '17:00', { lancadoPorJustificativa: true })],
      justificativas: [just(T, 'Ponto não batido', { tipoPonto: 'saida', horarioPonto: '17:00' })] });
    expect(r.d).toMatchObject({ status: 'ok', saldoMin: 0 });
  });
  test('ausência aprovada com crédito cobre o dia sem batidas', () => {
    expect(rodar({ data: T, creditos: [cred(T, 'Licença', 480)], justificativas: [just(T, 'Licença')] }).d).toMatchObject({ status: 'credito', saldoMin: 0 });
  });
});

describe('R6 — Domingo', () => {
  test('DOMINGO_NAO_TRABALHADO → nada a contar', () => { expect(rodar({ data: DOM }).d).toMatchObject({ status: 'domingo', contaNoSaldo: false, pendente: false }); });
  test('DOMINGO_TRABALHADO 08:00→12:00 → TRABALHADO=4h SALDO=+4h; Espelho mostra 4h00 / +4h00', () => {
    const r = rodar({ data: DOM, regs: dia(DOM, '08:00', null, null, '12:00') });
    expect(r.d).toMatchObject({ jornadaPrevistaMin: 0, trabalhadoMin: 240, saldoMin: 240, contaNoSaldo: true });
    expect(r.linha).toContain('|4h00|+4h00|');
    expect(r.esp.totais.saldo - rodar({ data: DOM, hoje: '2026-09-12' }).esp.totais.saldo).toBe(240);   // entra no total do Espelho
  });
  test('DOMINGO_INCOMPLETO → PENDENTE e bloqueia assinatura (mesma regra dos outros dias)', () => {
    const r = rodar({ data: DOM, regs: dia(DOM, '08:00', null, null, null) });
    expect(r.d).toMatchObject({ status: 'incompleto', pendente: true });
    expect(r.linha).toContain('Incompleto');
    expect(r.assinatura.pode).toBe(false);
  });
});

describe('R7 — Período aplicável', () => {
  test('FORA_PERIODO (antes do início): sem falta, sem débito, sem pendência; batida visível', () => {
    const func = { ...F, inicioBancoHoras: '2026-09-10' };
    const r = rodar({ data: T, func, regs: [...dia('2026-09-03', '08:00', null, null, null), ...dia(T, '08:00', '12:00', '13:00', '17:00')] });
    const antes = r.m.dias.filter(x => x.data < '2026-09-10');
    expect(antes.every(x => x.status === 'fora_periodo' && !x.contaNoSaldo && !x.pendente)).toBe(true);
    expect(r.m.pendencias).toEqual([]);                               // batida incompleta pré-período não bloqueia
    expect(r.esp.dias.find(x => x.data === '2026-09-03').entrada).toBe('08:00');
    expect(r.m.totais.esperMin).toBe(4 * 480 + 210);                 // 10,11,14,15 (seg–sex) + sáb 12
  });
  test('afastamento e controleBancoHoras=false seguem a mesma regra', () => {
    const af = rodar({ data: T, func: { ...F, afastamentoBanco: { tipo: 'licenca', inicio: '2026-09-01', fim: '2026-09-14' } } });
    expect(af.m.dias.filter(x => x.status === 'falta').map(x => x.data)).toEqual([T]);
    const fora = rodar({ data: T, func: { ...F, controleBancoHoras: false }, regs: dia(T, '08:00', '12:00', '13:00', '18:00') });
    expect(fora.m.totais).toMatchObject({ trabMin: 0, esperMin: 0, saldo: 0 });
    expect(fora.esp.dias.find(x => x.data === T)).toMatchObject({ status: 'fora_periodo', trabalhadoMin: 540, saldoDia: null });
  });
});

describe('SIGNED_SNAPSHOT e documentos congelados', () => {
  test('snapshot 4.x registra período, pendências e abono; hash muda se qualquer número mudar', () => {
    const regs = dia(T, '08:00', null, null, '12:00');
    const s1 = buildEspelhoSnapshot({ ...F, inicioBancoHoras: '2026-09-01' }, regs, [cred(T, 'Atestado médico', 480)], [], MES, T);
    expect(s1.engineVersao).toBe('4.0.0');
    expect(s1.funcionario.inicioBancoHoras).toBe('2026-09-01');
    const c1 = canonicalizarSnapshot({ ...s1, geradoEm: 'x' });
    const s2 = JSON.parse(JSON.stringify(s1)); s2.dias[s2.dias.length - 1].abonadoMin = 0;
    expect(canonicalizarSnapshot({ ...s2, geradoEm: 'x' })).not.toBe(c1);
  });
  test('snapshotsEquivalentes: mesmo cálculo com geradoEm diferente → equivalente; dado novo → não', () => {
    const regs = dia(T, '08:00', '12:00', '13:00', '17:00');
    const a = { ...buildEspelhoSnapshot(F, regs, [], [], MES, T), geradoEm: '2026-09-20T10:00:00Z' };
    const b = { ...buildEspelhoSnapshot(F, regs, [], [], MES, T), geradoEm: '2026-09-21T10:00:00Z' };
    expect(snapshotsEquivalentes(a, b)).toBe(true);
    const c = buildEspelhoSnapshot(F, [...regs.slice(0, 3), reg(T, 'saida', '18:00')], [], [], MES, T);
    expect(snapshotsEquivalentes(a, c)).toBe(false);
    expect(snapshotsEquivalentes({ ...a, engineVersao: '3.0.0' }, b)).toBe(false);   // versão antiga nunca "equivale"
  });
  test('documento 3.x congelado: hash e aparência IDÊNTICOS aos do engine 3.0.0 (golden de 4b2d8c8)', () => {
    const g = require('./fixtures/ponto-snapshot-v3-golden.json');
    expect(g.snapshot.engineVersao).toBe('3.0.0');
    expect(canonicalizarSnapshot(g.snapshot)).toBe(g.canonicalV3);
    expect(renderEspelhoRowsHTML(g.snapshot)).toBe(g.renderV3);
    // no 3.x o domingo trabalhado aparece com total "—": o documento antigo continua mostrando o que mostrava
    expect(g.renderV3.replace(/<[^>]+>/g, '|')).toMatch(/13\|* Dom\|+08:00\|+—\|+—\|+12:00\|+—/);
  });
});

describe('Motor único — estrutura', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8');
  const corpo = nome => { const i = src.indexOf('function ' + nome + '('); return src.slice(i, src.indexOf('\n}\n', i)); };
  test('Banco e Espelho são adaptadores: chamam calcMes e não aplicam regra de crédito/domingo/período', () => {
    for (const nome of ['calcBancoMes', 'buildEspelhoSnapshot']) {
      const c = corpo(nome);
      expect(c).toMatch(/calcMes\(/);
      expect(c).not.toMatch(/getTipoCredito|calcTotal|inicioBancoHoras\s*&&|diaSemana\s*===\s*0|lancadoPorJustificativa/);
    }
  });
});

describe('Telas consomem o motor único (inspeção estática)', () => {
  const G = fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto.html'), 'utf8');
  const FN = fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-func.html'), 'utf8');
  test('as duas telas carregam o motor 4.0.0 (sem mistura com motor antigo em cache)', () => {
    for (const src of [G, FN]) expect(src).toContain('<script src="ponto-regras.js?v=4.0.0"></script>');
  });
  test('toda chamada ao Banco passa as justificativas (mesmas entradas do Espelho)', () => {
    for (const src of [G, FN]) {
      const chamadas = src.match(/calcBancoMes\(.*?\);/g) || [];
      expect(chamadas.length).toBeGreaterThan(0);
      // argumentos de nível 1 (hoje() conta como um só)
      chamadas.forEach(c => { const args = c.slice(c.indexOf('(') + 1, c.lastIndexOf(')')).replace(/\([^()]*\)/g, ''); expect(args.split(',').length).toBe(6); });
    }
  });
  test('aba Registros usa calcDia (não recalcula saldo por conta própria)', () => {
    const r = G.slice(G.indexOf('async function renderRegistros'), G.indexOf('window.renderRegistros'));
    expect(r).toMatch(/calcDia\(/);
    expect(r).not.toMatch(/calcTotal\(|jornadaParaData\(/);
  });
  test('gestor: espelho assinado exibe o snapshot congelado; legado sem snapshot exibe aviso', () => {
    const g = G.slice(G.indexOf('async function gerarEspelho'), G.indexOf('window.gerarEspelho'));
    expect(g).toMatch(/const congelado=espExist\?\.assinado&&espExist\.snapshot/);
    expect(g).toMatch(/renderEspelhoRowsHTML\(snapExib\)/);
    expect(g).toMatch(/LEGACY_SIGNED_NO_SNAPSHOT/);
  });
  test('funcionário: assinatura bloqueia espelho desatualizado e envia hashAssinado', () => {
    const a = FN.slice(FN.indexOf('async function abrirAssinar'), FN.indexOf('window.abrirAssinar'));
    expect(a).toMatch(/snapshotsEquivalentes\(exist\.snapshot,atual\)/);
    expect(a).toMatch(/hashEspelhoAberto=exist\.hashSnapshot/);
    expect(FN).toMatch(/hashAssinado: hashEspelhoAberto/);
  });
});
