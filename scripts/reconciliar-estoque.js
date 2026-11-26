#!/usr/bin/env node
'use strict';
// RECONCILIAÇÃO GestãoClick × MR4 Gestão — SOMENTE LEITURA. Roda DENTRO do Cloud Run Job mr4-sync-job (argumentos sobrescritos).
//
//   node scripts/reconciliar-estoque.js [--max-requisicoes=80] [--dias-vendas=30] [--dias-compras=90] [--pausa-ms=600]
//                                       [--max-itens=100] [--amostra-contagem=60] [--ignorar-trava]
//
// Lógica e garantias em functions/lib/estoqueReconciliacao.js. Termina com código 0 mesmo com erro (para o Job NÃO repetir as
// chamadas ao GestãoClick): confira a linha RECON_FIM (campo ok).
const gcHttp = require('../functions/lib/gcHttp');
const R = require('../functions/lib/estoqueReconciliacao');

const saida = linha => console.log(linha);
const encerrar = codigo => saida('RECON_FIM ' + JSON.stringify({ ok: false, abortado: codigo }));

async function principal(argv, env) {
  let opcoes;
  try { opcoes = R.lerOpcoes(argv); } catch (e) { encerrar(R.codigoSeguro(e)); return; }
  if (!env.GC_ACCESS_TOKEN || !env.GC_SECRET_ACCESS_TOKEN) { encerrar('CREDENCIAIS_AUSENTES'); return; }
  try {
    const { Firestore } = require('@google-cloud/firestore');
    await R.executarReconciliacao({ transporte: gcHttp.criarTransporteHttps(), credenciais: { access: env.GC_ACCESS_TOKEN, secret: env.GC_SECRET_ACCESS_TOKEN }, db: new Firestore({ projectId: 'mr4-ponto' }), opcoes, saida, ambiente: env });
  } catch (e) { encerrar(R.codigoSeguro(e)); }
}

if (require.main === module) principal(process.argv.slice(2), process.env);

module.exports = { ...R, principal };
