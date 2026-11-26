'use strict';
// PLANEJAMENTO DE COMPRA — atualização SEM TERMINAL da base do simulador (compras_sombra_14), pedida pela tela da gestão.
// Isolada do sync e da Política 1.2: só LÊ as coleções de Compras (e compras_origem) e só ESCREVE em compras_sombra_14.
// Qualquer falha preserva a base anterior (gravação em um único lote, depois de validar todos os documentos). Não cria pedido.
// Custo medido em 26/11/2026: cerca de 90 documentos lidos e 6 gravados por atualização; cresce 1 leitura por dia de saldo
// guardado, até o limite de 400 (os que o cálculo usa). Sem agenda: só roda quando a tela é aberta com dados mais novos ou no botão.
const { somarDias, dataComercial } = require('./canonico');
const S14 = require('./sombra14');
const { LOJA_ATIVA_ID } = require('../lojaAtiva');

const TRAVA = 'trava';
const TRAVA_MS = 5 * 60 * 1000;
const INTERVALO_MINIMO_MS = 2 * 60 * 1000;          // botão: não regrava uma base gerada há menos de 2 minutos
const COLECAO_ORIGEM = 'compras_origem';

const erro = codigo => Object.assign(new Error(codigo), { codigo });

/** Marcas da gestão sobre a origem das compras: false = não decide sozinha; true = origem confirmada. Sem documento = regra padrão. */
async function lerOrigem(db) {
  const snap = await db.collection(COLECAO_ORIGEM).get();
  const sem = [], com = [];
  for (const d of snap.docs) { const v = (d.data() || {}).usar_em_decisao_automatica; if (v === false) sem.push(d.id); else if (v === true) com.push(d.id); }
  return { sem, com, documentos: snap.size };
}

async function adquirirTrava(db, agora) {
  const ref = db.collection(S14.COLECAO).doc(TRAVA);
  const dono = agora.toISOString() + '-' + Math.floor(process.hrtime()[1]);
  return db.runTransaction(async tx => {
    const s = await tx.get(ref), atual = s.exists ? s.data() : null;
    if (atual && Date.parse(atual.expira_em) > agora.getTime()) return null;
    tx.set(ref, { dono, expira_em: new Date(agora.getTime() + TRAVA_MS).toISOString() });
    return dono;
  });
}
async function liberarTrava(db, dono) {
  const ref = db.collection(S14.COLECAO).doc(TRAVA);
  await db.runTransaction(async tx => { const s = await tx.get(ref); if (s.exists && s.data().dono === dono) tx.delete(ref); });
}

/**
 * @returns { status: 'ATUALIZADA' | 'JA_ATUALIZADA' | 'EM_ANDAMENTO' | 'SEM_DADOS_DE_COMPRAS' | 'SINCRONIZACAO_EM_ANDAMENTO', ... }
 */
async function atualizarBase(db, { forcar = false, agora = new Date() } = {}) {
  if (LOJA_ATIVA_ID !== '262759') throw erro('LOJA_INESPERADA');
  const ler = async (c, id) => (await db.collection(c).doc(id).get()).data() || null;
  const [n0, atual] = [await ler('compras_n0', 'meta'), await ler(S14.COLECAO, 'meta')];
  if (!n0 || !n0.data_comercial) return { status: 'SEM_DADOS_DE_COMPRAS' };
  const resumoAtual = atual ? { data_comercial: atual.data_comercial, gerado_em: atual.gerado_em } : {};
  if (atual && atual.formato === S14.FORMATO) {
    if (!forcar && atual.dados_gerados_em === (n0.ultima_sincronizacao_ok || null)) return { status: 'JA_ATUALIZADA', ...resumoAtual };
    const idade = agora.getTime() - Date.parse(atual.gerado_em);
    if (idade >= 0 && idade < INTERVALO_MINIMO_MS) return { status: 'JA_ATUALIZADA', recente: true, ...resumoAtual };
  }
  const dono = await adquirirTrava(db, agora);
  if (!dono) return { status: 'EM_ANDAMENTO', ...resumoAtual };
  try {
    const hoje = n0.data_comercial || dataComercial(agora);
    const entradas = await S14.lerEntradas(db, { snapshotsDesde: somarDias(hoje, -S14.DIAS_DE_SERIE) });
    const origem = await lerOrigem(db);
    const depois = await ler('compras_n0', 'meta');
    // o sync pode ter trocado a base no meio da leitura: não grava uma mistura
    if (!depois || (depois.ultima_sincronizacao_ok || null) !== (n0.ultima_sincronizacao_ok || null)) return { status: 'SINCRONIZACAO_EM_ANDAMENTO', ...resumoAtual };
    const res = S14.calcular(entradas, { config: { origem: { compras_sem_origem: origem.sem, compras_com_origem: origem.com } } });
    if (!res.itens.length) throw erro('BASE_VAZIA');                      // nunca substitui uma base boa por uma vazia
    const gravado = await S14.persistir(db, res, { agora });
    return { status: 'ATUALIZADA', data_comercial: res.hoje, gerado_em: agora.toISOString(), itens: res.itens.length, documentos_gravados: gravado.documentos, saldos_diarios_lidos: Object.keys(entradas.snapshots).length, marcas_de_origem: origem.documentos };
  } finally {
    await liberarTrava(db, dono).catch(() => {});                          // a trava também expira sozinha
  }
}

module.exports = { TRAVA, TRAVA_MS, INTERVALO_MINIMO_MS, COLECAO_ORIGEM, lerOrigem, atualizarBase };
