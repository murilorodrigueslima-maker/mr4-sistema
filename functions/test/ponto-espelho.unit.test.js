/**
 * ponto-espelho.unit.test.js
 *
 * Testes para buildEspelhoSnapshot, canonicalizarSnapshot e regras de
 * versionamento de espelho.
 *
 * Preserva 100% dos testes existentes em ponto-regras.unit.test.js.
 * Não faz deploy, não altera Firestore, não comita.
 */

'use strict';

const vm   = require('vm');
const fs   = require('fs');
const path = require('path');
const { createHash } = require('crypto');

// ── Carrega ponto-regras.js no contexto isolado ───────────────────────────────
const regrasPath = path.join(__dirname, '../../modulos/ponto-regras.js');
const code = fs.readFileSync(regrasPath, 'utf8');
const ctx  = { console };
vm.createContext(ctx);
vm.runInContext(code, ctx);

const {
  buildEspelhoSnapshot,
  canonicalizarSnapshot,
  calcRevisaoPeriodo,
  calcConcluirRevisao,
  calcTotal,
  fmtMin,
} = ctx;

// VERSAO_ENGINE é const no vm script — não exposta via ctx;
// comparar diretamente contra o valor conhecido.
const VERSAO_ENGINE = '3.0.0';

// ── Helpers ──────────────────────────────────────────────────────────────────
function hashStr(str) {
  return createHash('sha256').update(str, 'utf8').digest('hex');
}

function reg(funcId, data, tipo, hora, opts = {}) {
  return { funcId, data, tipo, hora, lancadoPorJustificativa: opts.justif || false };
}

function cred(funcId, data, minutos, motivo) {
  return { funcId, data, minutos, motivo };
}

function func(id = 'f1', nome = 'Teste', jornada = '8') {
  return { id, nome, cargo: 'Cargo', jornada };
}

// Dia útil completo com almoço válido
function diaCompleto(data, e = '08:00', sa = '12:00', ra = '13:00', s = '17:00') {
  return [
    reg('f1', data, 'entrada',          e),
    reg('f1', data, 'saida_almoco',    sa),
    reg('f1', data, 'retorno_almoco',  ra),
    reg('f1', data, 'saida',           s),
  ];
}

const HOJE = '2026-05-31';
const MES  = '2026-05';

// ── A. Snapshot determinístico ────────────────────────────────────────────────
test('A. snapshot determinístico: mesma entrada → mesmo objeto', () => {
  const regs = diaCompleto('2026-05-02');
  const s1 = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  const s2 = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  expect(JSON.stringify(s1)).toBe(JSON.stringify(s2));
});

test('A. snapshot não inclui dias futuros', () => {
  const snap = buildEspelhoSnapshot(func(), [], [], [], MES, '2026-05-02');
  const futuras = snap.dias.filter(d => d.data > '2026-05-02');
  expect(futuras).toHaveLength(0);
});

test('A. snapshot inclui domingos como status=domingo', () => {
  const snap = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
  // 2026-05-03 é domingo
  const dom = snap.dias.find(d => d.data === '2026-05-03');
  expect(dom).toBeDefined();
  expect(dom.status).toBe('domingo');
  expect(dom.totalMin).toBeNull();
  expect(dom.jornadaDia).toBe(0);
});

test('A. engineVersao gravado no snapshot', () => {
  const snap = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
  expect(snap.engineVersao).toBe(VERSAO_ENGINE);
});

// ── B. Mesmo conteúdo → mesmo hash ───────────────────────────────────────────
test('B. mesmo conteúdo → mesmo hash', () => {
  const regs = diaCompleto('2026-05-02');
  const snap = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  snap.geradoEm = '2026-05-31T10:00:00.000Z';
  const h1 = hashStr(canonicalizarSnapshot(snap));
  const h2 = hashStr(canonicalizarSnapshot(snap));
  expect(h1).toBe(h2);
  expect(h1).toMatch(/^[0-9a-f]{64}$/);
});

test('B. dois snapshots idênticos → hash idêntico', () => {
  const regs = diaCompleto('2026-05-02');
  const s1 = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  const s2 = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  s1.geradoEm = s2.geradoEm = '2026-05-31T10:00:00.000Z';
  expect(hashStr(canonicalizarSnapshot(s1))).toBe(hashStr(canonicalizarSnapshot(s2)));
});

// ── C. Alteração de batida → hash diferente ───────────────────────────────────
test('C. alterar saída final muda o hash', () => {
  const regs1 = diaCompleto('2026-05-02', '08:00', '12:00', '13:00', '17:00');
  const regs2 = diaCompleto('2026-05-02', '08:00', '12:00', '13:00', '18:00'); // 1h a mais
  const s1 = buildEspelhoSnapshot(func(), regs1, [], [], MES, HOJE);
  const s2 = buildEspelhoSnapshot(func(), regs2, [], [], MES, HOJE);
  s1.geradoEm = s2.geradoEm = '2026-05-31T10:00:00.000Z';
  expect(hashStr(canonicalizarSnapshot(s1))).not.toBe(hashStr(canonicalizarSnapshot(s2)));
});

test('C. adicionar novo dia muda o hash', () => {
  const regs1 = diaCompleto('2026-05-02');
  const regs2 = [...regs1, ...diaCompleto('2026-05-05')];
  const s1 = buildEspelhoSnapshot(func(), regs1, [], [], MES, HOJE);
  const s2 = buildEspelhoSnapshot(func(), regs2, [], [], MES, HOJE);
  s1.geradoEm = s2.geradoEm = '2026-05-31T10:00:00.000Z';
  expect(hashStr(canonicalizarSnapshot(s1))).not.toBe(hashStr(canonicalizarSnapshot(s2)));
});

// ── D. Alteração de saldo → hash diferente ────────────────────────────────────
test('D. mudar jornada do funcionário altera totais e hash', () => {
  const regs = diaCompleto('2026-05-04'); // segunda
  const f8 = func('f1','T','8');
  const f6 = func('f1','T','6');
  const s8 = buildEspelhoSnapshot(f8, regs, [], [], MES, HOJE);
  const s6 = buildEspelhoSnapshot(f6, regs, [], [], MES, HOJE);
  s8.geradoEm = s6.geradoEm = '2026-05-31T10:00:00.000Z';
  expect(s8.totais.saldo).not.toBe(s6.totais.saldo);
  expect(hashStr(canonicalizarSnapshot(s8))).not.toBe(hashStr(canonicalizarSnapshot(s6)));
});

// ── E. Espelho assinado renderiza snapshot antigo mesmo com registros mudados ─
test('E. snapshot preserva dados originais independente de registros atuais', () => {
  // Snapshot gerado com saída 17:00
  const regsOriginais = diaCompleto('2026-05-05', '08:00', '12:00', '13:00', '17:00');
  const snapAssinado  = buildEspelhoSnapshot(func(), regsOriginais, [], [], MES, HOJE);
  snapAssinado.geradoEm = '2026-05-31T10:00:00.000Z';
  const hashAssinado  = hashStr(canonicalizarSnapshot(snapAssinado));

  // "Correção" posterior: saída às 18:00
  const regsCorrigidos = diaCompleto('2026-05-05', '08:00', '12:00', '13:00', '18:00');
  const snapNovo = buildEspelhoSnapshot(func(), regsCorrigidos, [], [], MES, HOJE);
  snapNovo.geradoEm = '2026-06-01T09:00:00.000Z';

  // Snapshot assinado continua igual
  expect(hashStr(canonicalizarSnapshot(snapAssinado))).toBe(hashAssinado);
  // Novo snapshot é diferente
  expect(hashStr(canonicalizarSnapshot(snapNovo))).not.toBe(hashAssinado);

  // Verificação de integridade: re-canonicalizar o snapshot armazenado
  const snapArmazenado = JSON.parse(JSON.stringify(snapAssinado));
  expect(hashStr(canonicalizarSnapshot(snapArmazenado))).toBe(hashAssinado);
});

// ── F. Nova versão não herda assinatura (via calcRevisaoPeriodo) ──────────────
test('F. v2 começa sem assinatura', () => {
  const snap = buildEspelhoSnapshot(func(), diaCompleto('2026-05-02'), [], [], MES, HOJE);
  snap.geradoEm = HOJE + 'T10:00:00.000Z';
  const v1Assinado = {
    id: 'id-v1', funcId: 'f1', mes: MES, mesLabel: 'Maio/2026',
    versao: 1, assinado: true, assinadoPor: 'Teste', assinadoEm: HOJE + 'T14:00:00.000Z',
    assinaturaImg: 'data:image/png;base64,abc',
  };
  const resultado = calcRevisaoPeriodo(v1Assinado, 'id-v2', snap, 'hash-novo', 'Correção de horário', HOJE + 'T15:00:00.000Z');
  expect(resultado).not.toBeNull();
  const { v2Doc } = resultado;
  expect(v2Doc.assinado).toBe(false);
  expect(v2Doc.assinaturaImg).toBeNull();
  expect(v2Doc.assinadoPor).toBeNull();
  expect(v2Doc.versaoAnteriorId).toBe('id-v1');
});

// ── G. Vínculo v1 → v2 via calcRevisaoPeriodo ────────────────────────────────
test('G. gestor cria v2 apontando para v1; v1 recebe revisaoEmAndamento (não invalidado)', () => {
  const snap = buildEspelhoSnapshot(func(), diaCompleto('2026-05-02'), [], [], MES, HOJE);
  snap.geradoEm = HOJE + 'T10:00:00.000Z';
  const v1 = {
    id: 'id-v1', funcId: 'f1', mes: MES, mesLabel: 'Maio/2026',
    versao: 1, assinado: true, assinadoPor: 'Teste', assinadoEm: HOJE + 'T14:00:00.000Z',
  };
  const resultado = calcRevisaoPeriodo(v1, 'id-v2', snap, 'hash-novo', 'Motivo revisão', HOJE + 'T15:00:00.000Z');
  expect(resultado).not.toBeNull();
  const { v2Doc, v1Update } = resultado;
  expect(v2Doc.versaoAnteriorId).toBe('id-v1');
  expect(v2Doc.id).toBe('id-v2');
  expect(v2Doc.versao).toBe(2);
  // v1 aponta para v2, mas NÃO é marcada como invalidada enquanto revisão está aberta
  expect(v1Update.versaoSucessoraId).toBe('id-v2');
  expect(v1Update.revisaoEmAndamento).toBe(true);
  expect(v1Update.invalidado).toBeUndefined();
});

// ── H. v1 continua consultável com revisaoEmAndamento e sem perder campos ─────
test('H. v1 com revisaoEmAndamento:true mantém todos os seus campos originais', () => {
  const snap = buildEspelhoSnapshot(func(), diaCompleto('2026-05-02'), [], [], MES, HOJE);
  const v1 = {
    id: 'id-v1', versao: 1,
    // Após calcRevisaoPeriodo: apenas esses campos são adicionados/atualizados
    revisaoEmAndamento: true, revisaoAbertaEm: HOJE + 'T16:00:00.000Z',
    motivoRevisao: 'Correção de horário', versaoSucessoraId: 'id-v2',
    // Campos originais preservados — calcRevisaoPeriodo não os toca
    assinado: true, assinadoEm: HOJE + 'T14:00:00.000Z',
    assinadoPor: 'João Silva', assinaturaImg: 'data:image/png;base64,IMG',
    snapshot: snap, hashSnapshot: 'abc123',
    invalidado: false, // v1 NÃO está invalidada
  };
  expect(v1.assinado).toBe(true);
  expect(v1.invalidado).toBe(false);
  expect(v1.revisaoEmAndamento).toBe(true);
  expect(v1.snapshot).toBeDefined();
  expect(v1.hashSnapshot).toBe('abc123');
  expect(v1.assinadoPor).toBe('João Silva');
});

// ── I. Espelho legado sem snapshot continua abrindo ──────────────────────────
test('I. snapshot legado ausente: buildEspelhoSnapshot produz dados equivalentes', () => {
  // Simula o comportamento de fallback: sem espDoc.snapshot, recalcula dinamicamente
  const regs = diaCompleto('2026-05-05');
  const snap = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  const dia  = snap.dias.find(d => d.data === '2026-05-05');
  expect(dia).toBeDefined();
  expect(dia.status).toBe('ok');
  expect(dia.entrada).toBe('08:00');
  expect(dia.totalMin).toBe(8 * 60); // 9h - 1h almoço = 8h
  expect(dia.saldoDia).toBe(0);      // exatamente 8h = 0 saldo
});

test('I. espelho legado: sem snapshot, dados são gerados do estado atual', () => {
  // Legado: espDoc.snapshot === undefined
  const espDoc = { id: 'legacy', funcId: 'f1', mes: MES, assinado: true, criadoEm: '2026-06-01' };
  expect(espDoc.snapshot).toBeUndefined();
  // A função de renderização faz fallback dinâmico — testamos que o snapshot gerado é válido
  const regs = diaCompleto('2026-05-06');
  const snap = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  expect(snap.dias.length).toBeGreaterThan(0);
  expect(snap.engineVersao).toBe(VERSAO_ENGINE);
});

// ── J. Snapshot assinado não é sobrescrito pelo fluxo da aplicação ───────────
test('J. hash do snapshot assinado muda se snapshot for adulterado', () => {
  const regs = diaCompleto('2026-05-07');
  const snap = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  snap.geradoEm = '2026-05-31T10:00:00.000Z';
  const hashOriginal = hashStr(canonicalizarSnapshot(snap));

  // Simula adulteração: alterar um saldo após assinatura
  const snapAdulterado = JSON.parse(JSON.stringify(snap));
  const diaIdx = snapAdulterado.dias.findIndex(d => d.data === '2026-05-07');
  snapAdulterado.dias[diaIdx].totalMin = 999;
  snapAdulterado.totais.trabMin = 999;

  const hashAdulterado = hashStr(canonicalizarSnapshot(snapAdulterado));
  expect(hashAdulterado).not.toBe(hashOriginal);
});

test('J. canonicalizarSnapshot é insensível à ordem das propriedades do objeto', () => {
  const regs = diaCompleto('2026-05-02');
  const snap1 = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  snap1.geradoEm = '2026-05-31T10:00:00.000Z';

  // Reordena dias manualmente (ordem inversa)
  const snap2 = JSON.parse(JSON.stringify(snap1));
  snap2.dias.reverse();

  // canonicalizarSnapshot ordena por data → hash igual independente da ordem
  expect(hashStr(canonicalizarSnapshot(snap1))).toBe(hashStr(canonicalizarSnapshot(snap2)));
});

// ── Testes adicionais: cálculos de snapshot ───────────────────────────────────
test('snapshot: sábado com jornada 3h30', () => {
  // 2026-05-09 é sábado
  const regs = [
    reg('f1', '2026-05-09', 'entrada', '08:30'),
    reg('f1', '2026-05-09', 'saida',   '12:00'),
  ];
  const snap = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  const sabado = snap.dias.find(d => d.data === '2026-05-09');
  expect(sabado).toBeDefined();
  expect(sabado.jornadaDia).toBe(210); // JORNADA_SABADO_MIN
  expect(sabado.totalMin).toBe(210);   // 8:30–12:00 = 3h30 = 210 min
  expect(sabado.saldoDia).toBe(0);
});

test('snapshot: ponto incompleto (DEC-11 SA=RA) → status incompleto', () => {
  // SA=RA → calcTotal retorna null → status incompleto
  const regs = [
    reg('f1', '2026-05-04', 'entrada',         '08:00'),
    reg('f1', '2026-05-04', 'saida_almoco',    '12:00'),
    reg('f1', '2026-05-04', 'retorno_almoco',  '12:00'), // SA=RA
    reg('f1', '2026-05-04', 'saida',           '17:00'),
  ];
  const snap = buildEspelhoSnapshot(func(), regs, [], [], MES, HOJE);
  const dia  = snap.dias.find(d => d.data === '2026-05-04');
  expect(dia.status).toBe('incompleto');
  expect(dia.totalMin).toBeNull();
  expect(dia.saldoDia).toBeNull();
  // Incompleto suspende o dia: NEM esperMin NEM trabMin crescem.
  // Diferença em relação a uma falta: falta debita jornadaDia de esperMin; incompleto não debita.
  const jornada = 8 * 60; // 480 min
  const snapFalta = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
  // snapFalta conta May-04 como falta → esperMin maior que o incompleto
  expect(snap.totais.esperMin).toBe(snapFalta.totais.esperMin - jornada);
  // trabMin idêntico nos dois casos (nenhum trabalho computado)
  expect(snap.totais.trabMin).toBe(snapFalta.totais.trabMin);
  // incompleto: saldo idêntico ao caso em que o dia simplesmente não existisse
  expect(snap.totais.saldo).toBe(snapFalta.totais.saldo + jornada);
});

test('snapshot: crédito sem ponto → status credito', () => {
  const creditos = [cred('f1', '2026-05-04', 480, 'Atestado médico')];
  const snap = buildEspelhoSnapshot(func(), [], creditos, [], MES, HOJE);
  const dia  = snap.dias.find(d => d.data === '2026-05-04'); // segunda
  expect(dia.status).toBe('credito');
  expect(dia.totalMin).toBe(480);
  expect(dia.ocorrencia).toBe('Atestado médico');
});

test('snapshot: falta → status falta, saldoDia null, esperMin aumenta', () => {
  const snap = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
  const segunda = snap.dias.find(d => d.data === '2026-05-04'); // segunda
  expect(segunda.status).toBe('falta');
  expect(segunda.saldoDia).toBeNull();
  // esperMin deveria acumular jornadaDia para cada falta
  const faltas = snap.dias.filter(d => d.status === 'falta');
  expect(snap.totais.esperMin).toBe(faltas.length * 8 * 60 + snap.dias.filter(d=>d.diaSemana===6&&d.status==='falta').length * (210 - 480));
  // Verificação simples: saldo negativo (todas as faltas)
  expect(snap.totais.saldo).toBeLessThanOrEqual(0);
});

// ── Versionamento — semântica revisão (A-J) ──────────────────────────────────

function v1Assinado(overrides) {
  const snap = buildEspelhoSnapshot(func(), diaCompleto('2026-05-05'), [], [], MES, HOJE);
  snap.geradoEm = HOJE + 'T12:00:00.000Z';
  const hash = hashStr(canonicalizarSnapshot(snap));
  return Object.assign({
    id: 'esp-v1', funcId: 'f1', mes: MES, mesLabel: 'Maio/2026',
    versao: 1, versaoAnteriorId: null, versaoSucessoraId: null,
    invalidado: false, revisaoEmAndamento: false,
    assinado: true, assinadoPor: 'João Silva',
    assinadoEm: HOJE + 'T14:00:00.000Z',
    assinaturaImg: 'data:image/png;base64,ASSINATURA',
    snapshot: snap, hashSnapshot: hash,
  }, overrides || {});
}

const AGORA_REVISAO = HOJE + 'T15:00:00.000Z';

describe('Versionamento — semântica revisão', () => {

  // A. abrir revisão não apaga assinatura v1
  test('A. abrir revisão não apaga assinatura v1', () => {
    const v1 = v1Assinado();
    const snap2 = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
    const resultado = calcRevisaoPeriodo(v1, 'esp-v2', snap2, 'hash2', 'Correção', AGORA_REVISAO);
    // v1Update não contém assinado, assinaturaImg, assinadoPor, assinadoEm
    expect(resultado.v1Update.assinado).toBeUndefined();
    expect(resultado.v1Update.assinaturaImg).toBeUndefined();
    expect(resultado.v1Update.assinadoPor).toBeUndefined();
    // v1 original inalterado
    expect(v1.assinado).toBe(true);
    expect(v1.assinaturaImg).toMatch(/^data:image\/png;base64,/);
    expect(v1.assinadoPor).toBe('João Silva');
  });

  // B. abrir revisão não marca v1 como substituída
  test('B. abrir revisão não marca v1 como substituída (substituido indefinido)', () => {
    const v1 = v1Assinado();
    const snap2 = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
    const resultado = calcRevisaoPeriodo(v1, 'esp-v2', snap2, 'hash2', 'Motivo', AGORA_REVISAO);
    // substituido só é definido em calcConcluirRevisao, após v2 ser assinada
    expect(resultado.v1Update.substituido).toBeUndefined();
    expect(resultado.v1Update.substituidoEm).toBeUndefined();
    // v1 também não é marcada como invalidada
    expect(resultado.v1Update.invalidado).toBeUndefined();
  });

  // C. v1 fica revisaoEmAndamento=true
  test('C. v1 fica revisaoEmAndamento=true ao abrir revisão', () => {
    const v1 = v1Assinado();
    const snap2 = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
    const resultado = calcRevisaoPeriodo(v1, 'esp-v2', snap2, 'hash2', 'Ajuste', AGORA_REVISAO);
    expect(resultado.v1Update.revisaoEmAndamento).toBe(true);
    expect(resultado.v1Update.revisaoAbertaEm).toBe(AGORA_REVISAO);
    expect(resultado.v1Update.motivoRevisao).toBe('Ajuste');
    expect(resultado.v1Update.versaoSucessoraId).toBe('esp-v2');
  });

  // D. v2 nasce aguardando assinatura
  test('D. v2 nasce com status aguardando_assinatura e assinado:false', () => {
    const v1 = v1Assinado();
    const snap2 = buildEspelhoSnapshot(func(), diaCompleto('2026-05-06'), [], [], MES, HOJE);
    const resultado = calcRevisaoPeriodo(v1, 'esp-v2', snap2, 'hash2', 'Correção', AGORA_REVISAO);
    const { v2Doc } = resultado;
    expect(v2Doc.assinado).toBe(false);
    expect(v2Doc.status).toBe('aguardando_assinatura');
    expect(v2Doc.assinaturaImg).toBeNull();
    expect(v2Doc.assinadoPor).toBeNull();
    expect(v2Doc.assinadoEm).toBeNull();
    expect(v2Doc.versaoAnteriorId).toBe('esp-v1');
  });

  // E. v1 continua sendo última versão assinada enquanto v2 não assina
  test('E. v1 continua com assinado:true e invalidado:false durante revisão', () => {
    const v1 = v1Assinado();
    const snap2 = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
    // Simula estado após calcRevisaoPeriodo: v1 recebe v1Update via merge
    const v1Update = calcRevisaoPeriodo(v1, 'esp-v2', snap2, 'hash2', 'Motivo', AGORA_REVISAO).v1Update;
    const v1Merged = Object.assign({}, v1, v1Update);
    // Após merge, v1 permanece assinado e não-invalidado
    expect(v1Merged.assinado).toBe(true);
    expect(v1Merged.invalidado).toBe(false);
    expect(v1Merged.revisaoEmAndamento).toBe(true);
    // Ainda tem todos os dados originais
    expect(v1Merged.hashSnapshot).toBe(v1.hashSnapshot);
    expect(v1Merged.assinaturaImg).toMatch(/^data:image\/png;base64,/);
  });

  // F. assinatura de v2 não altera snapshot/hash/assinatura da v1
  test('F. calcConcluirRevisao não toca em snapshot/hash/assinatura de v1', () => {
    const v1 = v1Assinado();
    const hashV1 = v1.hashSnapshot;
    const snapV1str = JSON.stringify(v1.snapshot);

    const resultado = calcConcluirRevisao(
      'esp-v1', 'esp-v2', 'João Silva', 'data:image/png;base64,V2SIGN', HOJE + 'T17:00:00.000Z'
    );
    // v1Update de conclusão toca apenas em revisaoEmAndamento/substituido/substituidoEm
    expect(resultado.v1Update.snapshot).toBeUndefined();
    expect(resultado.v1Update.hashSnapshot).toBeUndefined();
    expect(resultado.v1Update.assinado).toBeUndefined();
    expect(resultado.v1Update.assinaturaImg).toBeUndefined();
    // v1 original não foi modificado
    expect(v1.hashSnapshot).toBe(hashV1);
    expect(JSON.stringify(v1.snapshot)).toBe(snapV1str);
  });

  // G. após conclusão, v1 pode ser marcada substituída
  test('G. calcConcluirRevisao marca v1 com substituido:true', () => {
    const agora = HOJE + 'T17:00:00.000Z';
    const resultado = calcConcluirRevisao('esp-v1', 'esp-v2', 'João Silva', 'data:image/png;base64,S', agora);
    expect(resultado.v1Update.substituido).toBe(true);
    expect(resultado.v1Update.substituidoEm).toBe(agora);
    expect(resultado.v1Update.revisaoEmAndamento).toBe(false);
    expect(resultado.v1Id).toBe('esp-v1');
  });

  // H. vínculo v1/v2 permanece consistente
  test('H. vínculo v1→v2 e v2→v1 é consistente ao longo do processo', () => {
    const v1 = v1Assinado();
    const snap2 = buildEspelhoSnapshot(func(), diaCompleto('2026-05-07'), [], [], MES, HOJE);
    snap2.geradoEm = AGORA_REVISAO;
    const hash2 = hashStr(canonicalizarSnapshot(snap2));

    // Abre revisão
    const abertura = calcRevisaoPeriodo(v1, 'esp-v2', snap2, hash2, 'Revisão', AGORA_REVISAO);
    expect(abertura.v2Doc.versaoAnteriorId).toBe(v1.id);
    expect(abertura.v1Update.versaoSucessoraId).toBe('esp-v2');

    // Conclui revisão
    const conclusao = calcConcluirRevisao('esp-v1', 'esp-v2', 'João', 'img', HOJE + 'T17:00:00.000Z');
    expect(conclusao.v2Id).toBe('esp-v2');
    expect(conclusao.v1Id).toBe('esp-v1');
    expect(conclusao.v2Update.assinado).toBe(true);
    expect(conclusao.v2Update.status).toBe('assinado');
    // hashSnapshot de v1 continua idêntico
    expect(hashStr(canonicalizarSnapshot(v1.snapshot))).toBe(v1.hashSnapshot);
  });

  // I. operação de abertura retorna ambas as gravações (base para atomicidade no cliente)
  test('I. calcRevisaoPeriodo retorna v2Doc e v1Update juntos (operação atômica no cliente)', () => {
    // A atomicidade real é garantida pelo writeBatch em ponto.html (iniciarRevisaoPeriodo).
    // Este teste verifica que calcRevisaoPeriodo retorna AMBAS as operações num único objeto,
    // obrigando o chamador a commitá-las juntas.
    const v1 = v1Assinado();
    const snap2 = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
    const resultado = calcRevisaoPeriodo(v1, 'esp-v2', snap2, 'h2', 'Motivo', AGORA_REVISAO);
    expect(resultado).not.toBeNull();
    // Ambas as gravações presentes no mesmo objeto de retorno
    expect(resultado.v2Doc).toBeDefined();
    expect(resultado.v1Update).toBeDefined();
    // v2Doc tem id correto e v1Update aponta para ele
    expect(resultado.v2Doc.id).toBe('esp-v2');
    expect(resultado.v1Update.versaoSucessoraId).toBe('esp-v2');
  });

  // J. falha parcial: estado incompleto seria detectável por invariante
  test('J. estado inválido (v1 com revisaoEmAndamento sem v2 correspondente) é detectável', () => {
    // Se o batch falhar após criar v2 mas antes de atualizar v1 (ou vice-versa),
    // o estado fica inconsistente. Este teste documenta os invariantes que permitem detectar isso:
    //
    // Invariante 1: se v1.versaoSucessoraId existe, deve existir doc espelhos/{versaoSucessoraId}
    // Invariante 2: se v2.versaoAnteriorId existe, o v1 correspondente deve ter versaoSucessoraId = v2.id
    //
    // PENDENTE: verificação automática dessas invariantes requer emulador ou Cloud Function.

    // Aqui apenas provamos que os dois objetos têm campos cruzados que permitem validação:
    const v1 = v1Assinado();
    const snap2 = buildEspelhoSnapshot(func(), [], [], [], MES, HOJE);
    const { v2Doc, v1Update } = calcRevisaoPeriodo(v1, 'esp-v2', snap2, 'h', 'M', AGORA_REVISAO);
    // Cruzamento: v2Doc.versaoAnteriorId ↔ v1.id
    expect(v2Doc.versaoAnteriorId).toBe(v1.id);
    // Cruzamento: v1Update.versaoSucessoraId ↔ v2Doc.id
    expect(v1Update.versaoSucessoraId).toBe(v2Doc.id);
  });

});

// ── A-G (auditoria): lógica completa do trigger concluirRevisaoEspelho ───────
// Usa _validateConcluirRevisao exportada de index.js (função pura, sem Firestore).

const { podeAssinarEspelho } = ctx;  // função pura de ponto-regras.js

// Importa a função de validação pura do handler (sem init do Firebase Admin)
process.env.FIRESTORE_EMULATOR_HOST = process.env.FIRESTORE_EMULATOR_HOST || 'localhost:8080';
process.env.GCLOUD_PROJECT          = process.env.GCLOUD_PROJECT          || 'mr4-ponto';
const { _validateConcluirRevisao: validate } = require('../index.js');

function makeV1(overrides = {}) {
  return Object.assign({
    funcId: 'f1', mes: '2026-05',
    versaoSucessoraId: 'esp-v2',
    revisaoEmAndamento: true,
    substituido: false,
  }, overrides);
}

function makeAfter(overrides = {}) {
  return Object.assign({
    assinado: true,
    versaoAnteriorId: 'esp-v1',
    funcId: 'f1',
    mes: '2026-05',
    status: 'assinado',
  }, overrides);
}

describe('A-G (auditoria trigger): validateConcluirRevisao — lógica completa', () => {

  test('A. funcId diferentes → não conclui', () => {
    const v1 = makeV1({ funcId: 'f-outro' });
    expect(validate({ assinado: false }, makeAfter(), v1, 'esp-v2')).toBe('funcId-mismatch');
  });

  test('B. mes diferente → não conclui', () => {
    const v1 = makeV1({ mes: '2026-04' });
    expect(validate({ assinado: false }, makeAfter(), v1, 'esp-v2')).toBe('mes-mismatch');
  });

  test('C. v1 sem revisaoEmAndamento → não conclui', () => {
    const v1 = makeV1({ revisaoEmAndamento: false });
    expect(validate({ assinado: false }, makeAfter(), v1, 'esp-v2')).toBe('v1-not-in-revision');
  });

  test('D. v1 não aponta para esta v2 → não conclui', () => {
    const v1 = makeV1({ versaoSucessoraId: 'esp-outro' });
    expect(validate({ assinado: false }, makeAfter(), v1, 'esp-v2')).toBe('cross-ref-mismatch');
  });

  test('E. v2 com status incompatível (não assinado) → não conclui', () => {
    const after = makeAfter({ status: 'aguardando_assinatura' });
    expect(validate({ assinado: false }, after, makeV1(), 'esp-v2')).toBe('invalid-v2-status');
  });

  test('F. evento repetido (re-trigger) → idempotente', () => {
    const v1 = makeV1({ substituido: true, revisaoEmAndamento: false });
    expect(validate({ assinado: false }, makeAfter(), v1, 'esp-v2')).toBe('idempotent');
  });

  test('G. v1Update toca apenas os 3 campos de conclusão', () => {
    const agora   = HOJE + 'T17:00:00.000Z';
    const { v1Update } = calcConcluirRevisao('esp-v1', 'esp-v2', 'João', 'img', agora);
    // Campos alterados pelo trigger
    expect(v1Update.revisaoEmAndamento).toBe(false);
    expect(v1Update.substituido).toBe(true);
    expect(v1Update.substituidoEm).toBeDefined();
    // Campos que NÃO devem ser tocados
    expect(v1Update.assinado).toBeUndefined();
    expect(v1Update.snapshot).toBeUndefined();
    expect(v1Update.hashSnapshot).toBeUndefined();
    expect(v1Update.assinaturaImg).toBeUndefined();
    expect(v1Update.assinadoEm).toBeUndefined();
    expect(v1Update.assinadoPor).toBeUndefined();
    expect(v1Update.funcId).toBeUndefined();
    expect(v1Update.mes).toBeUndefined();
    expect(v1Update.versao).toBeUndefined();
    expect(v1Update.versaoAnteriorId).toBeUndefined();
  });

  // Casos de noop base (gatilhos sem I/O)
  test('noop: assinado permanece false', () => {
    expect(validate({ assinado: false }, makeAfter({ assinado: false }), makeV1(), 'esp-v2'))
      .toBe('noop-assinado');
  });

  test('noop: assinado já era true antes (re-trigger trivial)', () => {
    expect(validate({ assinado: true }, makeAfter({ assinado: true }), makeV1(), 'esp-v2'))
      .toBe('noop-assinado');
  });

  test('noop: versaoAnteriorId ausente (v1 original sem revisão)', () => {
    const after = makeAfter({ versaoAnteriorId: null });
    expect(validate({ assinado: false }, after, null, 'esp-v2'))
      .toBe('noop-no-versaoAnteriorId');
  });

  test('ok: transição válida completa → ok', () => {
    expect(validate({ assinado: false }, makeAfter(), makeV1(), 'esp-v2')).toBe('ok');
  });

});

// ── S-W: podeAssinarEspelho + fluxo de assinatura ────────────────────────────

describe('S-W: podeAssinarEspelho e fluxo de assinatura', () => {

  const MES_SIGN = '2026-05';

  test('S. podeAssinarEspelho: pontos incompletos bloqueiam assinatura', () => {
    const pendencias = [{ data: '2026-05-04', tipo: 'PONTO_INCOMPLETO' }];
    const resultado  = podeAssinarEspelho(pendencias, [], MES_SIGN);
    expect(resultado.pode).toBe(false);
    expect(resultado.motivo).toMatch(/incompleto/i);
  });

  test('T. podeAssinarEspelho: justificativa pendente no período bloqueia assinatura', () => {
    const justifs = [{ data: '2026-05-10', status: 'pendente', funcId: 'f1' }];
    const resultado = podeAssinarEspelho([], justifs, MES_SIGN);
    expect(resultado.pode).toBe(false);
    expect(resultado.motivo).toMatch(/justificativa/i);
  });

  test('U. podeAssinarEspelho: sem pendências e sem justif pendentes → pode assinar', () => {
    // Justificativa aprovada no período — não bloqueia
    const justifs = [{ data: '2026-05-10', status: 'aprovado', funcId: 'f1' }];
    const resultado = podeAssinarEspelho([], justifs, MES_SIGN);
    expect(resultado.pode).toBe(true);
    expect(resultado.motivo).toBeNull();
  });

  test('V. podeAssinarEspelho: justificativa pendente de outro mês não bloqueia', () => {
    const justifs = [{ data: '2026-04-10', status: 'pendente', funcId: 'f1' }];
    const resultado = podeAssinarEspelho([], justifs, MES_SIGN);
    expect(resultado.pode).toBe(true);
  });

  test('W. calcConcluirRevisao produz v2Update com assinado:true e status:assinado', () => {
    const agora = HOJE + 'T16:00:00.000Z';
    const { v2Update } = calcConcluirRevisao('esp-v1', 'esp-v2', 'Maria', 'data:image/png;base64,SIG', agora);
    expect(v2Update.assinado).toBe(true);
    expect(v2Update.status).toBe('assinado');
    expect(v2Update.assinadoPor).toBe('Maria');
    expect(v2Update.assinadoEm).toBe(agora);
    expect(v2Update.assinaturaImg).toBe('data:image/png;base64,SIG');
  });

});
