'use strict';
/**
 * gcHttp — camada HTTP segura e paginação verificada para a API do GestãoClick.            (Etapa A · sub-etapa A0)
 *
 * NÃO está conectada a nenhum fluxo de produção nesta etapa (nenhum require em index.js/scripts). Só testes a usam.
 *
 * Princípios (diretrizes aprovadas):
 *  1. Resposta HTTP inválida INTERROMPE (nunca vira "lista vazia" ou "lista parcial").
 *  2. Paginação incompleta nunca é resultado completo: `paginarCompleto` devolve a lista INTEIRA ou lança erro.
 *  3. Cursor só avança com leitura completa, sem erro e com escritas confirmadas (`decidirCursor`).
 *  4. Limites de segurança (páginas/linhas) ABORTAM; nunca truncam.
 *  5. Vazio legítimo ≠ falha (formato comprovado ao vivo em 23/11/2026 com loja_id=262759):
 *       HTTP 200 + {code:200,status:"success",data:[],meta:{total_registros:null,total_paginas:null,
 *       total_registros_pagina:null,pagina_atual:1,limite_por_pagina:N,proxima_pagina:null,…}}.
 *     (`error` e `message` existem na raiz MESMO em sucesso e são ignorados.)
 *  6. Dados anteriores relevantes não são substituídos por vazio/queda sem validação (`avaliarPublicacao`).
 *
 * Segurança: só GET; só https://api.gestaoclick.com; redirecionamento bloqueado; credenciais só em cabeçalhos;
 * erros sanitizados (sem corpo bruto, sem credenciais, sem query string).
 */

const BASE = 'https://api.gestaoclick.com';

// ── Etapa B — ISOLAMENTO DE LOJA ─────────────────────────────────────────────────────────────────────────────────
// Só a loja ATIVA (MR4 DISTRIBUIDORA, loja_id=262759) é consultada. A FOCUS PARTS (424483) está desativada: nenhuma consulta nem
// importação. O valor fica em UM lugar; os recursos abaixo (os que aceitam `loja_id`) recebem o filtro automaticamente.
const LOJA_ATIVA_ID = '262759';
const LOJAS_BLOQUEADAS = Object.freeze(['424483']);
const RECURSOS_COM_LOJA = Object.freeze(['/vendas', '/pagamentos', '/recebimentos', '/produtos']);

const CODIGOS = Object.freeze({
  CREDENCIAIS_AUSENTES: 'GC_CREDENCIAIS_AUSENTES',
  CAMINHO_INVALIDO: 'GC_CAMINHO_INVALIDO',
  HOST_FORA_DO_GC: 'GC_HOST_FORA_DO_GC',
  REDIRECIONAMENTO: 'GC_REDIRECIONAMENTO',
  TIMEOUT: 'GC_TIMEOUT',
  REDE: 'GC_REDE',
  JSON_INVALIDO: 'GC_JSON_INVALIDO',
  RESPOSTA_INESPERADA: 'GC_RESPOSTA_INESPERADA',
  R429_ESGOTADO: 'GC_429_ESGOTADO',
  R429_RETRY_AFTER_ALTO: 'GC_429_RETRY_AFTER_EXCEDE_LIMITE',
  VAZIO_INESPERADO: 'GC_VAZIO_INESPERADO',
  PAGINACAO_INCOMPLETA: 'GC_PAGINACAO_INCOMPLETA',
  PAGINACAO_INCONSISTENTE: 'GC_PAGINACAO_INCONSISTENTE',
  PAGINACAO_REPETIDA: 'GC_PAGINACAO_REPETIDA',
  PAGINACAO_CIRCULAR: 'GC_PAGINACAO_CIRCULAR',
  PAGINACAO_SEM_TOTAL: 'GC_PAGINACAO_SEM_TOTAL',
  LIMITE_PAGINAS: 'GC_LIMITE_PAGINAS',
  LIMITE_LINHAS: 'GC_LIMITE_LINHAS',
  LOJA_NAO_AUTORIZADA: 'GC_LOJA_NAO_AUTORIZADA',
  LOJA_DIVERGENTE: 'GC_LOJA_DIVERGENTE',
});

/** Erro tipado e sanitizado: só código, status, caminho (sem query) e contagens. Nunca corpo bruto nem credenciais. */
class GcErro extends Error {
  constructor(codigo, detalhe, extra = {}) {
    super(detalhe ? `${codigo}: ${detalhe}` : codigo);
    this.name = 'GcErro';
    this.codigo = codigo;
    if (extra.status !== undefined) this.status = extra.status;
    if (extra.caminho !== undefined) this.caminho = extra.caminho;
    if (extra.tentativas !== undefined) this.tentativas = extra.tentativas;
    if (extra.retryAfterSeg !== undefined) this.retryAfterSeg = extra.retryAfterSeg;
    if (extra.pagina !== undefined) this.pagina = extra.pagina;
  }
  toJSON() { return { name: this.name, codigo: this.codigo, status: this.status, caminho: this.caminho, tentativas: this.tentativas, pagina: this.pagina }; }
}

const ehObjeto = x => x !== null && typeof x === 'object' && !Array.isArray(x);
const semQuery = caminho => String(caminho).split('?')[0];

/** Lê Retry-After (segundos inteiros ou data HTTP) → segundos, ou undefined. */
function lerRetryAfter(resp, agoraMs) {
  let v;
  try { v = resp.headers && typeof resp.headers.get === 'function' ? resp.headers.get('retry-after') : undefined; } catch (_) { v = undefined; }
  if (v === undefined || v === null || String(v).trim() === '') return undefined;
  const n = Number(v);
  if (Number.isFinite(n) && n >= 0) return Math.ceil(n);
  const t = Date.parse(String(v));
  return Number.isFinite(t) ? Math.max(0, Math.ceil((t - agoraMs) / 1000)) : undefined;
}

/**
 * Valida a ESTRUTURA de uma resposta 200.
 *  - tipo 'lista': {code/status de sucesso, data:[], meta:{}}; tipo 'detalhe': data objeto.
 *  - `code`/`status`, quando presentes, não podem contradizer sucesso; ao menos um deles deve indicar sucesso.
 *  - `error`/`message` na raiz são IGNORADOS (existem mesmo em sucesso).
 */
function validarEstrutura(json, tipo, caminho) {
  const falha = d => new GcErro(CODIGOS.RESPOSTA_INESPERADA, d, { caminho });
  if (!ehObjeto(json)) throw falha('raiz não é objeto');
  if ('code' in json && Number(json.code) !== 200) throw falha('code diferente de 200');
  if ('status' in json && json.status !== 'success') throw falha('status diferente de success');
  if (!(Number(json.code) === 200 || json.status === 'success')) throw falha('sem indicação de sucesso');
  if (tipo === 'detalhe') {
    if (!ehObjeto(json.data)) throw falha('data do detalhe não é objeto');
    return json;
  }
  if (!Array.isArray(json.data)) throw falha('data não é lista');
  if (!ehObjeto(json.meta)) throw falha('meta ausente ou inválido');
  return json;
}

/**
 * Transporte baseado em `https.get` (Node) com a interface mínima do fetch usada pelo cliente:
 * { status, ok, headers.get(), json() }. Usado pelos scripts do GitHub Actions (que já dependem de https.get).
 * `https.get` NUNCA segue redirecionamento: um 3xx volta como status e o cliente o recusa (GC_REDIRECIONAMENTO).
 * O `signal` (timeout) é repassado ao Node. Só https; qualquer outro protocolo é recusado.
 */
function criarTransporteHttps(httpsMod = require('https')) {
  return (url, opts = {}) => new Promise((resolve, reject) => {
    let u;
    try { u = new URL(url); } catch (_) { reject(new GcErro(CODIGOS.CAMINHO_INVALIDO, 'url inválida')); return; }
    if (u.protocol !== 'https:') { reject(new GcErro(CODIGOS.HOST_FORA_DO_GC, 'protocolo não https')); return; }
    const req = httpsMod.get(url, { headers: opts.headers, signal: opts.signal }, res => {
      const partes = [];
      res.on('data', c => partes.push(Buffer.isBuffer(c) ? c : Buffer.from(String(c))));
      res.on('error', reject);
      res.on('end', () => {
        const texto = Buffer.concat(partes).toString('utf8'); const status = res.statusCode;
        resolve({
          status, ok: status >= 200 && status < 300,
          headers: { get: k => { const v = res.headers && res.headers[String(k).toLowerCase()]; return Array.isArray(v) ? v[0] : (v === undefined ? null : v); } },
          json: async () => JSON.parse(texto),
        });
      });
    });
    req.on('error', reject);
  });
}

/**
 * Cliente GET seguro.
 * @param {object} o
 * @param {Function} o.transporte      (url, opts) → Promise<Response-like>   (padrão: fetch global)
 * @param {{access:string, secret:string}} o.credenciais
 * @param {number} [o.tentativas=3]    tentativas TOTAIS por requisição (inclui a primeira) — nunca ilimitadas
 * @param {number[]} [o.backoffMs=[2000,4000]]
 * @param {number} [o.retryAfterMaxMs=30000]  Retry-After maior que isso ⇒ aborta (não espera)
 * @param {number} [o.timeoutMs=20000]
 * @param {number} [o.pausaMs=0]       pausa após cada sucesso
 */
function criarCliente({ lojaId = LOJA_ATIVA_ID, transporte = (...a) => globalThis.fetch(...a), credenciais, tentativas = 3, backoffMs = [2000, 4000], retryAfterMaxMs = 30000, timeoutMs = 20000, pausaMs = 0, dormir, agora = () => Date.now() } = {}) {
  if (!credenciais || !credenciais.access || !credenciais.secret) throw new GcErro(CODIGOS.CREDENCIAIS_AUSENTES);
  if (!(Number.isInteger(tentativas) && tentativas >= 1 && tentativas <= 5)) throw new GcErro(CODIGOS.CAMINHO_INVALIDO, 'tentativas deve estar entre 1 e 5');
  const esperar = dormir || (ms => new Promise(r => setTimeout(r, ms)));
  const cabecalhos = { 'access-token': credenciais.access, 'secret-access-token': credenciais.secret, 'Content-Type': 'application/json' };
  const est = { chamadas: 0, retries: 0, esperaMs: 0, r429: 0 };

  async function get(caminho, params = {}, { tipo = 'lista' } = {}) {
    if (typeof caminho !== 'string' || !caminho.startsWith('/') || caminho.startsWith('//') || caminho.includes('?') || caminho.includes('..') || caminho.includes('#')) throw new GcErro(CODIGOS.CAMINHO_INVALIDO, 'caminho inválido');
    const url = new URL(BASE + caminho);
    for (const [k, v] of Object.entries(params || {})) if (v !== undefined && v !== null) url.searchParams.set(k, String(v));
    // Etapa B: loja explícita e única. Pedido de outra loja (ou de loja bloqueada) é RECUSADO; ausência vira a loja ativa.
    const pedida = url.searchParams.get('loja_id');
    if (pedida !== null && (LOJAS_BLOQUEADAS.includes(pedida) || (lojaId && pedida !== String(lojaId)))) throw new GcErro(CODIGOS.LOJA_NAO_AUTORIZADA, 'loja não autorizada', { caminho: semQuery(caminho) });
    if (lojaId && RECURSOS_COM_LOJA.includes(url.pathname)) url.searchParams.set('loja_id', String(lojaId));
    if (url.origin !== BASE || url.protocol !== 'https:') throw new GcErro(CODIGOS.HOST_FORA_DO_GC, 'host fora do GestãoClick', { caminho: semQuery(caminho) });
    const cam = url.pathname;

    let ultimo;
    for (let t = 1; t <= tentativas; t++) {
      est.chamadas++;
      let erro = null; let retriavel = false; let esperaPreferida;
      let resp;
      try { resp = await transporte(url.toString(), { method: 'GET', headers: cabecalhos, redirect: 'error', signal: AbortSignal.timeout(timeoutMs) }); }
      catch (e) {
        const msg = String((e && (e.cause && e.cause.message ? e.cause.message : e.message)) || '');
        if (/redirect/i.test(msg)) erro = new GcErro(CODIGOS.REDIRECIONAMENTO, 'redirecionamento bloqueado', { caminho: cam, tentativas: t });
        else if (e && (e.name === 'TimeoutError' || e.name === 'AbortError')) { erro = new GcErro(CODIGOS.TIMEOUT, 'tempo esgotado', { caminho: cam, tentativas: t }); retriavel = true; }
        else { erro = new GcErro(CODIGOS.REDE, 'falha de rede', { caminho: cam, tentativas: t }); retriavel = true; }
      }
      if (!erro) {
        const st = resp.status;
        if (st >= 300 && st < 400) erro = new GcErro(CODIGOS.REDIRECIONAMENTO, 'redirecionamento bloqueado', { status: st, caminho: cam, tentativas: t });
        else if (st === 429) {
          est.r429++;
          const ra = lerRetryAfter(resp, agora());
          if (ra !== undefined && ra * 1000 > retryAfterMaxMs) throw new GcErro(CODIGOS.R429_RETRY_AFTER_ALTO, `Retry-After de ${ra}s acima do limite`, { status: 429, caminho: cam, tentativas: t, retryAfterSeg: ra });
          erro = new GcErro(CODIGOS.R429_ESGOTADO, 'limite de requisições', { status: 429, caminho: cam, tentativas: t, retryAfterSeg: ra }); retriavel = true;
          esperaPreferida = ra !== undefined ? ra * 1000 : undefined;
        } else if (st >= 500) { erro = new GcErro(`GC_HTTP_${st}`, 'erro do servidor', { status: st, caminho: cam, tentativas: t }); retriavel = true; }
        else if (st !== 200) erro = new GcErro(`GC_HTTP_${st}`, 'resposta HTTP não aceita', { status: st, caminho: cam, tentativas: t });
        else {
          let json;
          try { json = await resp.json(); }
          catch (_) { erro = new GcErro(CODIGOS.JSON_INVALIDO, 'corpo não é JSON', { status: 200, caminho: cam, tentativas: t }); retriavel = true; }
          if (!erro) {
            try { validarEstrutura(json, tipo, cam); } catch (e) { e.tentativas = t; throw e; }   // estrutura inválida com 200: não repete
            if (pausaMs) await esperar(pausaMs);
            return json;
          }
        }
      }
      ultimo = erro;
      if (!retriavel) throw erro;
      if (t >= tentativas) throw erro;
      est.retries++;
      const espera = Math.min(esperaPreferida !== undefined ? esperaPreferida : backoffMs[Math.min(t - 1, backoffMs.length - 1)], retryAfterMaxMs);
      est.esperaMs += espera;
      await esperar(espera);
    }
    throw ultimo;
  }
  return { get, estatisticas: () => ({ ...est }) };
}

const idDe = r => (r && r.id !== undefined && r.id !== null ? String(r.id) : '');
const numeroOuNulo = v => (v === undefined || v === null ? null : Number(v));
const proximaDe = meta => {
  const v = meta.proxima_pagina;
  if (v === undefined || v === null || v === false) return null;
  const n = Number(v);
  return Number.isInteger(n) && n >= 1 ? n : NaN;
};

/**
 * Pagina até o fim e devolve a lista COMPLETA — ou lança erro. NUNCA devolve lista parcial.
 * @param {{get:Function}} cliente   resultado de criarCliente
 * @param {string} caminho           ex.: '/vendas'
 * @param {object} params            filtros (sem pagina/limite)
 * @param {object} [o]
 * @param {number} [o.limite=100]
 * @param {number} [o.maxPaginas=400]   trava: ABORTA (GC_LIMITE_PAGINAS) — nunca trunca
 * @param {number} [o.maxLinhas=Infinity] trava: ABORTA (GC_LIMITE_LINHAS) — nunca trunca
 * @param {boolean} [o.permitirVazio=false] vazio só é válido se o chamador disser que zero é um resultado possível
 * @param {boolean} [o.exigirTotal=true]   exige total_registros em resposta não vazia
 * @param {Function} [o.desembrulhar]      (registro) → registro (ex.: {Compra:{…}})
 */
async function paginarCompleto(cliente, caminho, params = {}, { limite = 100, maxPaginas = 400, maxLinhas = Infinity, permitirVazio = false, exigirTotal = true, desembrulhar = x => x } = {}) {
  const cam = semQuery(caminho);
  const inc = (cod, d, pagina) => new GcErro(cod, d, { caminho: cam, pagina });
  const registros = []; const vistos = new Set(); const visitadas = new Set();
  let pagina = 1, total = null, totalPaginas = null, limiteEfetivo = limite, assinaturaAnterior = null, paginasLidas = 0;

  for (;;) {
    if (pagina > maxPaginas) throw inc(CODIGOS.LIMITE_PAGINAS, `mais de ${maxPaginas} páginas (abortado, sem truncar)`, pagina);
    if (visitadas.has(pagina)) throw inc(CODIGOS.PAGINACAO_CIRCULAR, 'página já lida', pagina);
    visitadas.add(pagina);
    const json = await cliente.get(caminho, { ...params, pagina, limite }, { tipo: 'lista' });
    paginasLidas++;
    const meta = json.meta; const lista = json.data.map(desembrulhar);
    const totalDaPagina = numeroOuNulo(meta.total_registros);
    const prox = proximaDe(meta);
    if (Number.isNaN(prox)) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'proxima_pagina inválida', pagina);
    if (meta.pagina_atual !== undefined && meta.pagina_atual !== null && Number(meta.pagina_atual) !== pagina) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'pagina_atual diferente da solicitada', pagina);

    if (pagina === 1) {
      if (lista.length === 0) {
        // resposta vazia: só é "vazio legítimo" com HTTP 200 + estrutura válida + paginação consistente (sem próxima, total nulo/0)
        if (prox !== null) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'página 1 vazia com proxima_pagina', pagina);
        if (totalDaPagina !== null && totalDaPagina > 0) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'página 1 vazia com total_registros > 0', pagina);
        if (!permitirVazio) throw inc(CODIGOS.VAZIO_INESPERADO, 'resultado vazio não esperado para esta consulta', pagina);
        return { itens: [], vazio: true, paginas: 1, total: 0, duplicatas: 0 };
      }
      total = totalDaPagina;
      if (total === null && exigirTotal) throw inc(CODIGOS.PAGINACAO_SEM_TOTAL, 'resposta sem total_registros', pagina);
      if (total !== null && (!Number.isInteger(total) || total < lista.length)) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'total_registros inválido', pagina);
      const lim = numeroOuNulo(meta.limite_por_pagina); if (lim !== null && Number.isInteger(lim) && lim > 0) limiteEfetivo = lim;
      totalPaginas = numeroOuNulo(meta.total_paginas);
      if (totalPaginas !== null) {
        if (!Number.isInteger(totalPaginas) || totalPaginas < 1) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'total_paginas inválido', pagina);
        if (total !== null && totalPaginas !== Math.ceil(total / limiteEfetivo)) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'total_paginas não confere com total_registros', pagina);
        if (totalPaginas > maxPaginas) throw inc(CODIGOS.LIMITE_PAGINAS, `total_paginas ${totalPaginas} acima do limite ${maxPaginas} (abortado antes de ler)`, pagina);
      }
      if (total !== null && total > maxLinhas) throw inc(CODIGOS.LIMITE_LINHAS, `total_registros ${total} acima do limite ${maxLinhas} (abortado antes de ler)`, pagina);
    } else {
      if (lista.length === 0) throw inc(CODIGOS.PAGINACAO_INCOMPLETA, 'página vazia antes do fim esperado', pagina);
      if (total !== null && totalDaPagina !== null && totalDaPagina !== total) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'total_registros mudou durante a leitura', pagina);
    }

    const assinatura = `${idDe(lista[0])}|${idDe(lista[lista.length - 1])}`;
    if (assinatura === assinaturaAnterior) throw inc(CODIGOS.PAGINACAO_REPETIDA, 'página repetida', pagina);
    assinaturaAnterior = assinatura;
    for (const r of lista) {
      if (!idDe(r)) throw inc(CODIGOS.RESPOSTA_INESPERADA, 'registro sem id', pagina);
      // Etapa B: registro que declara OUTRA loja contamina o resultado ⇒ aborta a leitura inteira (nada é aproveitado).
      if (r && r.loja_id !== undefined && r.loja_id !== null && r.loja_id !== '' && String(r.loja_id) !== LOJA_ATIVA_ID) throw inc(CODIGOS.LOJA_DIVERGENTE, 'registro de loja diferente da ativa', pagina);
      registros.push(r);
    }
    if (registros.length > maxLinhas) throw inc(CODIGOS.LIMITE_LINHAS, `mais de ${maxLinhas} linhas (abortado, sem truncar)`, pagina);

    if (prox === null) {
      if (totalPaginas !== null && pagina < totalPaginas) throw inc(CODIGOS.PAGINACAO_INCOMPLETA, 'proxima_pagina nula antes de total_paginas', pagina);
      break;
    }
    if (prox !== pagina + 1) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'proxima_pagina não é a página seguinte', pagina);
    if (totalPaginas !== null && pagina >= totalPaginas) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, 'proxima_pagina além de total_paginas', pagina);
    pagina = prox;
  }

  // deduplica por id (mantém o de maior modificado_em quando existir)
  const mapa = new Map();
  for (const r of registros) { const k = idDe(r); const a = mapa.get(k); if (!a || String(r.modificado_em || '') > String(a.modificado_em || '')) mapa.set(k, r); }
  const itens = [...mapa.values()]; const duplicatas = registros.length - itens.length;
  if (total !== null) {
    if (itens.length < total) throw inc(CODIGOS.PAGINACAO_INCOMPLETA, `únicos (${itens.length}) menores que total_registros (${total})`);
    if (itens.length > total) throw inc(CODIGOS.PAGINACAO_INCONSISTENTE, `únicos (${itens.length}) maiores que total_registros (${total})`);
  }
  return { itens, vazio: false, paginas: paginasLidas, total, duplicatas };
}

/**
 * Detecta filtro de modificação IGNORADO: com `data_modificado_inicio=<dia>`, TODA linha deve ter
 * `modificado_em >= "<dia> 00:00:00"`. Qualquer linha anterior ⇒ a API ignorou (ou aplicou mal) o filtro.
 * (A proteção completa — alerta + abortar — é implementada na Etapa C; aqui só a verificação pura.)
 */
function verificarFiltroModificacao(itens, { pisoDia, campo = 'modificado_em' } = {}) {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(String(pisoDia || ''))) throw new GcErro(CODIGOS.CAMINHO_INVALIDO, 'pisoDia inválido');
  const piso = `${pisoDia} 00:00:00`; let violacoes = 0, semCampo = 0, primeira = null;
  for (const r of itens || []) { const v = r && r[campo]; if (v === undefined || v === null || v === '') { semCampo++; continue; } if (String(v) < piso) { violacoes++; if (primeira === null) primeira = String(v).slice(0, 10); } }
  return { honrado: violacoes === 0, filtroIgnorado: violacoes > 0, violacoes, semCampo, total: (itens || []).length, primeiraViolacaoDia: primeira };
}

/**
 * Decide se um resultado pode SUBSTITUIR o documento anterior (publicação de cache).
 * Regras: vazio ou queda acima do limite, havendo dado anterior relevante ⇒ NÃO publicar (exige validação adicional).
 * `limiteQuedaPct` é parametrizado para preservar os limites atuais (Financeiro 0,70; Pedidos 0,80); novos blocos: 0,70.
 */
function avaliarPublicacao({ novo, anterior, limiteQuedaPct = 0.70 } = {}) {
  if (!Number.isFinite(novo) || novo < 0) return { publicar: false, motivo: 'VALOR_NOVO_INVALIDO', quedaPct: null };
  if (anterior === null || anterior === undefined || !Number.isFinite(anterior) || anterior <= 0) return { publicar: true, motivo: 'SEM_REFERENCIA_ANTERIOR', quedaPct: null };
  const queda = (anterior - novo) / anterior;
  if (novo === 0) return { publicar: false, motivo: 'VAZIO_COM_DADOS_ANTERIORES', quedaPct: 1 };
  if (queda > limiteQuedaPct) return { publicar: false, motivo: 'QUEDA_ACIMA_DO_LIMITE', quedaPct: queda };
  return { publicar: true, motivo: 'OK', quedaPct: Math.max(0, queda) };
}

/**
 * Decide o cursor a persistir. O cursor só avança com leitura COMPLETA, sem erro e escritas confirmadas.
 * Qualquer outra situação devolve o cursor ATUAL (inalterado).
 */
function decidirCursor({ cursorAtual = null, novoCursor = null, leituraCompleta = false, erro = null, escritasConfirmadas = false } = {}) {
  const pode = leituraCompleta === true && !erro && escritasConfirmadas === true && typeof novoCursor === 'string' && novoCursor !== '' && (cursorAtual === null || novoCursor >= cursorAtual);
  return { cursor: pode ? novoCursor : cursorAtual, avancou: pode && novoCursor !== cursorAtual };
}

/**
 * A2.1 — Decide se um resultado VAZIO de Pedidos (janela curta, ex.: 3 dias) é ausência LEGÍTIMA de vendas
 * (feriado prolongado, loja sem movimento) e não falha da API. Só aceita com CORROBORAÇÃO INDEPENDENTE no mesmo ciclo:
 * a leitura de vendas dos últimos 30 dias (mesmo endpoint, mesmo escopo, período que COBRE a janela de Pedidos) concluída
 * com integridade e sem nenhuma venda dentro da janela de Pedidos. Qualquer dúvida ⇒ NÃO aceita (preserva o último válido).
 * Pré-condições já garantidas por paginarCompleto: HTTP 200, estrutura válida, paginação consistente (vazio sem próxima página,
 * sem total > 0). Função PURA.
 * @param {{vendas30:{integra:boolean,escopo:string,inicio:string,fim:string,datas:string[],semData:number}|null,
 *          janela:{escopo:string,inicio:string,fim:string}}} p
 */
function avaliarVazioPedidos({ vendas30, janela } = {}) {
  const nao = motivo => ({ aceitar: false, motivo });
  const dia = x => typeof x === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(x);
  if (!vendas30 || vendas30.integra !== true) return nao('VENDAS30_NAO_INTEGRA');
  if (!janela || !dia(janela.inicio) || !dia(janela.fim) || !dia(vendas30.inicio) || !dia(vendas30.fim)) return nao('PERIODO_INVALIDO');
  if (!vendas30.escopo || vendas30.escopo !== janela.escopo) return nao('ESCOPO_INCOMPATIVEL');
  if (vendas30.inicio > janela.inicio || vendas30.fim < janela.fim) return nao('PERIODO_INCOMPATIVEL');
  if (!Array.isArray(vendas30.datas) || vendas30.datas.length === 0) return nao('VENDAS30_VAZIA');
  if (vendas30.semData > 0) return nao('VENDAS30_SEM_DATA');
  if (vendas30.datas.some(d => !dia(d))) return nao('VENDAS30_DATA_INVALIDA');
  if (vendas30.datas.some(d => d >= janela.inicio && d <= janela.fim)) return nao('INCONSISTENTE_VENDAS_NA_JANELA_DE_PEDIDOS');
  return { aceitar: true, motivo: 'OK_CORROBORADO' };
}

module.exports = { LOJA_ATIVA_ID, LOJAS_BLOQUEADAS, RECURSOS_COM_LOJA, BASE, CODIGOS, GcErro, criarCliente, criarTransporteHttps, paginarCompleto, validarEstrutura, verificarFiltroModificacao, avaliarPublicacao, avaliarVazioPedidos, decidirCursor };
