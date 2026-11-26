'use strict';
// Reconciliação de vendas excluídas/canceladas — regras puras.
const R = require('../lib/vendasOrigem/regras');
const S = require('../lib/vendasOrigem/sobreposicao');
const H = 3600000;
const { CLASSE: C } = R;

describe('configuração', () => {
  test('ausente, vazia ou inválida ⇒ DESLIGADO', () => { for (const d of [null, undefined, {}, { modo: 'LIGADO' }, { modo: true }]) expect(R.lerConfig(d).modo).toBe('DESLIGADO'); });
  test('APLICAR sem aprovação identificada ⇒ SOMBRA', () => {
    for (const ex of [{}, { aprovadoPor: 'x' }, { aprovadoPor: 'integrador' }, { aprovadoPor: 'integrador', aprovadoEm: 'ontem à tarde' }]) expect(R.lerConfig({ modo: 'APLICAR', ...ex })).toMatchObject({ modo: 'SOMBRA', motivo: 'APLICAR_SEM_APROVACAO' });
    expect(R.lerConfig({ modo: 'APLICAR', aprovadoPor: 'integrador', aprovadoEm: '2026-12-01T00:00:00Z' }).modo).toBe('APLICAR');
  });
  test('ajustes fora da faixa são ignorados; confirmações não são configuráveis', () => {
    const c = R.lerConfig({ modo: 'SOMBRA', espacamentoHoras: 0, intervaloHoras: 999, maxRequisicoes: 5, confirmacoes: { CANCELADA: { min: 1, horas: 0 } }, validadeHoras: 1 });
    expect(c.params).toEqual(R.PARAMS);
    expect(R.lerConfig({ modo: 'SOMBRA', janelaRecenteDias: 45, liberadasCarteira: [123, 'abc'] })).toMatchObject({ params: { janelaRecenteDias: 45 } });
    expect([...R.lerConfig({ liberadasCarteira: [123, 'abc'] }).liberadasCarteira]).toEqual(['123']);
  });
});

describe('classificação', () => {
  const reg = (ex = {}) => ({ id: '10', loja_id: '262759', data: '2026-11-20', nome_situacao: 'Concretizada', ...ex });
  const c = p => R.classificarDetalhe({ id: '10', dataConhecida: '2026-11-20', provaLoja: true, ...p });
  test('404 só é exclusão com prova de que a venda era da loja ativa', () => { expect(c({ erro: 'GC_HTTP_404' })).toBe(C.NAO_ENCONTRADA); expect(c({ erro: 'GC_HTTP_404', provaLoja: false })).toBe(C.SEM_PROVA_DE_LOJA); });
  test.each(['GC_HTTP_500', 'GC_HTTP_503', 'GC_HTTP_400', 'GC_HTTP_401', 'GC_HTTP_403', 'GC_429_ESGOTADO', 'GC_TIMEOUT', 'GC_REDE', 'GC_JSON_INVALIDO', 'GC_RESPOSTA_INESPERADA', 'RECON_ORCAMENTO_ESGOTADO'])('%s é erro temporário (nunca exclusão)', erro => expect(c({ erro })).toBe(C.ERRO_TEMPORARIO));
  test('registro de outro id é erro', () => expect(c({ registro: reg({ id: '11' }) })).toBe(C.ERRO_TEMPORARIO));
  test('ausência por filtro de loja', () => {
    expect(c({ registro: reg({ loja_id: '424483' }) })).toBe(C.OUTRA_LOJA);
    expect(c({ registro: reg({ loja_id: '424483', nome_situacao: 'Cancelada' }) })).toBe(C.OUTRA_LOJA);
    expect(c({ registro: reg({ loja_id: undefined, nome_loja: 'FOCUS PARTS' }) })).toBe(C.OUTRA_LOJA);
    expect(c({ registro: reg({ loja_id: undefined }) })).toBe(C.LOJA_NAO_DECLARADA);
  });
  test('cancelamento × edição de data × ativa fora da lista', () => {
    expect(c({ registro: reg({ nome_situacao: 'Cancelada' }) })).toBe(C.CANCELADA);
    expect(c({ registro: reg({ nome_situacao: 'Qualquer', situacao_id: '3952594' }) })).toBe(C.CANCELADA);
    expect(c({ registro: reg({ data: '2025-01-01' }) })).toBe(C.DATA_ALTERADA);
    expect(c({ registro: reg() })).toBe(C.ATIVA_FORA_DA_LISTA);
  });
});

describe('máquina de estados', () => {
  const obs = (classe, h, runId = 'r' + h) => ({ vendaId: '10', classe, em: h * H, runId });
  const seguir = lista => lista.reduce((a, o) => { const r = R.observar(a.cand, o); return { cand: r.cand, acoes: [...a.acoes, r.acao] }; }, { cand: null, acoes: [] });
  test('um 404 isolado nunca confirma', () => expect(seguir([obs(C.NAO_ENCONTRADA, 0)]).cand.estado).toBe('OBSERVANDO'));
  test('CANCELADA: 3 observações e 12 h', () => {
    expect(seguir([obs(C.CANCELADA, 0), obs(C.CANCELADA, 6)]).cand.estado).toBe('OBSERVANDO');
    expect(seguir([obs(C.CANCELADA, 0), obs(C.CANCELADA, 3), obs(C.CANCELADA, 6)]).cand.estado).toBe('OBSERVANDO');   // 3, mas só 6 h
    expect(seguir([obs(C.CANCELADA, 0), obs(C.CANCELADA, 6), obs(C.CANCELADA, 12)]).cand.estado).toBe('CONFIRMADA');
  });
  test('NAO_ENCONTRADA: 4 observações e 24 h', () => {
    expect(seguir([0, 12, 25].map(h => obs(C.NAO_ENCONTRADA, h))).cand.estado).toBe('OBSERVANDO');
    expect(seguir([0, 4, 8, 12].map(h => obs(C.NAO_ENCONTRADA, h))).cand.estado).toBe('OBSERVANDO');
    expect(seguir([0, 8, 16, 24].map(h => obs(C.NAO_ENCONTRADA, h))).cand.estado).toBe('CONFIRMADA');
  });
  test('mesma execução ou intervalo curto não contam', () => {
    const r = seguir([obs(C.CANCELADA, 0, 'a'), obs(C.CANCELADA, 20, 'a'), obs(C.CANCELADA, 21, 'b'), obs(C.CANCELADA, 1, 'c')]);
    expect(r.cand.sequencia.n).toBe(2);
  });
  test('erro temporário não conta nem zera', () => {
    const r = seguir([obs(C.CANCELADA, 0), obs(C.ERRO_TEMPORARIO, 6), obs(C.CANCELADA, 12), obs(C.ERRO_TEMPORARIO, 18), obs(C.CANCELADA, 24)]);
    expect(r.cand).toMatchObject({ estado: 'CONFIRMADA', sequencia: { n: 3 } });
  });
  test('troca de classe e lacuna longa reiniciam a contagem', () => {
    expect(seguir([obs(C.CANCELADA, 0), obs(C.CANCELADA, 6), obs(C.NAO_ENCONTRADA, 12)]).cand.sequencia).toMatchObject({ classe: 'NAO_ENCONTRADA', n: 1 });
    expect(seguir([obs(C.CANCELADA, 0), obs(C.CANCELADA, 6), obs(C.CANCELADA, 100)]).cand.sequencia.n).toBe(1);
  });
  test('reaparecimento antes de aplicar encerra; recomeça do zero se sumir de novo', () => {
    const a = seguir([obs(C.CANCELADA, 0), obs(C.CANCELADA, 6), obs(C.PRESENTE, 12)]);
    expect(a.cand).toMatchObject({ estado: 'DESCARTADA', aberta: false, sequencia: null });
    expect(R.observar(a.cand, obs(C.CANCELADA, 18)).cand).toMatchObject({ estado: 'OBSERVANDO', aberta: true, sequencia: { n: 1 } });
    expect(seguir([0, 6, 12].map(h => obs(C.CANCELADA, h)).concat(obs(C.PRESENTE, 18))).cand.estado).toBe('REAPARECIDA');
  });
  test('aplicada: presença ou evidência contrária pede reversão; erro não', () => {
    const aplicada = { ...seguir([0, 6, 12].map(h => obs(C.CANCELADA, h))).cand, estado: 'APLICADA', invalidacaoAtiva: true };
    for (const k of [C.PRESENTE, C.ATIVA_FORA_DA_LISTA, C.DATA_ALTERADA, C.OUTRA_LOJA, C.LOJA_NAO_DECLARADA]) expect(R.observar(aplicada, obs(k, 20)).acao).toBe('REVERTER');
    for (const k of [C.ERRO_TEMPORARIO, C.SEM_PROVA_DE_LOJA, C.CANCELADA, C.NAO_ENCONTRADA]) expect(R.observar(aplicada, obs(k, 20)).acao).toBe(null);
    expect(R.observar(aplicada, obs(C.NAO_ENCONTRADA, 20)).cand.estado).toBe('APLICADA');
  });
  test('classes inconclusivas nunca confirmam, por mais que se repitam', () => {
    for (const k of [C.ATIVA_FORA_DA_LISTA, C.OUTRA_LOJA, C.LOJA_NAO_DECLARADA, C.SEM_PROVA_DE_LOJA]) expect(seguir([0, 10, 20, 30, 40, 50].map(h => obs(k, h))).cand).toMatchObject({ estado: 'INCONCLUSIVA', sequencia: null, invalidacaoAtiva: false });
  });
  test('bloqueada (revertida à mão) não volta sozinha', () => {
    const b = { ...R.candidatoNovo('10'), bloqueada: true, aberta: false, estado: 'REVERTIDA_MANUAL' };
    expect(R.observar(b, obs(C.CANCELADA, 0))).toMatchObject({ mudou: false, cand: b });
  });
});

describe('anomalia de volume e sobreposição', () => {
  test('lista muito menor ou ausências demais', () => {
    expect(R.anomalia({ ativas: 100, lidas: 60, ausentes: 2 })).toBe('LISTA_MUITO_MENOR_QUE_O_ESPELHO');
    expect(R.anomalia({ ativas: 100, lidas: 84, ausentes: 16 })).toBe('AUSENCIAS_ACIMA_DO_LIMITE');
    expect(R.anomalia({ ativas: 600, lidas: 598, ausentes: 3 })).toBe(null);
  });
  test('sobrepor não altera o original e ignora quem voltou na leitura', () => {
    const regs = [{ id: '1', nome_situacao: 'Concretizada', situacao_estoque: '1' }, { id: '2', nome_situacao: 'Concretizada', situacao_estoque: '1' }];
    const r = S.sobrepor(regs, new Set(['2']), new Map([['1', 'NAO_ENCONTRADA'], ['2', 'CANCELADA']]));
    expect(r).toEqual({ aplicadas: 1, registros: [{ id: '1', nome_situacao: 'Excluída na origem', situacao_estoque: '0' }, regs[1]] });
    expect(regs[0].nome_situacao).toBe('Concretizada');
    expect(S.sobrepor(regs, new Set(), null)).toEqual({ aplicadas: 0, registros: regs });
  });
});
