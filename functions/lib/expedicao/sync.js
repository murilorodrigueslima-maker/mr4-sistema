'use strict';
// MR4 — Expedição P0 · sync CENTRAL de pedidos novos (substitui o polling de 15 s de cada navegador).
// Uma execução agendada lê as vendas dos últimos 2 dias no GestãoClick (SOMENTE GET) e CRIA em expedicao_pedidos
// apenas os pedidos que ainda não existem — create-if-not-exists atômico (batch.create falha se já existir):
// nunca sobrescreve um pedido que outra tela já avançou. As telas recebem os novos pelo listener.
// Estado em expedicao_sync/estado: último sucesso (relógio do servidor) + números já vistos na janela, para
// criar só o que é novo (1 leitura + 1 escrita por execução, fora as criações).
const gcHttp = require('../gcHttp');   // Etapa A · A4: camada HTTP única
const JANELA_DIAS = 2;            // mesma janela que a tela usava (hoje e os 2 dias anteriores)
const LIMITE_PAGINA = 100;
const MAX_PAGINAS = 20;           // guarda contra laço infinito na paginação
const ALREADY_EXISTS = 6;         // código gRPC

function diaFortaleza(ms) { return new Date(ms).toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' }); }

/**
 * Leitor GC: só GET em /vendas no host oficial, via a camada HTTP única (lib/gcHttp — Etapa A · A4).
 * Resposta inválida, HTTP ≠ 200, 429/5xx (com retentativas controladas), paginação incompleta/repetida/circular ou excesso de
 * páginas LANÇAM erro sanitizado (código/caminho/página): nunca viram lista vazia/parcial. Quem chama não cria pedidos nem
 * grava `ultima_ok` em caso de erro. Janela sem vendas (resposta 200 válida e vazia) é um resultado legítimo.
 */
function criarLeitorVendas({ fetchImpl = globalThis.fetch, accessToken, secretToken, dormir } = {}) {
  if (!accessToken || !secretToken) { const e = new Error('SECRETS_GC_AUSENTES'); e.codigo = 'SECRETS_GC_AUSENTES'; throw e; }
  const cliente = gcHttp.criarCliente({ transporte: fetchImpl, credenciais: { access: accessToken, secret: secretToken }, dormir });
  return {
    chamadas: () => cliente.estatisticas().chamadas,
    async vendas(dataInicio, dataFim) {
      const r = await gcHttp.paginarCompleto(cliente, '/vendas', { data_inicio: dataInicio, data_fim: dataFim }, { limite: LIMITE_PAGINA, maxPaginas: MAX_PAGINAS, permitirVazio: true, exigirTotal: false });
      return r.itens;
    },
  };
}

/** `cadastrado_em` do GestãoClick ("AAAA-MM-DD HH:MM:SS", hora de Fortaleza) → ms; null se ausente, ilegível ou no futuro. */
function cadastroMs(s, agoraMs) {
  const m = /^(\d{4}-\d{2}-\d{2})[ T](\d{2}:\d{2}:\d{2})/.exec(String(s || ''));
  const t = m ? Date.parse(m[1] + 'T' + m[2] + '-03:00') : NaN;
  return Number.isFinite(t) && t <= agoraMs + 600000 ? t : null;
}

/** Mesmo documento que a tela antiga criava (compatível com o histórico), + versão 0, origem e horário da venda. */
function pedidoNovo(v, agoraMs, criadoEm) {
  const venda = cadastroMs(v.cadastradoEm, agoraMs);
  return {
    ...(venda != null ? { vendaCadastradaEm: venda } : {}),   // "venda recebida" (medição); telas antigas ignoram o campo
    numero: String(v.numero), data: v.data || diaFortaleza(agoraMs), hora: v.hora || '',
    ingresadoEm: agoraMs, movidoEm: agoraMs, coluna: 'ag',
    cliente: v.cliente || '—', vendedor: v.vendedor || '—', itens: Number(v.itens || 1), valor: Number(v.valor || 0), cidade: v.cidade || '',
    envio: null, saidaEm: null, versao: 0, ultimoEventoId: 'v0', criadoEm, origem: 'sync',
  };
}

/**
 * Uma execução. `dto` = normalizador oficial do gcQuery (LISTAR_VENDAS): mesma identidade (codigo || numero || id).
 * Devolve só contagens (sem cliente/valor).
 */
async function sincronizar({ db, leitor, dto, agora = new Date(), serverTimestamp }) {
  const agoraMs = agora.getTime();
  const fim = diaFortaleza(agoraMs), inicio = diaFortaleza(agoraMs - JANELA_DIAS * 86400000);
  const refEstado = db.collection('expedicao_sync').doc('estado');
  const estado = (await refEstado.get()).data() || {};
  const conhecidos = new Set(estado.numeros_recentes || []);
  const vendas = (await leitor.vendas(inicio, fim)).map(bruta => ({ ...dto(bruta), cadastradoEm: bruta && bruta.cadastrado_em })).filter(v => v.numero);
  const vistos = [...new Set(vendas.map(v => String(v.numero)))];
  let criados = 0, existentes = 0;
  for (const v of vendas) {
    const num = String(v.numero);
    if (conhecidos.has(num)) continue;
    conhecidos.add(num);
    const ref = db.collection('expedicao_pedidos').doc(num);
    const lote = db.batch();
    lote.create(ref, pedidoNovo(v, agoraMs, serverTimestamp()));
    lote.create(ref.collection('eventos').doc('v0'), { pedido: num, de: null, para: 'ag', acao: 'CRIAR', versao: 0, em: serverTimestamp(), por: 'sistema', origem: 'expedicaoSyncPedidos' });
    try { await lote.commit(); criados++; }
    catch (e) { if (e.code === ALREADY_EXISTS || /already exists/i.test(String(e.message))) existentes++; else throw e; }
  }
  await refEstado.set({ ultima_ok: serverTimestamp(), ultima_ok_ms: agoraMs, janela: { inicio, fim }, vendas_vistas: vistos.length, criados, existentes, chamadas_gc: leitor.chamadas(), numeros_recentes: vistos });
  return { criados, existentes, vendas_vistas: vistos.length, chamadas_gc: leitor.chamadas() };
}

module.exports = { JANELA_DIAS, criarLeitorVendas, pedidoNovo, sincronizar, diaFortaleza };
