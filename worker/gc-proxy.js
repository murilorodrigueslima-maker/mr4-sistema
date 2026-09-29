/**
 * Cloudflare Worker — Proxy GestãoClick — DESATIVADO (SECURITY HOTFIX P0, 28/09/2026)
 *
 * A versão anterior repassava GET /vendas, /produtos, /pagamentos, /clientes e /recebimentos ao
 * GestãoClick com as credenciais da empresa, SEM autenticar o usuário (CORS padrão '*', filtro de
 * endpoint só por prefixo, query livre). Nenhuma tela do MR4 usa este proxy: as consultas ao
 * GestãoClick são feitas server-side pela Callable autenticada `gcQuery` (Firebase Functions) e pelo
 * sync agendado.
 *
 * Esta versão é fail-closed: responde 410 a qualquer requisição e nunca chama o GestãoClick, para que
 * uma publicação acidental (wrangler deploy) não exponha dados. O código antigo continua no histórico git.
 * Se o worker `gc-proxy-mr4` existir no painel Cloudflare, a ação recomendada é removê-lo (decisão
 * do responsável pela conta; não executado aqui).
 */

export default {
  async fetch() {
    return new Response(
      JSON.stringify({ error: 'gc-proxy desativado. Use a Callable autenticada gcQuery.' }),
      { status: 410, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } }
    );
  },
};
