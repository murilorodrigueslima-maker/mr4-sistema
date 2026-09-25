'use strict';
// N35.14 / N35.17 — Configuração da Fila Comercial.
//
// N35.17: NÃO há lista de vendedores no código. Quem participa da Worklist é definido por
// CONFIGURAÇÃO em sistema_usuarios/{uid} (editável só por gestor; sem deploy):
//
//   filaComercial: {
//     ativo: true,                     // participa da worklist (recebe seus follow-ups/atendimentos)
//     recebeNovasOportunidades: true,  // recebe NOVAS oportunidades (false = pausa, ex.: férias)
//     limiteNovasPorDia: 10            // 1..MAX_NEW_OPPORTUNITY_CAP_PER_SELLER (padrão DAILY_NEW_OPPORTUNITY_CAP)
//   }
//
// Além da configuração, a permissão continua obrigatória no momento da geração:
// users.ativo, role=funcionario, não bloqueado, módulo fila-comercial-operar e sem fila-comercial-gestao.
const FILA_CONFIG_FIELD = 'filaComercial';

// D-CANARY: canários de validação — fora do ranking e fora do CAP.
const CANARY_OPPORTUNITY_IDS = Object.freeze([
  'f6f744b856019469',
  'a4ff158c667e74ef',
  'a31a49b109172b18',
  'c42a7af563da0a06',
]);

// N35.5 / N35.13: 11 grupos de CPF/CNPJ repetido no GestãoClick (22 IDs).
// Bloqueados da distribuição automática até resolução explícita. Não resolve a duplicidade.
const DUPLICATE_GC_GROUPS = Object.freeze([
  Object.freeze(['44553294', '47075044']),
  Object.freeze(['41390391', '48819286']),
  Object.freeze(['45230390', '47002389']),
  Object.freeze(['47559815', '47559728']),
  Object.freeze(['43866713', '44600329']),
  Object.freeze(['39574034', '48470542']),
  Object.freeze(['35644912', '41435102']),
  Object.freeze(['41602881', '45770079']),
  Object.freeze(['44934297', '42046160']),
  Object.freeze(['42049350', '45545210']),
  Object.freeze(['44785685', '49621556']),
]);

const DUPLICATE_GC_IDS = Object.freeze(DUPLICATE_GC_GROUPS.flat());

// N35.15 — Modo da geração diária da Worklist V2 (mudança exige commit + deploy):
//   OFF     — não gera nada
//   DRY_RUN — gera e grava SOMENTE fila_comercial/worklist_preview (não lido por claim nem pela tela)
//   LIVE    — grava fila_comercial/worklist (habilita criação lazy no claim e a tela da vendedora)
const WORKLIST_V2_MODE = 'DRY_RUN';

// Teto de consultas de nome ao GestãoClick por geração (só itens selecionados).
const MAX_NAME_LOOKUPS_PER_RUN = 40;

module.exports = {
  WORKLIST_V2_MODE,
  MAX_NAME_LOOKUPS_PER_RUN,
  FILA_CONFIG_FIELD,
  CANARY_OPPORTUNITY_IDS,
  DUPLICATE_GC_GROUPS,
  DUPLICATE_GC_IDS,
};
