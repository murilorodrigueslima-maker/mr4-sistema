'use strict';
// AI GATEWAY — cliente da Responses API da OpenAI (Structured Outputs estrito). fetch INJETADO (testes nunca chamam a rede).
// store:false (não retém a resposta no provedor). A chave vem do Secret Manager via variável da Function; nunca é logada nem devolvida.
const MODELO_PADRAO = 'gpt-5.6-luna';   // o MESMO modelo já configurado nas fases N27–N33 (provider existente); não foi trocado por preferência.
const BASE_URL = 'https://api.openai.com/v1';
class ErroModelo extends Error { constructor(codigo, status) { super(codigo); this.codigo = codigo; this.status = status || null; } }

async function gerarEstruturado({ fetchImpl = fetch, apiKey, modelo = MODELO_PADRAO, instructions, input, schema, schemaName = 'agente_output', maxOutputTokens = 1200, timeoutMs = 25000, baseURL = BASE_URL }) {
  if (!apiKey) throw new ErroModelo('IA_NAO_CONFIGURADA');
  const ctl = new AbortController(); const timer = setTimeout(() => ctl.abort(), timeoutMs); const t0 = Date.now();
  let resp;
  try {
    resp = await fetchImpl(baseURL.replace(/\/$/, '') + '/responses', { method: 'POST', signal: ctl.signal, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + apiKey },
      body: JSON.stringify({ model: modelo, instructions, input, max_output_tokens: maxOutputTokens, store: false, text: { format: { type: 'json_schema', name: schemaName, strict: true, schema } } }) });
  } catch (e) { throw new ErroModelo(e && e.name === 'AbortError' ? 'TIMEOUT' : 'REDE'); } finally { clearTimeout(timer); }
  if (!resp.ok) { const st = resp.status; throw new ErroModelo(st === 429 ? 'RATE_LIMITED' : st === 401 || st === 403 ? 'NAO_AUTORIZADO' : st >= 500 ? 'ERRO_5XX' : 'ERRO_4XX', st); }   // corpo do erro NÃO é propagado
  let data; try { data = await resp.json(); } catch (_) { throw new ErroModelo('RESPOSTA_NAO_JSON'); }
  if (!data || data.error) throw new ErroModelo('ERRO_DO_PROVEDOR');
  if (data.status && data.status !== 'completed') throw new ErroModelo('RESPOSTA_INCOMPLETA');
  const msg = (data.output || []).find(o => o.type === 'message'); const bloco = msg && (msg.content || []).find(c => c.type === 'output_text');
  if (!bloco || typeof bloco.text !== 'string') throw new ErroModelo('SEM_OUTPUT_TEXT');
  if ((msg.content || []).some(c => c.type === 'refusal')) throw new ErroModelo('RECUSA_DO_MODELO');
  let json; try { json = JSON.parse(bloco.text); } catch (_) { throw new ErroModelo('JSON_INVALIDO'); }
  const u = data.usage || {};
  return { json, modelo: data.model || modelo, latenciaMs: Date.now() - t0, tokens: { input: u.input_tokens || 0, cachedInput: (u.input_tokens_details || {}).cached_tokens || 0, output: u.output_tokens || 0, reasoning: (u.output_tokens_details || {}).reasoning_tokens || 0 } };
}
module.exports = { MODELO_PADRAO, BASE_URL, ErroModelo, gerarEstruturado };
