/**
 * Cloudflare Worker — Proxy GestãoClick
 *
 * Variáveis de ambiente (configurar no painel Cloudflare):
 *   GC_ACCESS_TOKEN        = seu access-token do GestãoClick
 *   GC_SECRET_ACCESS_TOKEN = seu secret-access-token do GestãoClick
 *   ALLOWED_ORIGIN         = https://murilorodrigueslima-maker.github.io  (ou * para qualquer origem)
 */

const GC_BASE = 'https://api.gestaoclick.com';

export default {
  async fetch(request, env) {

    // ── CORS preflight ────────────────────────────────────────────────────────
    const origin = request.headers.get('Origin') || '*';
    const corsHeaders = {
      'Access-Control-Allow-Origin':  env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type',
      'Access-Control-Max-Age':       '86400',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: corsHeaders });
    }

    if (request.method !== 'GET') {
      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    }

    // ── Valida tokens configurados ────────────────────────────────────────────
    if (!env.GC_ACCESS_TOKEN || !env.GC_SECRET_ACCESS_TOKEN) {
      return new Response(
        JSON.stringify({ error: 'Tokens GestãoClick não configurados no Worker' }),
        { status: 500, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    // ── Monta URL do GestãoClick ──────────────────────────────────────────────
    const url      = new URL(request.url);
    const endpoint = url.searchParams.get('endpoint') || '/vendas';
    const params   = url.searchParams.get('params')   || '';

    // Segurança: só permite endpoints do GC esperados
    const ENDPOINTS_PERMITIDOS = ['/vendas', '/produtos', '/pagamentos', '/clientes'];
    const baseEndpoint = endpoint.split('?')[0];
    if (!ENDPOINTS_PERMITIDOS.some(e => baseEndpoint.startsWith(e))) {
      return new Response(
        JSON.stringify({ error: 'Endpoint não permitido: ' + endpoint }),
        { status: 403, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const gcUrl = `${GC_BASE}${endpoint}${params ? '?' + params : ''}`;

    // ── Chama GestãoClick ─────────────────────────────────────────────────────
    let gcResp;
    try {
      gcResp = await fetch(gcUrl, {
        headers: {
          'access-token':        env.GC_ACCESS_TOKEN,
          'secret-access-token': env.GC_SECRET_ACCESS_TOKEN,
          'Content-Type':        'application/json',
        },
      });
    } catch (e) {
      return new Response(
        JSON.stringify({ error: 'Erro ao chamar GestãoClick: ' + e.message }),
        { status: 502, headers: { ...corsHeaders, 'Content-Type': 'application/json' } }
      );
    }

    const body = await gcResp.text();
    return new Response(body, {
      status: gcResp.status,
      headers: {
        ...corsHeaders,
        'Content-Type':  'application/json',
        'Cache-Control': 'no-store',
      },
    });
  },
};
