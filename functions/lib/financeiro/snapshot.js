'use strict';
// AGENTE FINANCEIRO MR4 — Fase 1 · Snapshot, frescor e persistência (Firestore protegido; nada público).
//
// Armazenamento (menor privilégio; Rules: leitura só com módulo financeiro; escrita só Admin SDK):
//   fin_n1/resumo                 agregados por natureza (quantidades, totais, buckets, janelas, planos, formas, concentração
//                                 por ID de entidade) — SEM nomes de pessoas/empresas, SEM IDs de títulos
//   fin_n1/auditoria              agregado → IDs dos títulos participantes (para investigar divergências)
//   fin_n1/meta                   frescor: última sincronização com sucesso, última tentativa, erro, estatísticas do fetch
//   fin_n1_titulos_abertos/{n}    detalhe dos títulos ABERTOS (inclui nome da entidade), em blocos ≤ 400 títulos
// Sem arquivo JSON público. O frontend lê só o que precisa (resumo; detalhe sob demanda).

const { dataComercial, mapearTitulo } = require('./canonico');
const { calcularNatureza, status } = require('./motor');

const VERSAO = 'fin-n1-1';
const LIMIAR_STALE_HORAS = 6;       // sync nominal a cada 2 h + atrasos observados do agendador (≈ até 5 h)
const BLOCO_TITULOS = 400;

const METRICAS_BLOQUEADAS = ['SALDO_DISPONIVEL', 'SALDO_BANCARIO', 'CAIXA_REAL', 'CAIXA_PARA_COMPRAS', 'CAPACIDADE_DE_COMPRA', 'RUNWAY', 'FREE_CASH', 'PROJECAO_DE_CAIXA'];
const LIMITACOES = [
  'REAL_BANK_BALANCE_AVAILABLE=NO — nenhuma fonte de saldo bancário; posição de títulos NÃO é caixa',
  'PARTIAL_SETTLEMENT_SUPPORT=UNPROVEN — a API não informa valor pago/saldo restante; cada título é tratado como integral',
  'SETTLEMENT_AMOUNT é derivado (= valor final do título liquidado), não um registro de baixa',
  'LIQUIDADO = baixa registrada no ERP, não extrato bancário',
  'TITULO VENCIDO ≠ CLIENTE INADIMPLENTE — nenhuma classificação comportamental',
  'PAYABLE_TO_PURCHASE_LINK=NO',
];

/** Frescor a partir do último sucesso. */
function frescor(ultimoSucessoISO, agora = new Date(), limiarHoras = LIMIAR_STALE_HORAS) {
  if (!ultimoSucessoISO) return { estado: 'UNAVAILABLE', idade_min: null, limiar_horas: limiarHoras };
  const idade = Math.round((agora.getTime() - new Date(ultimoSucessoISO).getTime()) / 60000);
  return { estado: idade <= limiarHoras * 60 ? 'CURRENT' : 'STALE', idade_min: idade, limiar_horas: limiarHoras };
}

const semIds = ag => ({ quantidade: ag.quantidade, total_cents: ag.total_cents });
function resumoNatureza(r) {
  const mapa = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, semIds(v)]));
  return {
    contagem_status: r.contagem_status,
    abertos: semIds(r.abertos),
    buckets_exclusivos: mapa(r.buckets),
    janelas_acumuladas_sem_vencidos: mapa(r.janelas),
    vencido_mais_60d: semIds(r.vencido_mais_60d),
    liquidado: mapa(r.liquidado),
    por_plano: r.por_plano.map(p => ({ plano_id: p.plano_id, plano_nome: p.plano_nome, aberto: semIds(p.aberto), liquidado_30d: semIds(p.liquidado_30d) })),
    por_forma: r.por_forma.map(f => ({ raw: f.raw, normalizada: f.normalizada, ambigua: f.ambigua, aberto: semIds(f.aberto), liquidado_30d: semIds(f.liquidado_30d) })),
    concentracao: r.concentracao.map(e => ({ entity_type: e.entity_type, entity_id: e.entity_id, aberto: semIds(e.aberto), vencido: semIds(e.vencido), participacao_pct: e.participacao_pct })),
    recorrencia_candidata: r.recorrencia_candidata.map(x => ({ chave: x.chave, plano: x.plano, meses_distintos: x.meses_distintos, quantidade: x.ids.length })),
    desconhecidos: r.desconhecidos.length,
  };
}
function auditoriaNatureza(r) {
  const ids = o => Object.fromEntries(Object.entries(o).map(([k, v]) => [k, v.ids]));
  return {
    abertos: r.abertos.ids, buckets_exclusivos: ids(r.buckets), janelas: ids(r.janelas), vencido_mais_60d: r.vencido_mais_60d.ids,
    liquidado: ids(r.liquidado), maiores: r.maiores.map(m => m.id), desconhecidos: r.desconhecidos,
  };
}

/**
 * Monta o snapshot a partir dos títulos brutos (já deduplicados pelo fetch).
 * @returns { resumo, auditoria, titulosAbertos, meta }
 */
function montarSnapshot({ brutosPagar, brutosReceber, refs, agora = new Date(), estatisticas = {} }) {
  const hoje = dataComercial(agora);
  const syncedAt = agora.toISOString();
  const canon = [
    ...brutosPagar.map(b => mapearTitulo(b, 'PAGAR', { formasPorId: refs.formasPorId, syncedAt })),
    ...brutosReceber.map(b => mapearTitulo(b, 'RECEBER', { formasPorId: refs.formasPorId, syncedAt })),
  ];
  const pagar = calcularNatureza(canon, 'PAGAR', hoje), receber = calcularNatureza(canon, 'RECEBER', hoje);
  const abertos = canon.filter(t => ['OVERDUE', 'DUE_TODAY', 'FUTURE'].includes(status(t, hoje).status));
  const maisAntigo = nat => abertos.filter(t => t.natureza === nat).map(t => t.due_date).sort()[0] || null;
  return {
    resumo: {
      versao: VERSAO, gerado_em: syncedAt, data_comercial: hoje, fuso: 'America/Fortaleza',
      pagar: resumoNatureza(pagar), receber: resumoNatureza(receber),
      vencimento_aberto_mais_antigo: { pagar: maisAntigo('PAGAR'), receber: maisAntigo('RECEBER') },
      metricas_bloqueadas: METRICAS_BLOQUEADAS, limitacoes: LIMITACOES,
    },
    auditoria: { versao: VERSAO, gerado_em: syncedAt, pagar: auditoriaNatureza(pagar), receber: auditoriaNatureza(receber) },
    titulosAbertos: abertos.map(t => ({ ...t, status: status(t, hoje).status })),
    meta: { versao: VERSAO, ultima_sincronizacao_ok: syncedAt, data_comercial: hoje, estatisticas },
  };
}

/** Persiste o snapshot (Admin SDK) em UM lote atômico: resumo, auditoria, meta e blocos de títulos mudam juntos.
 *  Blocos excedentes de uma versão anterior são apagados só depois do commit (resumo.blocos_titulos diz quantos ler). */
async function persistirSnapshot(db, snap) {
  const blocos = [];
  for (let i = 0; i < snap.titulosAbertos.length; i += BLOCO_TITULOS) blocos.push(snap.titulosAbertos.slice(i, i + BLOCO_TITULOS));
  const lote = db.batch();
  blocos.forEach((b, i) => lote.set(db.collection('fin_n1_titulos_abertos').doc('bloco_' + String(i).padStart(3, '0')), { gerado_em: snap.meta.ultima_sincronizacao_ok, indice: i, titulos: b }));
  lote.set(db.collection('fin_n1').doc('auditoria'), snap.auditoria);
  lote.set(db.collection('fin_n1').doc('resumo'), { ...snap.resumo, blocos_titulos: blocos.length });
  lote.set(db.collection('fin_n1').doc('meta'), { ...snap.meta, ultima_tentativa: snap.meta.ultima_sincronizacao_ok, ultima_tentativa_ok: true, erro: null });
  await lote.commit();
  const antigos = await db.collection('fin_n1_titulos_abertos').get();
  for (const d of antigos.docs) if (Number(d.id.replace('bloco_', '')) >= blocos.length) await d.ref.delete();
}

/**
 * Executa uma sincronização completa. Se QUALQUER etapa falhar (GC fora, janela incompleta, erro de dado),
 * NÃO toca resumo/auditoria/títulos: só registra a tentativa com erro no meta (último snapshot válido preservado).
 */
async function executarSync({ cli, db, agora = new Date(), inicio = '2015-01-01', horizonteDias = 730, fetchMod = require('./fetch') }) {
  const hoje = dataComercial(agora);
  const [y, m, d] = hoje.split('-').map(Number);
  const fim = new Date(Date.UTC(y, m - 1, d + horizonteDias)).toISOString().slice(0, 10);
  try {
    const refs = await fetchMod.buscarReferencias(cli);
    const ap = await fetchMod.buscarTitulos(cli, 'pagamentos', { inicio, fim });
    const ar = await fetchMod.buscarTitulos(cli, 'recebimentos', { inicio, fim });
    const snap = montarSnapshot({ brutosPagar: ap.titulos, brutosReceber: ar.titulos, refs, agora, estatisticas: { pagar: ap.estatisticas, receber: ar.estatisticas, janela: { inicio, fim } } });
    await persistirSnapshot(db, snap);
    return { ok: true, snapshot: snap };
  } catch (e) {
    const metaRef = db.collection('fin_n1').doc('meta');
    const anterior = (await metaRef.get()).data() || {};
    await metaRef.set({ ...anterior, ultima_tentativa: agora.toISOString(), ultima_tentativa_ok: false, erro: String(e.codigo || e.message).slice(0, 200) });
    return { ok: false, erro: e.message };
  }
}

module.exports = { VERSAO, LIMIAR_STALE_HORAS, METRICAS_BLOQUEADAS, LIMITACOES, frescor, montarSnapshot, persistirSnapshot, executarSync };
