// INF-02 — Fila/CRM ao vivo sem consultas repetidas: observa SÓ o sinalizador `crm_fila_versao/estado` (js/vivo.js) e chama o
// carregador da própria tela (crmConsulta, escopo no servidor) quando a versão muda.
// - listener funcionando: reconciliação a cada 15 min (cobre o que não sinaliza, ex.: sync de vendas, virada do dia);
// - listener indisponível: consulta a cada 5 min; carregamento com falha: repete em 1, 2, 4 e no máximo 5 min;
// - aba oculta: nenhuma consulta nem listener; ao voltar, recarrega só se estiver vencido (mudanças chegam pelo listener);
// - botão "Atualizar" = atualizar(). Nunca escreve nada.
import { observarAtualizacao } from './vivo.js';

export const PRAZOS = Object.freeze({ segurancaMs: 15 * 60000, lentoMs: 5 * 60000, repetirMs: 60000, agruparMs: 1500, tiqueMs: 30000 });
export const ROTULO_FILA = Object.freeze({ conectando: '… conectando', ao_vivo: '● ao vivo', pausado: '⏸ pausado',
  reconectando: '⚠ sem ao vivo · atualiza a cada 5 min', sem_permissao: '⚠ sem ao vivo · atualiza a cada 5 min' });

/**
 * carregar(): Promise — carregador da tela. Resolve com a `versao` recebida junto dos dados (undefined se o backend não a
 * informar) ou null quando falhou (a tela trata e exibe o próprio erro).
 * Devolve { atualizar, parar }. atualizar() resolve depois de um carregamento iniciado após o pedido.
 */
export function observarFila({ db, fns, carregar, aoStatus = () => {}, prazos = {} }) {
  const P = { ...PRAZOS, ...prazos };
  let emCurso = null, refazer = false, parado = false, falhas = 0, tentativaEm = 0, aoVivo = false;
  let naTela, visto, conferido = false, pararListener = null, timer = null;

  // versão exibida × versão vista pelo listener, uma única vez por assinatura (mudança entre o 1º carregamento e o listener)
  const conferir = () => {
    if (conferido || emCurso || naTela === undefined || visto === undefined) return;
    conferido = true;
    if (visto !== naTela) atualizar();
  };
  function atualizar() {
    if (emCurso) { refazer = true; return emCurso; }         // serializa: nunca duas consultas em paralelo
    emCurso = (async () => {
      do {
        refazer = false; tentativaEm = Date.now();
        let v = null;
        try { v = await carregar(); } catch (_) { v = null; }
        if (v === null) falhas++; else { falhas = 0; naTela = v; }
      } while (refazer && !parado);
    })().then(() => { emCurso = null; if (refazer && !parado) return atualizar(); conferir(); });   // pedido feito no último instante não se perde
    return emCurso;
  }
  const prazo = () => falhas ? Math.min(P.repetirMs * 2 ** (falhas - 1), P.lentoMs) : (aoVivo ? P.segurancaMs : P.lentoMs);
  const tique = () => { if (!parado && !document.hidden && !emCurso && Date.now() - tentativaEm >= prazo()) atualizar(); };
  const assinar = () => {
    conferido = false; visto = undefined;
    pararListener = observarAtualizacao({
      db, fns, colecao: 'crm_fila_versao', id: 'estado',
      marcador: d => { visto = String(d.versao || ''); return visto; },
      aoPrimeira: m => { visto = m; conferir(); },
      aoMudar: async () => {
        await new Promise(r => setTimeout(r, P.agruparMs));   // rajadas (ex.: job que libera várias reservas) viram uma consulta
        if (emCurso) await emCurso;
        if (parado || (naTela !== undefined && visto === naTela)) return;   // a tela já mostra essa versão (ex.: após a própria ação)
        await atualizar();
      },
      aoStatus: st => { if (st === 'ao_vivo') aoVivo = true; else if (st === 'reconectando' || st === 'sem_permissao') aoVivo = false; aoStatus(st); },
    });
  };
  const aoVoltar = () => { if (!document.hidden) tique(); };
  const aoSair = () => { clearInterval(timer); timer = null; };                 // vivo.js cancela o próprio listener
  const aoRestaurar = e => { if (e && e.persisted && !parado) { assinar(); timer = setInterval(tique, P.tiqueMs); atualizar(); } };   // voltar do cache do navegador
  const parar = () => {
    parado = true; aoSair(); if (pararListener) pararListener();
    document.removeEventListener('visibilitychange', aoVoltar); window.removeEventListener('pagehide', aoSair); window.removeEventListener('pageshow', aoRestaurar);
  };

  document.addEventListener('visibilitychange', aoVoltar); window.addEventListener('pagehide', aoSair); window.addEventListener('pageshow', aoRestaurar);
  assinar(); timer = setInterval(tique, P.tiqueMs);
  atualizar();
  return { atualizar, parar };
}
