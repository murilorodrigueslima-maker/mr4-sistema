'use strict';
/**
 * Etapa B — isolamento da loja para os clientes GC "próprios" (Compras, Financeiro, Painel, gcQuery).
 * Fonte única dos valores: lib/gcHttp (LOJA_ATIVA_ID = MR4 DISTRIBUIDORA 262759; FOCUS PARTS 424483 bloqueada).
 * Efeito: em /vendas, /pagamentos, /recebimentos e /produtos a consulta SEMPRE leva loja_id=262759; pedir outra loja lança erro.
 */
const { LOJA_ATIVA_ID, LOJAS_BLOQUEADAS, RECURSOS_COM_LOJA } = require('./gcHttp');

function erroLoja() { const e = new Error('GC_LOJA_NAO_AUTORIZADA'); e.codigo = 'GC_LOJA_NAO_AUTORIZADA'; return e; }

/** Recebe um objeto URL (já validado como api.gestaoclick.com) e o devolve com loja_id=262759 quando o recurso aceita loja. */
function aplicarLojaNaUrl(url) {
  const pedida = url.searchParams.get('loja_id');
  if (pedida !== null && (LOJAS_BLOQUEADAS.includes(pedida) || pedida !== LOJA_ATIVA_ID)) throw erroLoja();
  if (RECURSOS_COM_LOJA.includes(url.pathname)) url.searchParams.set('loja_id', LOJA_ATIVA_ID);
  return url;
}

/** Para construtores de query string (URLSearchParams) das operações do gcQuery. */
function aplicarLojaNosParams(params, recurso) {
  const pedida = params.get('loja_id');
  if (pedida !== null && (LOJAS_BLOQUEADAS.includes(pedida) || pedida !== LOJA_ATIVA_ID)) throw erroLoja();
  if (RECURSOS_COM_LOJA.includes(recurso)) params.set('loja_id', LOJA_ATIVA_ID);
  return params;
}

const NOME_LOJA_ATIVA = 'MR4 DISTRIBUIDORA';
const preenchido = v => v !== undefined && v !== null && String(v).trim() !== '';
const nomeNormalizado = v => String(v).normalize('NFD').replace(/[\u0300-\u036f]/g, '').replace(/\s+/g, ' ').trim().toUpperCase();

/** Registro de DETALHE que DECLARA outra loja (loja_id ou, sem ele, nome_loja). Registro sem declaração não é rejeitado. */
function declaraOutraLoja(registro) {
  const r = registro && (registro.Produto || registro);
  if (!r || typeof r !== 'object') return false;
  if (preenchido(r.loja_id)) return String(r.loja_id).trim() !== LOJA_ATIVA_ID;
  if (preenchido(r.nome_loja)) return nomeNormalizado(r.nome_loja) !== NOME_LOJA_ATIVA;
  return false;
}

module.exports = { LOJA_ATIVA_ID, aplicarLojaNaUrl, aplicarLojaNosParams, declaraOutraLoja };
