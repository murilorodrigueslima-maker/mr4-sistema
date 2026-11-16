'use strict';
// PONTO — P5: espelho identifica batidas lançadas por justificativa e mostra original × corrigido. Só EXIBIÇÃO: snapshot/hash/saldo intactos.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ctx = {}; vm.createContext(ctx); vm.runInContext(fs.readFileSync(path.resolve(__dirname, '../../modulos/ponto-regras.js'), 'utf8'), ctx);
const R = ctx;
const F = { id: 'F1', nome: 'Func', cargo: 'X', jornada: '8', controleBancoHoras: true, inicioBancoHoras: '2026-08-03' };
const nat = (data, tipo, hora, extra = {}) => ({ id: `${tipo}_${data}`, funcId: 'F1', data, tipo, hora, ...extra });
const corr = (data, tipo, hora, orig = [], extra = {}) => ({ id: 'corr_' + tipo + data, funcId: 'F1', data, tipo, hora: hora + ':00', lancadoPorJustificativa: true, justificativaId: 'j_' + tipo + data,
  valorOriginal: orig.map(h => ({ id: 'x', hora: h, tipo })), aprovadoPorEmail: 'gestor@mr4.com', aprovadoEm: '2026-11-16T12:09:26Z', origem: 'pontoJustificativaDecidir', motivoCorrecao: 'Ponto não batido — ' + tipo, ...extra });
// dia 01: entrada/saída reais; almoço lançado por justificativa (os toques originais do fim do dia ficaram "substituídos")
const D1 = '2026-10-01';
const REGS = [
  nat(D1, 'entrada', '08:13:01'), nat(D1, 'saida', '17:30:38'),
  nat(D1, 'saida_almoco', '17:29:33', { substituidoPor: 'corr_saida_almoco' + D1 }), nat(D1, 'retorno_almoco', '17:30:08', { substituidoPor: 'corr_retorno_almoco' + D1 }),
  corr(D1, 'saida_almoco', '12:01', ['17:29:33']), corr(D1, 'retorno_almoco', '13:01', ['17:30:08']),
  // dia 05: só a saída foi lançada por justificativa, SEM batida original
  nat('2026-10-05', 'entrada', '08:40:00'), nat('2026-10-05', 'saida_almoco', '12:54:00'), nat('2026-10-05', 'retorno_almoco', '13:53:00'), corr('2026-10-05', 'saida', '17:35', []),
  // sábado com encerramento direto
  nat('2026-10-24', 'entrada', '08:41:15'), nat('2026-10-24', 'saida', '12:30:00', { encerramentoDireto: true, encerramentoMotivo: 'SABADO_SEM_ALMOCO' }),
];
const JUST = [];
const snap = () => { const s = R.buildEspelhoSnapshot(F, REGS, [], JUST, '2026-10', '2026-10-31'); s.geradoEm = '2026-11-01T00:00:00Z'; s.funcId = 'F1'; return s; };

describe('P5 · buildOrigemBatidas', () => {
  const o = R.buildOrigemBatidas(REGS, '2026-10');
  test('batida real × lançada por justificativa; horário original preservado (hh:mm e completo); dados da aprovação', () => {
    const d1 = o.dias[D1];
    expect(d1.entrada).toMatchObject({ origem: 'batida', hora: '08:13' });
    expect(d1.saidaAlmoco).toMatchObject({ origem: 'justificativa', hora: '12:01', horaOriginal: '17:29', horaOriginalCompleta: '17:29:33', aprovadoPor: 'gestor@mr4.com', justificativaId: 'j_saida_almoco' + D1 });
    expect(d1.retornoAlmoco).toMatchObject({ origem: 'justificativa', hora: '13:01', horaOriginal: '17:30' });
  });
  test('sem batida original ⇒ horaOriginal null; fallback pelos registros substituídos quando valorOriginal falta', () => {
    expect(o.dias['2026-10-05'].saida).toMatchObject({ origem: 'justificativa', hora: '17:35', horaOriginal: null });
    const regs = [nat(D1, 'saida_almoco', '17:29:33', { substituidoPor: 'cx' }), { ...corr(D1, 'saida_almoco', '12:01'), id: 'cx', valorOriginal: undefined }];
    expect(R.buildOrigemBatidas(regs, '2026-10').dias[D1].saidaAlmoco.horaOriginal).toBe('17:29');
  });
  test('encerramento direto identificado; resumo com contagens e percentual', () => {
    expect(o.dias['2026-10-24'].saida).toMatchObject({ origem: 'batida', encerramentoDireto: true });
    expect(o.resumo).toEqual({ totalBatidas: 10, porJustificativa: 3, encerramentosDiretos: 1, percentualJustificativa: 30 });
  });
  test('registros de outro mês são ignorados; entrada vazia não quebra', () => {
    expect(R.buildOrigemBatidas(REGS, '2026-09').resumo.totalBatidas).toBe(0);
    expect(R.buildOrigemBatidas(null, '2026-10').resumo.totalBatidas).toBe(0);
  });
});

describe('P5 · renderização (apenas exibição)', () => {
  const o = R.buildOrigemBatidas(REGS, '2026-10');
  test('SEM origem: saída idêntica à anterior (compatível) — nenhuma marca "J", texto da ocorrência intacto', () => {
    const s = snap(); s.dias.find(d => d.data === D1).ocorrencia = 'Ponto não batido — Saída almoço às 12:01';
    const h = R.renderEspelhoRowsHTML(s);
    expect(h).not.toMatch(/>J<\/span>/); expect(h).toContain('Ponto não batido — Saída almoço às 12:01'); expect(h).not.toContain('orig.');
  });
  test('COM origem: marca J + "orig. 17:29" na célula certa; ocorrência rotulada como lançada por justificativa', () => {
    const s = snap(); s.dias.find(d => d.data === D1).ocorrencia = 'Ponto não batido — Saída almoço às 12:01';
    const h = R.renderEspelhoRowsHTML(s, o);
    expect(h).toMatch(/12:01 <span title="[^"]*Lançada por justificativa aprovada por gestor@mr4\.com\. Batida original: 17:29:33\.[^"]*"[^>]*>J<\/span><div[^>]*>orig\. 17:29<\/div>/);
    expect(h).toMatch(/13:01 <span[^>]*>J<\/span><div[^>]*>orig\. 17:30<\/div>/);
    expect(h).toContain('Batida lançada por justificativa — Saída almoço às 12:01'); expect(h).not.toContain('Ponto não batido —');
    expect(h).toMatch(/17:35 <span[^>]*>J<\/span><div[^>]*>sem batida original<\/div>/);
    expect(h).toMatch(/12:30 <span[^>]*>direto<\/span>/);
    expect(h).toMatch(/<td style="color:#111;">08:13<\/td>/);                       // batida real: sem marca
  });
  test('só marca quando o horário exibido é o da batida analisada (snapshot antigo/diferente não recebe marca errada)', () => {
    const s = snap(); const d = s.dias.find(x => x.data === D1); d.saidaAlmoco = '12:05';
    expect(R.renderEspelhoRowsHTML(s, o)).not.toMatch(/12:05 <span/);
  });
  test('XSS: e-mail do aprovador escapado no tooltip; nada de HTML cru', () => {
    const regs = [nat(D1, 'entrada', '08:00:00'), corr(D1, 'saida', '17:00', [], { aprovadoPorEmail: '"><img src=x onerror=alert(1)>' })];
    const sn = R.buildEspelhoSnapshot(F, regs, [], [], '2026-10', '2026-10-31'); sn.geradoEm = 'x';
    const h = R.renderEspelhoRowsHTML(sn, R.buildOrigemBatidas(regs, '2026-10'));
    expect(/<img src=x/.test(h)).toBe(false); expect(h.includes('&quot;&gt;&lt;img')).toBe(true);
  });
  test('legenda: resumo do mês; vazia quando não há justificativa nem encerramento direto', () => {
    expect(R.renderLegendaOrigemHTML(o)).toMatch(/3 de 10<\/strong> batidas do mês \(30%\)/);
    expect(R.renderLegendaOrigemHTML(o)).toMatch(/direto<\/span> = expediente encerrado sem almoço/);
    expect(R.renderLegendaOrigemHTML(R.buildOrigemBatidas([nat(D1, 'entrada', '08:00:00')], '2026-10'))).toBe('');
    expect(R.renderLegendaOrigemHTML(null)).toBe('');
  });
  test('snapshot legado 3.x: a origem é ignorada (documento congelado não muda de aparência)', () => {
    const v3 = { engineVersao: '3.0.0', funcId: 'F1', mes: '2026-10', dias: [{ data: D1, diaSemana: 4, entrada: '08:13', saidaAlmoco: '12:01', retornoAlmoco: '13:01', saida: '17:30', totalMin: 497, saldoDia: 17, ocorrencia: '' }], totais: { trabMin: 497, saldo: 17 } };
    expect(R.renderEspelhoRowsHTML(v3, o)).toBe(R.renderEspelhoRowsHTML(v3));
  });
});

describe('P5 · não altera cálculo, snapshot, hash nem saldos', () => {
  test('o snapshot não ganha campos; canonicalização/hash idênticos; saldos iguais com e sem origem', () => {
    const s = snap(); const antes = R.canonicalizarSnapshot(s);
    R.buildOrigemBatidas(REGS, '2026-10'); R.renderEspelhoRowsHTML(s, R.buildOrigemBatidas(REGS, '2026-10')); R.renderLegendaOrigemHTML(R.buildOrigemBatidas(REGS, '2026-10'));
    expect(R.canonicalizarSnapshot(s)).toBe(antes);
    expect(JSON.stringify(s)).not.toMatch(/horaOriginal|justificativa"|origem/);
    expect(R.snapshotsEquivalentes(s, snap())).toBe(true);
  });
  test('registros e justificativas não são mutados', () => {
    const a = JSON.stringify(REGS); R.buildOrigemBatidas(REGS, '2026-10'); expect(JSON.stringify(REGS)).toBe(a);
  });
  test('o dia 1 continua fechando com 8h17 (+0h17), inclusive com almoço lançado por justificativa', () => {
    const d = snap().dias.find(x => x.data === D1); expect(d).toMatchObject({ status: 'ok', trabalhadoMin: 497, saldoDia: 17 });
  });
});
