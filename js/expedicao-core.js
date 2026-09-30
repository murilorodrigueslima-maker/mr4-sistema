// MR4 — Expedição · núcleo da máquina de estados (P0).
// Fonte única das transições usada pela página (expedicao.html) e pelos testes. As Firestore Rules espelham
// exatamente esta tabela (isValidExpeditionTransition) — a página é a primeira barreira, as Rules a garantia.
//
// Estados (campo expedicao_pedidos/{numero}.coluna):
//   ag = Aguardando Separação · se = Separando · pr = Pronto p/ Despacho · de = Despachado · cancelado
// Fluxo normal: ag → se → pr → de. Cancelar: ag|se|pr → cancelado. Despachado e Cancelado são terminais no
// fluxo normal. REABRIR (de → ag) é ação explícita: só gestor, motivo obrigatório, com evento de auditoria.
//
// Toda mudança de status é uma TRANSAÇÃO que:
//   1) lê o documento atual no servidor (nunca confia no estado da tela);
//   2) confere que ele está no estado que a tela acreditava (senão STALE_STATE — nada é gravado);
//   3) confere a transição na tabela;
//   4) grava só os campos da transição + versao+1 + ultimoEventoId + atualizadoEm (servidor) + atualizadoPor;
//   5) cria o evento imutável eventos/v{versao} no MESMO commit (exatamente um evento por transição).
(function (raiz) {
  'use strict';

  const COLUNAS = Object.freeze({ AG: 'ag', SE: 'se', PR: 'pr', DE: 'de', CANCELADO: 'cancelado' });
  const ATIVAS = Object.freeze(['ag', 'se', 'pr']);
  const ENVIOS = Object.freeze(['uber-mr4', 'uber-cliente', 'retirada', 'retirada-terc', 'rota-manha', 'rota-tarde']);
  const MOTIVO_MIN = 5, MOTIVO_MAX = 200;

  // Ações da tela → transição. `de` é o estado de origem exigido; nenhuma outra transição existe.
  const ACOES = Object.freeze({
    INICIAR_SEPARACAO: Object.freeze({ de: ['ag'], para: 'se', exige: ['envio'] }),
    MARCAR_SEPARADO:   Object.freeze({ de: ['se'], para: 'pr', exige: [] }),
    DESPACHAR:         Object.freeze({ de: ['pr'], para: 'de', exige: ['envio'] }),
    CANCELAR:          Object.freeze({ de: ['ag', 'se', 'pr'], para: 'cancelado', exige: [] }),
    REABRIR:           Object.freeze({ de: ['de'], para: 'ag', exige: ['motivo'], papel: 'gestor' }),
  });

  /** Tabela do fluxo normal (sem REABRIR). Espelhada nas Rules. */
  function isValidExpeditionTransition(de, para) {
    return (de === 'ag' && para === 'se') || (de === 'se' && para === 'pr') || (de === 'pr' && para === 'de') ||
      (ATIVAS.includes(de) && para === 'cancelado');
  }

  function erro(codigo, extra) { const e = new Error(codigo); e.codigo = codigo; Object.assign(e, extra || {}); return e; }

  /**
   * Planeja a transição sobre o estado ATUAL do servidor. Não grava nada.
   * @param atual   dados do documento lidos dentro da transação
   * @param esperado coluna que a tela acreditava (precondição)
   * @param acao    chave de ACOES
   * @param dados   { envio?, motivo? }
   * @param ctx     { uid, agoraMs, papel, origem, serverTimestamp }
   */
  function planejarTransicao(atual, esperado, acao, dados, ctx) {
    const def = ACOES[acao];
    if (!def) throw erro('ACAO_INVALIDA');
    if (!atual) throw erro('PEDIDO_NAO_ENCONTRADO');
    if (atual.coluna !== esperado) throw erro('STALE_STATE', { atual });
    if (!def.de.includes(atual.coluna)) throw erro('TRANSICAO_INVALIDA', { atual });
    if (acao !== 'REABRIR' && !isValidExpeditionTransition(atual.coluna, def.para)) throw erro('TRANSICAO_INVALIDA', { atual });
    if (def.papel === 'gestor' && ctx.papel !== 'gestor') throw erro('SEM_PERMISSAO');
    const d = dados || {};
    if (def.exige.includes('envio') && !ENVIOS.includes(d.envio)) throw erro('DADOS_INVALIDOS', { campo: 'envio' });
    const motivo = typeof d.motivo === 'string' ? d.motivo.trim() : '';
    if (def.exige.includes('motivo') && (motivo.length < MOTIVO_MIN || motivo.length > MOTIVO_MAX)) throw erro('DADOS_INVALIDOS', { campo: 'motivo' });
    if (!ctx.uid) throw erro('SEM_USUARIO');

    const versao = (Number(atual.versao) || 0) + 1;
    const eventoId = 'v' + versao;
    const ts = ctx.serverTimestamp();
    const agora = ctx.agoraMs;
    const update = { coluna: def.para, versao, ultimoEventoId: eventoId, atualizadoEm: ts, atualizadoPor: ctx.uid, movidoEm: agora };
    if (acao === 'INICIAR_SEPARACAO') update.envio = d.envio;
    if (acao === 'DESPACHAR') { update.envio = d.envio; update.saidaEm = agora; }
    if (acao === 'CANCELAR') update.canceladoEm = agora;
    if (acao === 'REABRIR') { update.envio = null; update.saidaEm = null; update.ingresadoEm = agora; update.reabertura = { motivo, por: ctx.uid, em: ts }; }
    const evento = { pedido: String(atual.numero), de: atual.coluna, para: def.para, acao, versao, em: ts, por: ctx.uid, origem: ctx.origem || 'expedicao' };
    if (acao === 'REABRIR') evento.motivo = motivo;
    return { update, eventoId, evento };
  }

  /**
   * Executa UMA ação como transação. Nada muda na tela antes da confirmação: o chamador só atualiza o estado
   * local a partir do listener (ou do `atual` devolvido em STALE_STATE, que é a verdade lida no servidor).
   * @param adapter { transacao(fn) } — fn recebe tx { ler(numero), atualizar(numero, campos), criarEvento(numero, id, dados) }
   */
  async function executarAcao(adapter, numero, acao, esperado, dados, ctx) {
    const num = String(numero);
    return adapter.transacao(async tx => {
      const atual = await tx.ler(num);
      const plano = planejarTransicao(atual, esperado, acao, dados, ctx);
      tx.atualizar(num, plano.update);
      tx.criarEvento(num, plano.eventoId, plano.evento);
      return { de: atual.coluna, para: plano.update.coluna, versao: plano.update.versao, eventoId: plano.eventoId };
    });
  }

  /** Início do dia comercial (America/Fortaleza, UTC−3 sem horário de verão) em ms. */
  function inicioDoDiaFortaleza(agoraMs) {
    const dia = new Date(agoraMs).toLocaleDateString('sv-SE', { timeZone: 'America/Fortaleza' });
    return Date.parse(dia + 'T00:00:00-03:00');
  }

  /** O que a tela operacional mostra: ativos (ag/se/pr) + despachados hoje. Cancelados nunca. */
  function noBoard(p, agoraMs) {
    if (!p) return false;
    if (ATIVAS.includes(p.coluna)) return true;
    return p.coluna === 'de' && typeof p.saidaEm === 'number' && p.saidaEm >= inicioDoDiaFortaleza(agoraMs);
  }

  const MENSAGEM = Object.freeze({
    STALE_STATE: 'foi atualizado em outra tela',
    TRANSICAO_INVALIDA: 'não pode fazer essa mudança a partir do estado atual',
    SEM_PERMISSAO: 'ação restrita a gestores',
    DADOS_INVALIDOS: 'dados incompletos',
    PEDIDO_NAO_ENCONTRADO: 'não foi encontrado',
  });

  const api = Object.freeze({ COLUNAS, ATIVAS, ENVIOS, ACOES, MOTIVO_MIN, MOTIVO_MAX, MENSAGEM, isValidExpeditionTransition, planejarTransicao, executarAcao, inicioDoDiaFortaleza, noBoard });
  if (typeof module === 'object' && module.exports) module.exports = api;
  else raiz.ExpedicaoCore = api;
})(typeof globalThis !== 'undefined' ? globalThis : this);
