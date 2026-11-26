#!/usr/bin/env node
'use strict';
// INVESTIGAÇÃO de compras no GestãoClick — SOMENTE LEITURA. Roda DENTRO do Cloud Run Job mr4-sync-job (argumentos sobrescritos).
//
//   node scripts/investigar-compras.js [--max-requisicoes=160] [--pausa-ms=600] [--dias-vendas=35] [--ano-inicial-titulos=2022]
//                                      [--vendas=ID+ID] [--produtos=ID+ID]
//
// Lógica e garantias em functions/lib/investigacaoCompras.js. Não usa Firestore. Termina com código 0 mesmo com erro (para o
// Job NÃO repetir as chamadas ao GestãoClick): confira a linha INVC_FIM (campo ok).
const gcHttp = require('../functions/lib/gcHttp');
const I = require('../functions/lib/investigacaoCompras');
const { codigoSeguro } = require('../functions/lib/estoqueReconciliacao');

const saida = linha => console.log(linha);
const encerrar = codigo => saida('INVC_FIM ' + JSON.stringify({ ok: false, abortado: codigo }));

async function principal(argv, env) {
  let opcoes;
  try { opcoes = I.lerOpcoes(argv); } catch (e) { encerrar(codigoSeguro(e)); return; }
  if (!env.GC_ACCESS_TOKEN || !env.GC_SECRET_ACCESS_TOKEN) { encerrar('CREDENCIAIS_AUSENTES'); return; }
  try {
    await I.executarInvestigacao({ transporte: gcHttp.criarTransporteHttps(), credenciais: { access: env.GC_ACCESS_TOKEN, secret: env.GC_SECRET_ACCESS_TOKEN }, opcoes, saida, ambiente: env });
  } catch (e) { encerrar(codigoSeguro(e)); }
}

if (require.main === module) principal(process.argv.slice(2), process.env);

module.exports = { principal };
