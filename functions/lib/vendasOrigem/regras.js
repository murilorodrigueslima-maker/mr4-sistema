'use strict';
/**
 * Reconciliação de vendas EXCLUÍDAS / CANCELADAS na origem — regras PURAS (sem I/O).
 *
 * Por que existe: o incremental relê o GestãoClick e mescla por id; o que SAI da lista nunca é retirado do espelho (`vendas_gc`),
 * e há evidência (26/11/2026) de venda que some da lista e continua respondendo por id como "Cancelada" sem mudar `modificado_em`.
 *
 * Princípios:
 *  1. Ausência na lista NÃO prova nada sozinha: toda ausência é classificada (consulta individual por id, loja, data, situação).
 *  2. Só duas classes podem invalidar: CANCELADA e NAO_ENCONTRADA — e só após várias observações, em execuções distintas,
 *     espaçadas no tempo, todas a partir de leituras íntegras. Erro temporário não conta nem zera.
 *  3. Qualquer evidência de que o registro continua válido refuta (e reverte o que tiver sido aplicado).
 *  4. Padrão DESLIGADO; SOMBRA só registra; APLICAR exige aprovação identificada na configuração.
 */
const gcHttp = require('../gcHttp');
const { RE_CANCELADA } = require('../compras/canonico');

const LOJA = gcHttp.LOJA_ATIVA_ID;
const NOME_LOJA = 'MR4 DISTRIBUIDORA';
const SITUACAO_ID_CANCELADA = '3952594';                    // "Cancelada" (vendas) — mesmo valor de painelMetricas
const COLECOES = Object.freeze({ config: 'vendas_origem_config', candidatos: 'vendas_origem_candidatos', trilha: 'vendas_origem_trilha', estado: 'vendas_origem_estado' });
const DOC_CONFIG = 'reconciliacao';

const MODOS = Object.freeze(['DESLIGADO', 'SOMBRA', 'APLICAR']);
const CLASSE = Object.freeze({
  CANCELADA: 'CANCELADA',                       // registro existe na loja ativa e está cancelado (lista ou consulta por id)
  NAO_ENCONTRADA: 'NAO_ENCONTRADA',             // fora da lista íntegra E consulta por id responde 404 (com controle positivo) — exclusão
  PRESENTE: 'PRESENTE',                         // está na lista, não cancelada
  ATIVA_FORA_DA_LISTA: 'ATIVA_FORA_DA_LISTA',   // responde por id como ativa, mas a lista não a traz (filtro/inconsistência)
  DATA_ALTERADA: 'DATA_ALTERADA',               // data da venda editada: saiu do período consultado, não foi excluída
  OUTRA_LOJA: 'OUTRA_LOJA',                     // registro declara outra loja: ausência por filtro de loja
  LOJA_NAO_DECLARADA: 'LOJA_NAO_DECLARADA',     // registro não declara loja: não dá para afirmar nada
  SEM_PROVA_DE_LOJA: 'SEM_PROVA_DE_LOJA',       // 404 de venda que nunca comprovamos ser da loja ativa
  ERRO_TEMPORARIO: 'ERRO_TEMPORARIO',           // rede, 429, 5xx, resposta inválida: não é observação
});
const CONFIRMAVEIS = Object.freeze([CLASSE.CANCELADA, CLASSE.NAO_ENCONTRADA]);
const ESTADOS = Object.freeze({ OBSERVANDO: 'OBSERVANDO', CONFIRMADA: 'CONFIRMADA', APLICADA: 'APLICADA', INCONCLUSIVA: 'INCONCLUSIVA', DESCARTADA: 'DESCARTADA', REAPARECIDA: 'REAPARECIDA', RESOLVIDA_PELO_SYNC: 'RESOLVIDA_PELO_SYNC', REVERTIDA_MANUAL: 'REVERTIDA_MANUAL' });
/** Rótulo gravado no espelho quando aplicada. Nenhum é "Concretizada": todos os consumidores atuais deixam de contar a venda. */
const ROTULO_ESPELHO = Object.freeze({ CANCELADA: 'Cancelada', NAO_ENCONTRADA: 'Excluída na origem' });

const H = 3600000;
const PARAMS = Object.freeze({
  confirmacoes: Object.freeze({ CANCELADA: Object.freeze({ min: 3, horas: 12 }), NAO_ENCONTRADA: Object.freeze({ min: 4, horas: 24 }) }),
  espacamentoHoras: 3, validadeHoras: 72,
  intervaloHoras: 4, intervaloProfundoHoras: 24, janelaRecenteDias: 35, janelaProfundaDias: 180,
  maxRequisicoes: 150, pausaMs: 300, maxDetalhes: 25, maxDatas: 10,
  ausentesMin: 15, ausentesFracao: 0.10, listaMinimaFracao: 0.70,
  pisoProvaLoja: '2026-11-25 00:00:00',          // a partir daqui o espelho só recebeu vendas lidas com loja_id=262759
});
// Ajustes aceitos pela configuração: faixas fechadas. Confirmações só podem ficar MAIS exigentes que o padrão.
const AJUSTES = Object.freeze({ intervaloHoras: [1, 48], janelaRecenteDias: [7, 90], janelaProfundaDias: [35, 400], maxRequisicoes: [20, 300], maxDetalhes: [1, 60], ausentesMin: [0, 500], espacamentoHoras: [PARAMS.espacamentoHoras, 24] });

const dentro = (v, [a, b]) => Number.isInteger(v) && v >= a && v <= b;
const texto = (v, n) => typeof v === 'string' && v.trim().length >= n;

/** Configuração efetiva. Ausente/ inválida ⇒ DESLIGADO. APLICAR sem aprovação identificada ⇒ SOMBRA. */
function lerConfig(doc) {
  const d = doc || {};
  let modo = MODOS.includes(d.modo) ? d.modo : 'DESLIGADO', motivo = null;
  if (modo === 'APLICAR' && !(texto(d.aprovadoPor, 3) && texto(d.aprovadoEm, 10) && Number.isFinite(Date.parse(d.aprovadoEm)))) { modo = 'SOMBRA'; motivo = 'APLICAR_SEM_APROVACAO'; }
  const params = { ...PARAMS };
  for (const [k, faixa] of Object.entries(AJUSTES)) if (dentro(d[k], faixa)) params[k] = d[k];
  const lista = v => new Set((Array.isArray(v) ? v : []).map(String).filter(x => /^\d{1,15}$/.test(x)));
  return { modo, motivo, params, liberadasCarteira: lista(d.liberadasCarteira) };
}

const cancelada = r => !!r && (String(r.situacao_id) === SITUACAO_ID_CANCELADA || RE_CANCELADA.test(String(r.nome_situacao || '')));
/** 'ATIVA' | 'OUTRA' | 'NAO_DECLARADA' */
function lojaDe(r) {
  const id = r && r.loja_id !== undefined && r.loja_id !== null ? String(r.loja_id) : '';
  const nome = String((r && r.nome_loja) || '').trim().replace(/\s+/g, ' ').toUpperCase();
  if ((id && id !== LOJA) || (nome && nome !== NOME_LOJA)) return 'OUTRA';
  return id || nome ? 'ATIVA' : 'NAO_DECLARADA';
}
const classificarListado = r => (cancelada(r) ? CLASSE.CANCELADA : CLASSE.PRESENTE);

/**
 * Resultado da consulta individual de uma venda AUSENTE da lista.
 * @param {object} p  { id, registro | erro, dataConhecida, provaLoja:boolean }
 */
function classificarDetalhe({ id, registro, erro, dataConhecida, provaLoja }) {
  if (erro) {
    if (erro === 'GC_HTTP_404') return provaLoja ? CLASSE.NAO_ENCONTRADA : CLASSE.SEM_PROVA_DE_LOJA;
    return CLASSE.ERRO_TEMPORARIO;                  // qualquer outro erro (inclusive formato inesperado) nunca vira exclusão
  }
  if (!registro || String(registro.id) !== String(id)) return CLASSE.ERRO_TEMPORARIO;
  const loja = lojaDe(registro);
  if (loja === 'OUTRA') return CLASSE.OUTRA_LOJA;
  if (loja !== 'ATIVA') return CLASSE.LOJA_NAO_DECLARADA;
  if (cancelada(registro)) return CLASSE.CANCELADA;
  const data = String(registro.data || '').slice(0, 10);
  if (dataConhecida && data && data !== dataConhecida) return CLASSE.DATA_ALTERADA;
  return CLASSE.ATIVA_FORA_DA_LISTA;
}

const candidatoNovo = vendaId => ({ schema: 1, vendaId: String(vendaId), estado: ESTADOS.OBSERVANDO, classe: null, sequencia: null, aberta: true, invalidacaoAtiva: false, bloqueada: false, versao: 0 });

/**
 * Máquina de estados (pura). `obs` = { classe, em (ms), runId }.
 * @returns {{ cand: object|null, mudou: boolean, acao: null|'REVERTER' }}  cand=null ⇒ nada a registrar.
 */
function observar(anterior, obs, params = PARAMS) {
  const nada = { cand: anterior || null, mudou: false, acao: null };
  if (obs.classe === CLASSE.ERRO_TEMPORARIO) return nada;
  if (obs.classe === CLASSE.PRESENTE) {
    if (!anterior) return nada;
    if (anterior.invalidacaoAtiva) return { cand: anterior, mudou: false, acao: 'REVERTER' };
    if (!anterior.aberta) return nada;
    return { cand: { ...anterior, estado: anterior.estado === ESTADOS.CONFIRMADA ? ESTADOS.REAPARECIDA : ESTADOS.DESCARTADA, classe: obs.classe, sequencia: null, aberta: false, ultimaObservacaoEm: obs.em }, mudou: true, acao: null };
  }
  const c = anterior ? { ...anterior } : null;
  if (!CONFIRMAVEIS.includes(obs.classe)) {
    if (obs.classe === CLASSE.SEM_PROVA_DE_LOJA && c && c.invalidacaoAtiva) return nada;
    if (c && c.invalidacaoAtiva) return { cand: anterior, mudou: false, acao: 'REVERTER' };        // evidência deixou de se sustentar
    const base = c || candidatoNovo(obs.vendaId);
    const encerra = obs.classe === CLASSE.DATA_ALTERADA;
    const mudou = base.classe !== obs.classe || !c || !base.aberta;
    return { cand: { ...base, estado: encerra ? ESTADOS.DESCARTADA : ESTADOS.INCONCLUSIVA, classe: obs.classe, sequencia: null, aberta: !encerra, ultimaObservacaoEm: obs.em }, mudou: mudou || encerra, acao: null };
  }
  const base = c || candidatoNovo(obs.vendaId);
  if (base.bloqueada) return nada;                                                                   // revertida manualmente: não volta sozinha
  const s = base.aberta ? base.sequencia : null;
  let seq;
  if (!s || s.classe !== obs.classe || obs.em - s.ultimaEm > params.validadeHoras * H) seq = { classe: obs.classe, n: 1, primeiraEm: obs.em, ultimaEm: obs.em, ultimoRunId: obs.runId };
  else if (s.ultimoRunId === obs.runId || obs.em - s.ultimaEm < params.espacamentoHoras * H) return nada;   // mesma execução ou cedo demais: não conta
  else seq = { ...s, n: s.n + 1, ultimaEm: obs.em, ultimoRunId: obs.runId };
  const exig = params.confirmacoes[obs.classe];
  const confirmada = seq.n >= exig.min && seq.ultimaEm - seq.primeiraEm >= exig.horas * H;
  const estado = base.invalidacaoAtiva ? ESTADOS.APLICADA : confirmada ? ESTADOS.CONFIRMADA : ESTADOS.OBSERVANDO;
  return { cand: { ...base, estado, classe: obs.classe, sequencia: seq, aberta: true, ultimaObservacaoEm: obs.em }, mudou: true, acao: null };
}

/** A observação desta classe ainda não pode contar (poupa a consulta por id). */
const cedoDemais = (cand, agoraMs, params = PARAMS) => !!(cand && cand.aberta && cand.ultimaObservacaoEm && agoraMs - cand.ultimaObservacaoEm < params.espacamentoHoras * H);

/** Volume de ausências incompatível com exclusões pontuais ⇒ provável falha da API/filtro: nada é contado. */
function anomalia({ ativas, lidas, ausentes }, params = PARAMS) {
  // mesma proteção de publicação do sync: lista vazia ou queda grande frente ao que o MR4 conhece não vale como referência
  if (!gcHttp.avaliarPublicacao({ novo: lidas, anterior: ativas, limiteQuedaPct: 1 - params.listaMinimaFracao }).publicar) return 'LISTA_MUITO_MENOR_QUE_O_ESPELHO';
  if (ausentes > Math.max(params.ausentesMin, Math.ceil(ativas * params.ausentesFracao))) return 'AUSENCIAS_ACIMA_DO_LIMITE';
  return null;
}

module.exports = { LOJA, NOME_LOJA, SITUACAO_ID_CANCELADA, COLECOES, DOC_CONFIG, MODOS, CLASSE, CONFIRMAVEIS, ESTADOS, ROTULO_ESPELHO, PARAMS, lerConfig, cancelada, lojaDe, classificarListado, classificarDetalhe, candidatoNovo, observar, cedoDemais, anomalia };
