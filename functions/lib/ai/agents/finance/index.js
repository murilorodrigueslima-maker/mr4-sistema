'use strict';
// AGENTE FINANCEIRO MR4 (agentType 'finance', módulo 'financeiro') — LEITURA · ANÁLISE · EXPLICAÇÃO · RECOMENDAÇÃO. Nenhum código de escrita (pagar, transferir, conciliar, editar, apagar, ERP).
// Reutiliza os fatos do Financeiro Fase 2 (geração ativa fin_n1); não altera o motor nem o módulo. Fluxo genérico: lib/ai/gateway/generic.js.
const G = require('../../gateway/generic');
const { criarSchemaAgente } = require('../../gateway/genericValidator');
const C = require('./contexto');
const P = require('./prompt');
const { validarFinanceiro } = require('./validacao');

/**
 * AUTORIZAÇÃO. Regra real do módulo (financeiro-v2.html + Rules): usuário ativo, perfil gestor|funcionario, não bloqueado e (admin=true OU módulo 'financeiro').
 * O agente é MAIS RESTRITO que o módulo: exige o módulo 'financeiro' explícito (admin=true sozinho NÃO basta; acesso CRM/Compras/Estoque ≠ Financeiro).
 * Piloto MANAGEMENT_ONLY: gestao = perfil 'gestor' (users.role) — funcionário com o módulo vê o painel, mas não o agente durante o piloto.
 */
async function autorizar(store, uid, falhaG) {
  const p = await G.perfilModulo(store, uid);
  if (p.role !== 'gestor' && p.role !== 'funcionario') falhaG('permission-denied', 'PERFIL_INVALIDO');
  if (!p.modulos.includes('financeiro')) falhaG('permission-denied', 'SEM_MODULO_FINANCEIRO');
  return { ...p, gestao: p.role === 'gestor' };
}

const agente = {
  agentType: 'finance', modulo: 'financeiro', generico: true, schemaName: 'agente_financeiro_resposta',
  perguntaResumo: 'Resumo financeiro: o que vence hoje, próximos 7 e 30 dias, vencidos, concentrações e o que merece atenção.',   // sem termos de caixa: a pergunta interna não pode acionar o classificador de pedido não atendível (as instruções já proíbem saldo/caixa)
  instructions: P.INSTRUCTIONS, motivos: P.MOTIVOS, acoes: P.ACOES, schema: criarSchemaAgente({ motivos: P.MOTIVOS, acoes: P.ACOES }), refPattern: /\b(?:G00[12]|[FC]\d{3})\b/g, rotulos: P.ROTULOS,
  avisoDesatualizado: 'Dados financeiros desatualizados: confira o ERP antes de decidir.',
  msgSemDados: 'O Financeiro ainda não tem dados sincronizados para analisar.',
  autorizar,
  carregar: async store => C.carregarFinanceiro(store),
  montar: (dados, acesso, pergunta, agoraIso) => G.ajustarAoLimite(e => C.montarComEscala(dados, e, pergunta, agoraIso), { alvoBytes: 22000 }),
  auditar: ctx => C.auditar(ctx),
  validacoesExtras: (resp, ctx) => validarFinanceiro(resp, ctx),
  apresentar: ({ ref }, montado) => {
    const m = montado.mapa[ref] || {}, e = (montado.contexto.entidades || {})[ref] || {};
    const evid = Object.keys(e).filter(k => k !== 'sinais' && e[k] != null).slice(0, 4).map(k => ({ metric: k, label: P.ROTULOS.metricas[k] || k, value: e[k] }));
    return { id: null, nome: m.nome || ref, tipo: m.tipo || null, reasonCodes: (e.sinais || []).map(c => ({ code: c, label: P.ROTULOS.motivos[c] || c })), evidence: evid };
  },
};
module.exports = { agente, autorizar };
