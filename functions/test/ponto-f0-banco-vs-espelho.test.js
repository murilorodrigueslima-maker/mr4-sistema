'use strict';
// PONTO MR4 2.0 — Fase 0 · Banco × Espelho. NÃO CORRIGE NADA: roda calcBancoMes e buildEspelhoSnapshot
// sobre as MESMAS fixtures e documenta cada divergência (CASE / INPUT / BANK_RESULT / MIRROR_RESULT / ...).
// Técnica: todos os outros dias úteis do mês até o dia do caso têm jornada exata (saldo 0) → a diferença de
// totais vem só do dia do caso. hojeStr = dia do caso (dias seguintes não contam em nenhum dos dois motores).
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = {}; vm.createContext(ctx);
vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8'), ctx);
const { calcBancoMes, buildEspelhoSnapshot } = ctx;

const FUNC = { id: 'fx-func', nome: 'Fixture', cargo: 'Teste', jornada: 8 };
const B = 'calcBancoMes (ponto-regras.js)', M = 'buildEspelhoSnapshot (ponto-regras.js)';
let seq = 0;
const reg = (data, tipo, hora, extra = {}) => ({ id: 'r' + (++seq), funcId: FUNC.id, data, tipo, hora: hora + ':00', ...extra });
const dia = (data, e, sa, ra, s, extra) => [e && reg(data, 'entrada', e, extra), sa && reg(data, 'saida_almoco', sa, extra),
  ra && reg(data, 'retorno_almoco', ra, extra), s && reg(data, 'saida', s, extra)].filter(Boolean);

/** Preenche o mês até (excluindo) `ate` com dias exatos: seg–sex 8h, sábado 08:30–12:00, domingo vazio. */
function base(mes, ate) {
  const [a, m] = mes.split('-').map(Number), out = [];
  for (let d = 1; ; d++) {
    const ds = `${mes}-${String(d).padStart(2, '0')}`; if (ds >= ate) break;
    const w = new Date(a, m - 1, d).getDay();
    if (w === 6) out.push(...dia(ds, '08:30', null, null, '12:00'));
    else if (w !== 0) out.push(...dia(ds, '08:00', '12:00', '13:00', '17:00'));
  }
  return out;
}
function rodar({ data, regs = [], creditos = [], justificativas = [], func = FUNC, mes }) {
  mes = mes || data.slice(0, 7);
  const registros = [...base(mes, data), ...regs];
  const b = calcBancoMes(func, registros, creditos, mes, data);
  const e = buildEspelhoSnapshot(func, registros, creditos, justificativas, mes, data);
  const dE = e.dias.find(x => x.data === data) || {};
  return {
    bank: { saldo: b.saldo, trabMin: b.trabMin, esperMin: b.esperMin, pendencia: b.pendencias.some(p => p.data === data) },
    mirror: { saldo: e.totais.saldo, trabMin: e.totais.trabMin, esperMin: e.totais.esperMin, statusDia: dE.status, saldoDia: dE.saldoDia },
  };
}
const H = '2026-09-15';   // terça
const CASOS = [
  { caso: 'DIA_NORMAL', input: { data: H, regs: dia(H, '08:00', '12:00', '13:00', '17:00') } },
  { caso: 'ATRASO', input: { data: H, regs: dia(H, '08:30', '12:00', '13:00', '17:00') } },
  { caso: 'HORA_EXTRA', input: { data: H, regs: dia(H, '08:00', '12:00', '13:00', '18:00') } },
  { caso: 'ALMOCO_LONGO', input: { data: H, regs: dia(H, '08:00', '12:00', '14:00', '17:00') } },
  { caso: 'ALMOCO_INCOMPLETO', input: { data: H, regs: dia(H, '08:00', '12:00', null, '17:00') } },
  { caso: 'FERIADO_SEM_PONTO', input: { data: H, creditos: [{ data: H, motivo: 'Feriado nacional', minutos: 480 }] } },
  { caso: 'FERIADO_TRABALHADO', input: { data: H, regs: dia(H, '08:00', '12:00', '13:00', '17:00'), creditos: [{ data: H, motivo: 'Feriado nacional', minutos: 480 }] },
    regra: 'Banco soma horas reais + jornada abonada (DEC-8: saldo +jornada); espelho usa só as horas reais (crédito ignorado quando há ponto completo).',
    bankPath: 'calcBancoMes → tipo==="feriado" → trabMin += t + creditoD.minutos', mirrorPath: 'buildEspelhoSnapshot → totalMin=calcTotal(...) (crédito só entra se totalMin===null)',
    provavel: 'NEEDS_DECISION — DEC-8 documentado no motor favorece o banco; confirmar se feriado trabalhado deve gerar +jornada no documento assinado.' },
  { caso: 'HOME_OFFICE_COM_PONTO', input: { data: H, regs: dia(H, '08:00', '12:00', '13:00', '17:00', { modalidade: 'HOME_OFFICE' }), justificativas: [{ data: H, motivo: 'Home Office', status: 'aprovado' }] } },
  { caso: 'HOME_OFFICE_SEM_PONTO', input: { data: H, justificativas: [{ data: H, motivo: 'Home Office', status: 'aprovado' }] } },
  { caso: 'ATESTADO_DIA_INTEIRO', input: { data: H, creditos: [{ data: H, motivo: 'Atestado médico', minutos: 480 }], justificativas: [{ data: H, motivo: 'Atestado médico', status: 'aprovado' }] } },
  { caso: 'ATESTADO_PARCIAL_COM_PONTO', input: { data: H, regs: dia(H, '08:00', null, null, '12:00'), creditos: [{ data: H, motivo: 'Atestado médico', minutos: 240 }], justificativas: [{ data: H, motivo: 'Atestado médico', status: 'aprovado' }] },
    regra: 'Banco completa a jornada com abono (DEC-9: saldo 0); espelho conta só as 4h trabalhadas (saldo −4h).',
    bankPath: 'calcBancoMes → tipo==="abono" → abono=max(0,jornada−t); trabMin += t+abono', mirrorPath: 'buildEspelhoSnapshot → totalMin=calcTotal(...)=240; crédito ignorado',
    provavel: 'Banco (DEC-9 explícito no motor) — mas o documento assinado é o espelho: NEEDS_DECISION.' },
  { caso: 'FALTA', input: { data: H } },
  { caso: 'FALTA_JUSTIFICADA_SEM_CREDITO', input: { data: H, justificativas: [{ data: H, motivo: 'Consulta médica', status: 'aprovado' }] },
    regra: 'Justificativa aprovada sem crédito: espelho credita a jornada inteira; banco só lê creditos_jornada → falta (−jornada).',
    bankPath: 'calcBancoMes → sem diaRegs e sem creditoD → esperMin += jornada (falta)', mirrorPath: 'buildEspelhoSnapshot → justifCredita → totalMin = jornadaDia',
    provavel: 'NEEDS_DECISION — duas fontes de crédito (justificativas × creditos_jornada); decidir qual é a oficial.' },
  { caso: 'CORRECAO_ADITIVA_F0', input: { data: H, regs: [reg(H, 'entrada', '08:30', { substituidoPor: 'corr_x' }), reg(H, 'entrada', '08:00', { lancadoPorJustificativa: true }), ...dia(H, null, '12:00', '13:00', '17:00')] } },
  { caso: 'CORRECAO_DUPLA_LEGADO', input: { data: H, regs: [reg(H, 'entrada', '08:10', { lancadoPorJustificativa: true }), reg(H, 'entrada', '08:40', { lancadoPorJustificativa: true }), ...dia(H, null, '12:00', '13:00', '17:00')] },
    regra: 'Duas correções vigentes para o mesmo tipo (legado, sem substituidoPor): banco usa a ÚLTIMA da lista, espelho a PRIMEIRA.',
    bankPath: 'buildDiasFromRegistros → sobrescreve quando lancadoPorJustificativa (último vence)', mirrorPath: 'buildEspelhoSnapshot get() → regsD.find(lancadoPorJustificativa) (primeiro vence)',
    provavel: 'A correção mais recente (aprovadoEm). Na Fase 0 a nova correção marca a anterior com substituidoPor → não ocorre mais para dados novos; legado (1 caso real) NEEDS_DECISION.' },
  { caso: 'DIA_INCOMPLETO', input: { data: H, regs: dia(H, '08:00', null, null, null) } },
  { caso: 'DIA_INCOMPLETO_COM_JUSTIFICATIVA', input: { data: H, regs: dia(H, '08:00', null, null, null), justificativas: [{ data: H, motivo: 'Ponto não batido', status: 'aprovado' }] },
    regra: 'Espelho considera o dia "ok" com jornada creditada; banco marca PONTO_INCOMPLETO (dia fora do saldo).',
    bankPath: 'calcBancoMes → calcTotal=null → pendencias.push(PONTO_INCOMPLETO)', mirrorPath: 'buildEspelhoSnapshot → totalMin===null && justifCredita → totalMin=jornadaDia',
    provavel: 'Banco: a correção aprovada deveria virar batida (registro corretivo), não crédito implícito. NEEDS_DECISION.' },
  { caso: 'SABADO', input: { data: '2026-09-12', regs: dia('2026-09-12', '08:30', null, null, '12:00') } },
  { caso: 'SABADO_EXTRA', input: { data: '2026-09-12', regs: dia('2026-09-12', '08:00', null, null, '12:00') } },
  { caso: 'DOMINGO_TRABALHADO', input: { data: '2026-09-13', regs: dia('2026-09-13', '08:00', null, null, '12:00') },
    regra: 'Banco soma todo o trabalho de domingo como saldo positivo (DEC-7, jornada 0); espelho mostra as horas na linha mas exclui o domingo dos totais e deixa saldoDia=null.',
    bankPath: 'calcBancoMes → diaSemana===0 com ponto → jornadaDia=0; trabMin += t', mirrorPath: 'buildEspelhoSnapshot → if (!ehDomingo && !ehIncompleto) { esperMin/trabMin } (domingo nunca soma); saldoDia só se !ehDomingo',
    provavel: 'Banco (DEC-7 explícito: "todo trabalho = saldo positivo"). Divergência nova (não listada na auditoria). NEEDS_DECISION.' },
  { caso: 'VIRADA_DE_MES', input: { data: '2026-09-01', regs: [...dia('2026-08-31', '08:00', '12:00', '13:00', '19:00'), ...dia('2026-09-01', '08:00', '12:00', '13:00', '17:00')] } },
  { caso: 'SALDO_POSITIVO_MES', input: { data: H, regs: dia(H, '07:00', '12:00', '13:00', '19:00') } },
  { caso: 'SALDO_NEGATIVO_MES', input: { data: H, regs: dia(H, '10:00', '12:00', '13:00', '15:00') } },
  { caso: 'INICIO_BANCO_HORAS', input: { data: H, func: { ...FUNC, inicioBancoHoras: '2026-09-10' }, regs: dia(H, '08:00', '12:00', '13:00', '17:00'), mes: '2026-09' }, semBase: true,
    regra: 'Banco ignora dias antes de inicioBancoHoras; espelho conta esses dias como falta (também ignora afastamentoBanco e controleBancoHoras).',
    bankPath: 'calcBancoMes → if (inicioBanco && dataStr < inicioBanco) continue', mirrorPath: 'buildEspelhoSnapshot → não lê inicioBancoHoras/afastamentoBanco/controleBancoHoras',
    provavel: 'Banco (periodização é regra de contrato; espelho deveria mostrar "fora do período", não falta).' },
];

const saida = [];
describe('Banco × Espelho sobre fixtures idênticas (documentação, sem correção)', () => {
  for (const c of CASOS) {
    test(c.caso, () => {
      let r;
      if (c.semBase) {   // periodização: sem preenchimento, para expor a diferença de dias anteriores ao início
        const regs = c.input.regs;
        const b = calcBancoMes(c.input.func, regs, [], c.input.mes, c.input.data);
        const e = buildEspelhoSnapshot(c.input.func, regs, [], [], c.input.mes, c.input.data);
        r = { bank: { saldo: b.saldo, trabMin: b.trabMin, esperMin: b.esperMin }, mirror: { saldo: e.totais.saldo, trabMin: e.totais.trabMin, esperMin: e.totais.esperMin } };
      } else r = rodar(c.input);
      const diverge = r.bank.saldo !== r.mirror.saldo || r.bank.trabMin !== r.mirror.trabMin || r.bank.esperMin !== r.mirror.esperMin;
      saida.push({ ...c, r, diverge });
      // documentação: casos com "regra" SÃO divergências conhecidas; os demais devem coincidir
      expect(diverge).toBe(!!c.regra);
    });
  }
  afterAll(() => {
    const out = process.env.PONTO_F0_DIVERGENCIAS_OUT;
    if (!out) return;
    const fmt = x => `saldo=${x.saldo} trab=${x.trabMin} esper=${x.esperMin}` + (x.pendencia !== undefined ? ` pend=${x.pendencia}` : '') + (x.statusDia ? ` statusDia=${x.statusDia} saldoDia=${x.saldoDia}` : '');
    const inp = c => JSON.stringify({ data: c.input.data, batidas: (c.input.regs || []).filter(r => r.data === c.input.data).map(r => r.tipo + '@' + r.hora.slice(0, 5) + (r.substituidoPor ? '(subst)' : '') + (r.lancadoPorJustificativa ? '(corr)' : '')),
      creditos: (c.input.creditos || []).map(x => x.motivo + ':' + x.minutos), justificativas: (c.input.justificativas || []).map(j => j.motivo), inicioBancoHoras: c.input.func && c.input.func.inicioBancoHoras });
    const linhas = saida.map(c => c.diverge
      ? `CASE=${c.caso}\nINPUT=${inp(c)}\nBANK_RESULT=${fmt(c.r.bank)}\nMIRROR_RESULT=${fmt(c.r.mirror)}\nRULE_DIFFERENCE=${c.regra}\nBANK_CODE_PATH=${c.bankPath}\nMIRROR_CODE_PATH=${c.mirrorPath}\nLIKELY_INTENDED_RULE=${c.provavel}\n`
      : `CASE=${c.caso} → IGUAL (${fmt(c.r.bank)} | espelho statusDia=${c.r.mirror.statusDia})\n`);
    fs.writeFileSync(out, linhas.join('\n'));
  });
});
