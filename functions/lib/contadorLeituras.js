'use strict';
/**
 * INF-11 — contador de leituras do Firestore POR EXECUÇÃO (estimativa do cobrado, feita no cliente): consulta = max(1, documentos
 * devolvidos); documento = 1; agregação count() = 1 a cada 1.000 entradas (mínimo 1); cada tentativa de transação conta de novo.
 * Guarda SOMENTE nomes de coleção e números. As referências continuam sendo as originais do SDK (instanceof preservado); apenas
 * a instância criada por este invólucro ganha um `get` contado.
 */
const DERIVAM = ['where', 'select', 'orderBy', 'limit', 'doc', 'count'];
const COL = Symbol('colecaoContada');

const custo = s => {
  if (s && Array.isArray(s.docs)) return Math.max(1, s.docs.length);
  if (s && s.exists === undefined && typeof s.data === 'function') return Math.max(1, Math.ceil((Number((s.data() || {}).count) || 0) / 1000));
  return 1;
};

function criarContador(store) {
  const porColecao = {}; let total = 0;
  const somar = (col, n) => { total += n; porColecao[col] = (porColecao[col] || 0) + n; };
  function instrumentar(obj, col) {
    obj[COL] = col;
    if (typeof obj.get === 'function') { const get = obj.get; obj.get = async (...a) => { const s = await get.apply(obj, a); somar(col, custo(s)); return s; }; }
    for (const m of DERIVAM) if (typeof obj[m] === 'function') { const f = obj[m]; obj[m] = (...a) => instrumentar(f.apply(obj, a), col); }
    return obj;
  }
  const contado = {
    collection: nome => instrumentar(store.collection(nome), String(nome)),
    doc: caminho => instrumentar(store.doc(caminho), String(caminho).split('/')[0]),
    runTransaction: (fn, ...resto) => store.runTransaction(tx => {
      const get = tx.get;
      tx.get = async (ref, ...a) => { const s = await get.call(tx, ref, ...a); somar((ref && ref[COL]) || 'transacao', custo(s)); return s; };
      return fn(tx);
    }, ...resto),
  };
  return { store: contado, resumo: () => ({ leituras: total, leiturasPorColecao: { ...porColecao } }) };
}
module.exports = { criarContador, custo };
