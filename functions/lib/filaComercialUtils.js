'use strict';
// N34.2 — Fila Comercial V1
// Lógica de apresentação PURA. Sem Firebase, sem LLM, sem side effects.
// Consome resultado já calculado do pipeline e organiza para exibição no vendedor.
//
// INVARIANTES PERMANENTES:
//   SHOW_SCORE_TO_SELLER=NO
//   PRIORITY_VISIBLE_TO_SELLER=NO
//   COMO_ABORDAR_INITIAL_STATE=HIDDEN
//   NAO_AGIR_IN_OPERATIONAL_QUEUE=NO
//   MAX_VISIBLE_SIGNALS=3
//   PROSPECT_VINCULADO_IN_RECOMPRA_QUEUE=NO

const { compararOrdemCanonica } = require('./filaOrdering');
const { sanitizeCommercialDisplayName } = require('./nomeExibicao');

const UPCOMING_WINDOW_DAYS = 7;

const TIPOS_RECOMPRA_V1 = Object.freeze([
  'REATIVACAO_120D',
  'QUEDA_DE_COMPRAS',
  'JANELA_DE_RECOMPRA',
]);

const LABEL_OPORTUNIDADE = Object.freeze({
  REATIVACAO_120D:    'Retomar contato',
  QUEDA_DE_COMPRAS:   'Queda no ritmo',
  JANELA_DE_RECOMPRA: 'Janela de recompra',
});

const COR_OPORTUNIDADE = Object.freeze({
  REATIVACAO_120D:    '#d93025',
  QUEDA_DE_COMPRAS:   '#e37400',
  JANELA_DE_RECOMPRA: '#1a73e8',
});

// Campos que NUNCA devem ser expostos ao vendedor via UI
const CAMPOS_BLOQUEADOS = Object.freeze([
  'comoAbordar', 'scoreTotal', 'scoreClassificacao', 'score',
  'classificacao', 'prioridade', 'clienteMr4Id', 'gc_id',
  'faturamento30d', 'faturamento60d', 'faturamentoTotal',
  'llmStatus', 'versaoPrompt', 'mockMode', 'aiMode',
  'trace', 'auditoria', 'grounding', 'llmUsed',
]);

/**
 * Retorna o label seller-facing para um tipo de oportunidade V1.
 * Retorna null para tipos não suportados ou desconhecidos.
 */
function labelOportunidade(tipo) {
  if (!tipo || typeof tipo !== 'string') return null;
  return LABEL_OPORTUNIDADE[tipo] || null;
}

/**
 * Retorna a cor para um tipo de oportunidade V1.
 * Retorna cinza neutro para tipos desconhecidos.
 */
function corOportunidade(tipo) {
  if (!tipo || typeof tipo !== 'string') return '#5f6368';
  return COR_OPORTUNIDADE[tipo] || '#5f6368';
}

/**
 * Formata diasAteProximoCiclo em texto human-readable.
 */
function formatarDiasAteProximoCiclo(dias) {
  if (dias == null || typeof dias !== 'number' || dias < 0) return null;
  if (dias === 0) return 'Hoje';
  if (dias === 1) return 'Amanhã';
  return `Em ${dias} dias`;
}

/**
 * Filtra e ordena a seção HOJE: decisaoAcaoComercial=AGIR_AGORA, tipos V1 apenas.
 * PROSPECT_VINCULADO pertence à FILA_PROSPECCAO e NÃO aparece aqui.
 * Ordena pela regra canônica única (filaOrdering): prioridade DESC → diasSemComprar DESC → identidade ASC.
 */
function filtrarOrdenarFilaHoje(clientes) {
  if (!Array.isArray(clientes)) return [];
  return clientes
    .filter(c =>
      c != null &&
      c.decisaoAcaoComercial === 'AGIR_AGORA' &&
      TIPOS_RECOMPRA_V1.includes(c.tipoOportunidade)
    )
    .sort(compararOrdemCanonica);
}

/**
 * Filtra e ordena a seção PRÓXIMOS CONTATOS:
 *   decisaoAcaoComercial=PROGRAMAR_CICLO AND diasAteProximoCiclo ≤ windowDays.
 * Ordena: diasAteProximoCiclo ASC → clienteMr4Id ASC (desempate determinístico).
 */
function filtrarOrdenarProximosContatos(clientes, windowDays) {
  if (!Array.isArray(clientes)) return [];
  const limite = (typeof windowDays === 'number') ? windowDays : UPCOMING_WINDOW_DAYS;
  return clientes
    .filter(c =>
      c != null &&
      c.decisaoAcaoComercial === 'PROGRAMAR_CICLO' &&
      typeof c.diasAteProximoCiclo === 'number' &&
      c.diasAteProximoCiclo >= 0 &&
      c.diasAteProximoCiclo <= limite
    )
    .sort((a, b) => {
      if (a.diasAteProximoCiclo !== b.diasAteProximoCiclo) {
        return a.diasAteProximoCiclo - b.diasAteProximoCiclo;
      }
      return (a.clienteMr4Id || '').localeCompare(b.clienteMr4Id || '');
    });
}

/**
 * Extrai até MAX_VISIBLE_SIGNALS=3 sinais para exibição no painel de detalhe.
 * Retorna array de objetos { label: string, valor: string }.
 * Nunca retorna um valor fabricado a partir de dado null.
 * SEM_BASE (mediana=null) é sinalizado explicitamente ao invés de omitido silenciosamente.
 */
function extrairSinaisVisiveis(cliente) {
  const sinais = [];

  const diasSemComprar = cliente.diasSemComprar ?? null;
  if (typeof diasSemComprar === 'number' && diasSemComprar >= 0) {
    sinais.push({ label: 'Dias sem comprar', valor: `${diasSemComprar} dias` });
  }

  const mediana =
    (typeof cliente.diasEntreComprasMediana === 'number' ? cliente.diasEntreComprasMediana : null) ??
    (cliente.sellerAssist?.sinais?.cicloMedianoDias ?? null);
  if (typeof mediana === 'number' && mediana > 0) {
    sinais.push({ label: 'Ciclo habitual', valor: `${mediana} dias` });
  } else if (mediana === null && typeof diasSemComprar === 'number') {
    sinais.push({ label: 'Ciclo habitual', valor: 'Ainda sem padrão de recompra' });
  }

  const tendencia =
    cliente.tendencia ??
    (cliente.sellerAssist?.sinais?.tendencia ?? null);
  if (tendencia && typeof tendencia === 'string') {
    const mapa = { SUBINDO: '↗ Subindo', CAINDO: '↘ Caindo', ESTAVEL: '→ Estável', SEM_BASE: 'Histórico insuficiente' };
    sinais.push({ label: 'Tendência', valor: mapa[tendencia] || tendencia });
  }

  return sinais.slice(0, 3);
}

/**
 * Prepara o subconjunto mínimo e seguro de um cliente para exibição na UI.
 * NUNCA inclui campos bloqueados (score, prioridade, comoAbordar, IDs internos, etc).
 */
function prepararDadosUI(cliente) {
  if (!cliente) return null;
  return {
    nomeCliente:             sanitizeCommercialDisplayName(cliente.nomeCliente), // N35.16.1: sem CPF/CNPJ
    tipoOportunidade:        cliente.tipoOportunidade || null,
    // N35.11: ponte de identidade operacional (hash, não é PII, não está em CAMPOS_BLOQUEADOS)
    opportunityInstanceId:   cliente.opportunityInstanceId || null,
    labelOp:                 labelOportunidade(cliente.tipoOportunidade),
    decisaoAcaoComercial:    cliente.decisaoAcaoComercial || null,
    diasSemComprar:          typeof cliente.diasSemComprar === 'number' ? cliente.diasSemComprar : null,
    diasEntreComprasMediana: typeof cliente.diasEntreComprasMediana === 'number' ? cliente.diasEntreComprasMediana : null,
    diasAteProximoCiclo:     typeof cliente.diasAteProximoCiclo === 'number' ? cliente.diasAteProximoCiclo : null,
    situacao:                cliente.sellerAssist?.situacao || null,
    quando:                  cliente.sellerAssist?.quando || null,
    sinaisVisiveis:          extrairSinaisVisiveis(cliente),
    // Campos propositalmente ausentes:
    //   comoAbordar, scoreTotal, prioridade, clienteMr4Id, gc_id,
    //   faturamento*, trace, auditoria, llmStatus, versaoPrompt
  };
}

/**
 * Filtra e ordena a seção PROSPECÇÃO: clientes never-bought (PROSPECT_VINCULADO).
 * Ordenação: nomeCliente normalizado ASC (determinístico, sem IA, sem score).
 * NUNCA mistura com HOJE ou PRÓXIMOS.
 */
function filtrarOrdenarProspeccao(clientes) {
  if (!Array.isArray(clientes)) return [];
  return clientes
    .filter(c => c != null && c.tipoOportunidade === 'PROSPECT_VINCULADO')
    .sort((a, b) =>
      (a.nomeCliente || '').localeCompare(b.nomeCliente || '', 'pt-BR', { sensitivity: 'base' })
    );
}

/**
 * Prepara o subconjunto mínimo e seguro de um prospect para exibição na UI.
 * Campos seller-facing: somente nomeCliente + labelOp + (opcionalmente) criadoEm.
 * PROIBIDO: diasSemComprar, cicloHabitual, inativo120d, oportunidade de recompra.
 */
function prepararDadosUIProspect(cliente) {
  if (!cliente) return null;
  const result = {
    nomeCliente:          sanitizeCommercialDisplayName(cliente.nomeCliente), // N35.16.1: sem CPF/CNPJ
    tipoOportunidade:     'PROSPECT_VINCULADO',
    labelOp:              'Nunca comprou',
    decisaoAcaoComercial: 'FILA_PROSPECCAO',
  };
  if (cliente.criadoEm && typeof cliente.criadoEm === 'string') {
    result.criadoEm = cliente.criadoEm;
  }
  return result;
}

/**
 * Verifica se um objeto (ou seus filhos) contém campos bloqueados.
 * Usado em testes para garantir ausência de dados internos na camada de UI.
 * @returns {string[]} lista de caminhos de campos bloqueados encontrados
 */
function verificarCamposBloqueados(obj) {
  if (!obj || typeof obj !== 'object') return [];
  const encontrados = [];
  function checar(o, caminho) {
    if (!o || typeof o !== 'object') return;
    for (const chave of Object.keys(o)) {
      const caminhoAtual = caminho ? `${caminho}.${chave}` : chave;
      if (CAMPOS_BLOQUEADOS.includes(chave)) {
        encontrados.push(caminhoAtual);
      }
      if (o[chave] && typeof o[chave] === 'object') {
        checar(o[chave], caminhoAtual);
      }
    }
  }
  checar(obj, '');
  return encontrados;
}

module.exports = {
  UPCOMING_WINDOW_DAYS,
  TIPOS_RECOMPRA_V1,
  LABEL_OPORTUNIDADE,
  COR_OPORTUNIDADE,
  CAMPOS_BLOQUEADOS,
  labelOportunidade,
  corOportunidade,
  formatarDiasAteProximoCiclo,
  filtrarOrdenarFilaHoje,
  filtrarOrdenarProximosContatos,
  filtrarOrdenarProspeccao,
  extrairSinaisVisiveis,
  prepararDadosUI,
  prepararDadosUIProspect,
  verificarCamposBloqueados,
};
