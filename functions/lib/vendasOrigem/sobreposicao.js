'use strict';
/**
 * Sobreposição das vendas invalidadas na origem sobre a base do incremental de Compras.
 *
 * A base (compras_n0_base) NÃO é alterada: a marca é aplicada só em memória, no cálculo. Só vale no modo APLICAR, só para
 * invalidação ativa e só para registro que NÃO veio na leitura atual do GestãoClick (se voltou, vale o que a origem diz).
 * Fora do modo APLICAR: devolve null (uma leitura de documento; comportamento anterior idêntico).
 * Falha de leitura propaga: o incremental falha e preserva o último snapshot válido.
 */
const R = require('./regras');

async function lerInvalidacoes(db) {
  const s = await db.collection(R.COLECOES.config).doc(R.DOC_CONFIG).get();
  if (R.lerConfig(s.exists ? s.data() : null).modo !== 'APLICAR') return null;
  const q = await db.collection(R.COLECOES.candidatos).where('invalidacaoAtiva', '==', true).get();
  return new Map(q.docs.map(d => [String(d.data().vendaId), d.data().classe]));
}

/** PURA. { registros (cópia com as invalidadas marcadas), aplicadas } */
function sobrepor(registros, idsLidosAgora, invalidacoes) {
  let aplicadas = 0;
  if (!invalidacoes || !invalidacoes.size) return { registros, aplicadas };
  const out = registros.map(v => {
    const id = String(v.id);
    if (!invalidacoes.has(id) || idsLidosAgora.has(id)) return v;
    aplicadas++;
    return { ...v, nome_situacao: R.ROTULO_ESPELHO[invalidacoes.get(id)] || R.ROTULO_ESPELHO.NAO_ENCONTRADA, situacao_estoque: '0' };
  });
  return { registros: out, aplicadas };
}

module.exports = { lerInvalidacoes, sobrepor };
