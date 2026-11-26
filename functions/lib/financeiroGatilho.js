'use strict';
/**
 * Gatilho do Financeiro (fin_n1) por evento de recebimento/pagamento — SÓ no modo ATIVO do webhook (aprovação do proprietário).
 * O evento nunca altera valores: apenas pede ao `financeiroSync` EXISTENTE (sync completo, com geração + ponteiro e trava própria) que rode antes das 3 h.
 *
 * ESTADO, não contador: guarda o horário do ÚLTIMO evento (máximo; fora de ordem não regride). A pendência só é baixada quando a geração
 * PUBLICADA em `fin_n1/active` tiver COMEÇADO depois desse horário (contrato de lib/financeiro: `publicado_em` = início da execução).
 * Enquanto não for: no máximo 1 pedido a cada INTERVALO_MIN_MS; com a trava do sync ativa nada é pedido (sairia por LOCK_ATIVO);
 * pedido que não resultar em publicação é repetido com espera dobrada, até MAX_TENTATIVAS (e TETO_DIARIO pedidos por dia).
 * Quem relê o estado depois da janela é a varredura agendada (`varrer`). O sync de 3 h continua como reconciliação e, ao publicar,
 * baixa a pendência ou zera as tentativas. Evento repetido é inócuo. Falha ao disparar não perde nada.
 *
 * Escreve SÓ em `gc_refresh_fila/financeiro_n1` (backend). Do Financeiro apenas LÊ o ponteiro e a trava.
 */
const COL = 'gc_refresh_fila', DOC = 'financeiro_n1';
const SOMENTE_LEITURA = Object.freeze({ ponteiro: ['fin_n1', 'active'], trava: ['fin_n1_ctl', 'lock'] });
const INTERVALO_MIN_MS = 30 * 60 * 1000;
const MARGEM_MS = 60 * 1000;                 // folga: a geração precisa começar ≥ 1 min depois do aviso
const MAX_TENTATIVAS = 5;                    // pedidos seguidos sem nenhuma publicação (esperas: 30, 60, 120, 180 e 180 min)
const ESPERA_MAX_MS = 3 * 3600 * 1000;
const TETO_DIARIO = 24;                      // cada pedido = sync completo (~890 GET ao GestãoClick)
const EVENTOS = ['recebimento.baixado', 'recebimento.estornado', 'pagamento.baixado', 'pagamento.estornado'];

const diaFortaleza = ms => new Date(ms - 3 * 3600000).toISOString().slice(0, 10);
const inicioPublicadoMs = ativo => { const t = ativo && ativo.publicado_em ? Date.parse(ativo.publicado_em) : NaN; return Number.isFinite(t) ? t : null; };
const cobre = (inicioMs, eventoMs) => inicioMs !== null && Number.isFinite(eventoMs) && inicioMs >= eventoMs + MARGEM_MS;
const travaAtiva = (trava, agoraMs) => !!trava && Date.parse(trava.expires_at) > agoraMs;

/** Decisão PURA sobre uma pendência. Devolve { estado, motivo }; motivo 'DISPARAR' já deixa o pedido reservado no estado. */
function decidir({ estado, ativo, trava, agoraMs, intervaloMs = INTERVALO_MIN_MS }) {
  const e = { ...estado };
  if (!e.pendente) return { estado: e, motivo: 'SEM_PENDENCIA' };
  if (!Number.isFinite(e.ultimoEventoMs)) e.ultimoEventoMs = agoraMs;
  const g = inicioPublicadoMs(ativo);
  if (cobre(g, e.ultimoEventoMs)) {
    Object.assign(e, { pendente: false, pendenteDesdeMs: null, tentativas: 0, proximaTentativaMs: 0, cobertoAteMs: g, geracaoConfirmada: ativo.geracao || null, confirmadoMs: agoraMs });
    return { estado: e, motivo: 'CONFIRMADO' };
  }
  if (cobre(g, e.pendenteDesdeMs)) e.pendenteDesdeMs = Math.min(g, e.ultimoEventoMs);           // parte antiga já coberta
  if (g !== null && e.ultimoPedidoMs && g >= e.ultimoPedidoMs) { e.tentativas = 0; e.proximaTentativaMs = 0; }   // o pedido foi atendido: não é falha
  if (travaAtiva(trava, agoraMs)) return { estado: e, motivo: 'AGUARDANDO_EXECUCAO' };
  if (e.ultimoPedidoMs && agoraMs - e.ultimoPedidoMs < intervaloMs) return { estado: e, motivo: 'AGUARDANDO_JANELA' };
  if (e.proximaTentativaMs && agoraMs < e.proximaTentativaMs) return { estado: e, motivo: 'AGUARDANDO_BACKOFF' };
  if ((e.tentativas || 0) >= MAX_TENTATIVAS) return { estado: e, motivo: 'ESGOTADO' };           // segue pendente; uma publicação (3 h) reabre
  const dia = diaFortaleza(agoraMs), noDia = e.dia === dia ? e.pedidosNoDia || 0 : 0;
  if (noDia >= TETO_DIARIO) return { estado: e, motivo: 'TETO_DIARIO' };
  const n = (e.tentativas || 0) + 1;
  Object.assign(e, { tentativas: n, ultimoPedidoMs: agoraMs, proximaTentativaMs: agoraMs + Math.min(intervaloMs * 2 ** (n - 1), ESPERA_MAX_MS), dia, pedidosNoDia: noDia + 1 });
  return { estado: e, motivo: 'DISPARAR' };
}

/**
 * Decide e grava numa transação SÓ do documento de controle: entre eventos simultâneos, apenas um reserva o pedido.
 * Ponteiro e trava do Financeiro são lidos FORA da transação (nunca disputam com o sync); leitura defasada só adia a confirmação.
 */
async function transicionar({ db, agoraMs, intervaloMs, preparar = d => d }) {
  const ref = db.collection(COL).doc(DOC);
  const ler = async ([c, d]) => { const s = await db.collection(c).doc(d).get(); return s.exists ? s.data() : null; };
  const [ativo, trava] = await Promise.all([ler(SOMENTE_LEITURA.ponteiro), ler(SOMENTE_LEITURA.trava)]);
  let saida;
  await db.runTransaction(async tx => {
    const s = await tx.get(ref); const anterior = s.exists ? s.data() : {};
    saida = decidir({ estado: preparar(anterior, ativo), ativo, trava, agoraMs, intervaloMs });
    if (JSON.stringify(saida.estado) !== JSON.stringify(anterior)) tx.set(ref, saida.estado);
  });
  return saida;
}

/** Dispara o pedido já reservado e anota o resultado. Falha não propaga: a pendência continua e a varredura repete. */
async function pedir({ db, disparar }) {
  let ok = true;
  try { await disparar(); } catch (_) { ok = false; }
  try {
    const ref = db.collection(COL).doc(DOC);
    await db.runTransaction(async tx => { const s = await tx.get(ref); if (s.exists) tx.set(ref, { ...s.data(), ultimoDisparoOk: ok }); });
  } catch (_) { /* anotação best-effort */ }
  return ok ? 'DISPARADO' : 'FALHA_DISPARO';
}

/** Chamado a cada evento financeiro. `eventoMs` = horário em que o receptor recebeu o aviso. */
async function solicitar({ db, evento, disparar, agoraMs = Date.now(), eventoMs, intervaloMs = INTERVALO_MIN_MS }) {
  if (!EVENTOS.includes(evento)) return { acao: 'IGNORADO' };
  const quando = Number.isFinite(eventoMs) ? eventoMs : agoraMs;
  let esteCoberto = false;
  const { motivo } = await transicionar({ db, agoraMs, intervaloMs, preparar: (d, ativo) => {
    const e = { ...d, eventos: (d.eventos || 0) + 1, ultimoEventoMs: Math.max(d.ultimoEventoMs || 0, quando) };
    const coberto = Math.max(inicioPublicadoMs(ativo) || 0, d.cobertoAteMs || 0) || null;
    esteCoberto = cobre(coberto, quando);                        // reentrega/atrasado já contido numa geração publicada
    if (!esteCoberto) { e.pendenteDesdeMs = d.pendente && Number.isFinite(d.pendenteDesdeMs) ? Math.min(d.pendenteDesdeMs, quando) : quando; e.pendente = true; }
    else e.pendente = !!d.pendente;
    return e;
  } });
  if (motivo === 'DISPARAR') return { acao: await pedir({ db, disparar }) };
  return esteCoberto ? { acao: 'JA_COBERTO' } : { acao: 'COALESCIDO', motivo };
}

/** Varredura periódica (borda final, retentativas e recuperação). Sem pendência: 1 leitura e nenhuma escrita. */
async function varrer({ db, disparar, agoraMs = Date.now(), intervaloMs = INTERVALO_MIN_MS }) {
  const s = await db.collection(COL).doc(DOC).get();
  if (!s.exists || !s.data().pendente) return { acao: 'SEM_PENDENCIA', estado: s.exists ? s.data() : null };
  const { estado, motivo } = await transicionar({ db, agoraMs, intervaloMs });
  if (motivo !== 'DISPARAR') return { acao: motivo, estado };
  const acao = await pedir({ db, disparar });
  return { acao, estado: { ...estado, ultimoDisparoOk: acao === 'DISPARADO' } };
}

module.exports = { solicitar, varrer, decidir, inicioPublicadoMs, EVENTOS, INTERVALO_MIN_MS, MARGEM_MS, MAX_TENTATIVAS, ESPERA_MAX_MS, TETO_DIARIO, COL, DOC };
