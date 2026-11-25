'use strict';
/**
 * Handlers do módulo Integrações e Credenciais (GestãoClick API, Webhooks, acompanhamento do Google Cloud).
 * Todas as dependências externas são injetadas (testáveis com credenciais fictícias). NENHUM handler devolve valor de segredo.
 * Segurança: exigirMaster (backend) em TODA operação; reautenticação recente + limite de requisições nas operações com segredo; auditoria sem valores.
 */
const crypto = require('crypto');
const N = require('./nucleo');
const GC = require('../gcHttp');
const { SEGREDOS } = require('./secretManager');
const { IntErro, exigirMaster, limitar, auditar, valorValido } = N;

const LOJA = { id: GC.LOJA_ATIVA_ID, nome: 'MR4 DISTRIBUIDORA' };
const URL_RECEPTOR = 'https://southamerica-east1-mr4-ponto.cloudfunctions.net/webhookGestaoClick';
const MODOS = ['DESLIGADO', 'RECEPCAO', 'SOMBRA', 'ATIVO'];
const TRANSICOES = { DESLIGADO: ['RECEPCAO'], RECEPCAO: ['DESLIGADO', 'SOMBRA'], SOMBRA: ['DESLIGADO', 'RECEPCAO', 'ATIVO'], ATIVO: ['DESLIGADO', 'RECEPCAO', 'SOMBRA'] };
const FRASE_ATIVAR = 'ATIVAR WEBHOOKS EM PRODUCAO';
const PROJETO_GCP = 'mr4-ponto', REGIAO = 'southamerica-east1', JOB = 'mr4-sync-job';
const SCHEDULERS = ['mr4-sync-job-2h', 'mr4-sync-job-estoque-30m'];

const sensivel = { reauth: true };
const estadoRef = (db, id) => db.collection('integracoes_estado').doc(id);

/** Teste de conexão com a loja ativa (somente GET, loja 262759; recusa qualquer divergência de loja). Nunca devolve valores. */
async function testarConexaoGc({ access, secret, transporte }) {
  if (!valorValido(access) || !valorValido(secret)) return { ok: false, codigo: 'FORMATO_INVALIDO' };
  let cli; try { cli = GC.criarCliente({ credenciais: { access, secret }, transporte, tentativas: 1, timeoutMs: 15000 }); } catch (_) { return { ok: false, codigo: 'CREDENCIAIS_AUSENTES' }; }
  try {
    const j = await cli.get('/vendas', { limit: 1, loja_id: LOJA.id });
    const itens = Array.isArray(j && j.data) ? j.data : [];
    if (itens.some(v => v && v.loja_id !== undefined && String(v.loja_id) !== LOJA.id)) return { ok: false, codigo: 'LOJA_DIVERGENTE' };
    return { ok: true, codigo: 'CONEXAO_OK' };
  } catch (e) {
    const st = e && e.status;
    return { ok: false, codigo: st === 401 || st === 403 ? 'CREDENCIAIS_RECUSADAS' : (e && e.codigo === GC.CODIGOS.LOJA_NAO_AUTORIZADA ? 'LOJA_NAO_AUTORIZADA' : 'FALHA_CONEXAO') };
  }
}

function criarHandlers(dep) {
  const { db, sm, transporteGc, requisitarGcp, fetchReceptor = (u, o) => fetch(u, o), agora = () => Date.now() } = dep;

  async function executar({ auth, acao, integracao, opcoes = {}, limite }, fn) {
    const t = agora(); const { uid } = await exigirMaster({ db, auth, agoraMs: t, reauth: !!opcoes.reauth });
    if (limite) await limitar({ db, uid, chave: limite.chave, max: limite.max, janelaMs: limite.janelaMs, agoraMs: t });
    try { const r = await fn({ uid, t }); if (acao) await auditar({ db, uid, integracao, acao, resultado: r && r.ok === false ? 'FALHA' : 'OK', codigo: r && r.codigo, agoraMs: t }); return r; }
    catch (e) { if (acao) await auditar({ db, uid, integracao, acao, resultado: 'FALHA', codigo: (e && e.code && /^[A-Z0-9_]+$/.test(e.code)) ? e.code : 'ERRO_INTERNO', agoraMs: t }); throw e; }
  }
  // negativas de acesso também são auditadas (sem revelar nada)
  async function guardar(auth, acao, integracao, opcoes, fn, limite) {
    try { return await executar({ auth, acao, integracao, opcoes, limite }, fn); }
    catch (e) { if (acao && e instanceof IntErro && e.code === 'permission-denied' && auth && auth.uid) await auditar({ db, uid: auth.uid, integracao, acao: acao || 'acesso', resultado: 'NEGADO', codigo: 'NAO_MASTER', agoraMs: agora() }); throw e; }
  }

  const infoSegredo = async nome => { const v = await sm.versoes(nome); const ativas = v.filter(x => x.estado === 'ENABLED'); return { cadastrado: ativas.length > 0, atualizadoEm: ativas[0] ? ativas[0].criadaEm : null, versaoAtual: ativas[0] ? ativas[0].n : null, versoesAtivas: ativas.length }; };

  // ─────────────── STATUS (somente leitura) ───────────────
  async function status({ auth }) {
    return guardar(auth, null, 'GOOGLE_CLOUD', {}, async () => {
      const [a, s, w] = await Promise.all([infoSegredo(SEGREDOS.GC_ACCESS), infoSegredo(SEGREDOS.GC_SECRET), infoSegredo(SEGREDOS.WEBHOOK)]);
      const [estGc, estWh, cfgWh, hb] = await Promise.all([estadoRef(db, 'gestaoclick').get(), estadoRef(db, 'webhook').get(), db.collection('gc_webhook_config').doc('estado').get(), db.collection('gc_sync_status').doc('ultima').get()]);
      const eg = estGc.exists ? estGc.data() : {}, ew = estWh.exists ? estWh.data() : {}, modo = cfgWh.exists && MODOS.includes(cfgWh.data().modo) ? cfgWh.data().modo : 'DESLIGADO';
      const gc = { loja: LOJA, accessCadastrado: a.cadastrado, secretCadastrado: s.cadastrado, atualizadoEm: [a.atualizadoEm, s.atualizadoEm].filter(Boolean).sort().pop() || null, versoesPreservadas: Math.max(0, Math.min(a.versoesAtivas, s.versoesAtivas) - 1),
        ultimaConexaoOkEm: eg.ultimaConexaoOkEm || null, status: !(a.cadastrado && s.cadastrado) ? 'SEM_CREDENCIAIS' : (eg.ultimaConexaoOkEm ? 'OPERACIONAL' : 'NAO_TESTADA') };
      const wh = await statusWebhook({ db, modo, segredo: w, ew, hb: hb.exists ? hb.data() : null });
      const nuvem = await statusNuvem({ hb: hb.exists ? hb.data() : null });
      return { ok: true, gestaoclick: gc, webhook: wh, nuvem };
    });
  }

  async function statusWebhook({ db, modo, segredo, ew, hb }) {
    const col = db.collection('gc_webhook_eventos'); const cont = async q => { try { return (await q.count().get()).data().count; } catch (_) { return null; } };
    const [total, proc, falhas] = await Promise.all([cont(col), cont(col.where('status', '==', 'SOMBRA_CONCLUIDA')), cont(col.where('status', 'in', ['SOMBRA_FALHA']))]);
    let recentes = []; try { recentes = (await col.orderBy('recebido_ms', 'desc').limit(200).get()).docs.map(d => d.data()); } catch (_) { /* sem eventos */ }
    const lat = recentes.map(e => (e.ocorrido_em && Date.parse(e.ocorrido_em) ? e.recebido_ms - Date.parse(e.ocorrido_em) : null)).filter(x => Number.isFinite(x) && x >= 0);
    const latMed = lat.length ? Math.round(lat.reduce((p, c) => p + c, 0) / lat.length) : null;
    const historico = recentes.slice(0, 20).map(e => ({ evento: e.evento, modo: e.modo, status: e.status, resultado: e.resultado || null, recebidoEm: e.recebido_ms || null, tentativa: e.tentativa || 1 }));
    const requisitos = await requisitosAtivo({ db, modo, segredoCadastrado: !!ew.segredoCadastradoEm, hb, contadores: { proc } });
    return { modo, url: URL_RECEPTOR, segredoCadastrado: !!ew.segredoCadastradoEm, segredoAtualizadoEm: ew.segredoCadastradoEm || null, status: modo === 'DESLIGADO' ? 'DESLIGADO' : (ew.segredoCadastradoEm ? 'EM_OPERACAO' : 'SEM_SEGREDO'),
      ultimoEventoRecebidoMs: recentes[0] ? recentes[0].recebido_ms : null, eventosRecebidos: total, eventosProcessados: proc, eventosComFalha: falhas, latenciaMediaMs: latMed, historico, requisitosAtivo: requisitos, transicoesPermitidas: TRANSICOES[modo] };
  }

  async function requisitosAtivo({ db, modo, segredoCadastrado, hb, contadores }) {
    const col = db.collection('gc_webhook_eventos'); const cont = async q => { try { return (await q.count().get()).data().count; } catch (_) { return null; } };
    const [conferidos, diverg, falhas] = await Promise.all([cont(col.where('resultado', '==', 'CONFERIDO')), cont(col.where('resultado', '==', 'LOJA_DIVERGENTE')), cont(col.where('status', '==', 'SOMBRA_FALHA'))]);
    const proc = contadores.proc || 0; const ult = hb && hb.ultimoSucessoCompletoEm ? Date.parse(hb.ultimoSucessoCompletoEm) : 0;
    return [
      { chave: 'segredo', ok: !!segredoCadastrado, texto: 'Segredo do webhook cadastrado' },
      { chave: 'modo_sombra', ok: modo === 'SOMBRA', texto: 'Receptor em modo SOMBRA' },
      { chave: 'amostra', ok: proc >= 20, texto: `Pelo menos 20 eventos conferidos em SOMBRA (atual: ${proc})` },
      { chave: 'conferencia', ok: proc > 0 && conferidos !== null && conferidos / Math.max(proc, 1) >= 0.95, texto: '≥ 95% dos eventos conferidos com a API' },
      { chave: 'sem_loja_divergente', ok: diverg === 0, texto: 'Nenhum evento de outra loja' },
      { chave: 'sem_falhas', ok: falhas === 0, texto: 'Nenhuma falha definitiva de conferência' },
      { chave: 'polling_saudavel', ok: ult > 0 && agora() - ult < 4 * 3600000, texto: 'Sincronização completa nas últimas 4 h (polling preservado)' },
    ];
  }

  async function statusNuvem({ hb }) {
    const out = { job: null, agendadores: [], ultimaSincronizacao: null, duracaoUltimaMs: null, requisicoesGc: null, monitoramento: null };
    if (hb) {
      out.ultimaSincronizacao = hb.ultimoSucessoCompletoEm || null; const ue = hb.ultimaExecucao || {};
      out.duracaoUltimaMs = typeof ue.duracaoMs === 'number' ? ue.duracaoMs : null; out.requisicoesGc = typeof ue.requisicoesGc === 'number' ? ue.requisicoesGc : null; out.ultimaExecucaoOk = ue.ok === undefined ? null : !!ue.ok;
      const h = hb.ultimoSucessoCompletoEm ? (agora() - Date.parse(hb.ultimoSucessoCompletoEm)) / 3600000 : null;
      out.monitoramento = h === null ? 'SEM_BATIMENTO' : h > 8 ? 'CRITICO' : h > 4 ? 'AVISO' : 'OK'; out.horasDesdeSucesso = h === null ? null : Math.round(h * 10) / 10;
    }
    if (requisitarGcp) {
      try { const r = await requisitarGcp({ url: `https://run.googleapis.com/v2/projects/${PROJETO_GCP}/locations/${REGIAO}/jobs/${JOB}/executions?pageSize=1`, method: 'GET' }); const e = (r.data.executions || [])[0];
        out.job = e ? { ultimaExecucaoInicio: e.startTime || e.createTime || null, ultimaExecucaoFim: e.completionTime || null, sucesso: Number(e.succeededCount || 0) > 0 && !Number(e.failedCount || 0), emExecucao: !e.completionTime } : { ultimaExecucaoInicio: null }; } catch (_) { out.job = { indisponivel: true }; }
      for (const nome of SCHEDULERS) { try { const r = await requisitarGcp({ url: `https://cloudscheduler.googleapis.com/v1/projects/${PROJETO_GCP}/locations/${REGIAO}/jobs/${nome}`, method: 'GET' });
        out.agendadores.push({ nome, estado: r.data.state, agenda: r.data.schedule, proxima: r.data.scheduleTime || null, ultima: r.data.lastAttemptTime || null }); } catch (_) { out.agendadores.push({ nome, indisponivel: true }); } }
    }
    const prox = out.agendadores.filter(a => a.proxima).map(a => a.proxima).sort()[0]; out.proximaSincronizacao = prox || null;
    return out;
  }

  // ─────────────── GESTÃOCLICK API ───────────────
  async function gcSalvar({ auth, data }) {
    return guardar(auth, 'gc_salvar', 'GESTAOCLICK_API', sensivel, async ({ uid, t }) => {
      const d = data || {}; const extras = Object.keys(d).filter(k => !['accessToken', 'secretToken'].includes(k)); if (extras.length) throw new IntErro('invalid-argument', 'CAMPOS_NAO_PERMITIDOS');
      if (!valorValido(d.accessToken) || !valorValido(d.secretToken)) throw new IntErro('invalid-argument', 'FORMATO_INVALIDO');
      const teste = await testarConexaoGc({ access: d.accessToken, secret: d.secretToken, transporte: transporteGc });
      if (!teste.ok) return { ok: false, codigo: teste.codigo, mensagem: 'A conexão com a loja ativa não foi validada; as credenciais em uso NÃO foram alteradas.' };
      const anterior = { a: await infoSegredo(SEGREDOS.GC_ACCESS), s: await infoSegredo(SEGREDOS.GC_SECRET) };
      const nA = await sm.adicionar(SEGREDOS.GC_ACCESS, d.accessToken); let nS;
      try { nS = await sm.adicionar(SEGREDOS.GC_SECRET, d.secretToken); }
      catch (e) { try { await sm.desabilitar(SEGREDOS.GC_ACCESS, nA); } catch (_) { /* registrado na auditoria */ } return { ok: false, codigo: 'FALHA_AO_GRAVAR', mensagem: 'Não foi possível gravar o segundo segredo; a primeira versão foi desfeita e nada mudou.' }; }
      // confirmação: o que está no Secret Manager é exatamente o que foi validado (comparação em memória; nada é devolvido)
      let conf = false; try { conf = (await sm.lerUltima(SEGREDOS.GC_ACCESS)) === d.accessToken && (await sm.lerUltima(SEGREDOS.GC_SECRET)) === d.secretToken; } catch (_) { conf = false; }
      if (!conf) { try { await sm.desabilitar(SEGREDOS.GC_ACCESS, nA); await sm.desabilitar(SEGREDOS.GC_SECRET, nS); } catch (_) { /* idem */ } return { ok: false, codigo: 'CONFIRMACAO_FALHOU', mensagem: 'A conferência após gravar falhou; as versões novas foram desativadas e as anteriores continuam em uso.' }; }
      await estadoRef(db, 'gestaoclick').set({ atualizadoEm: new Date(t).toISOString(), atualizadoPorUid: uid, ultimaConexaoOkEm: new Date(t).toISOString(), versoes: { access: nA, secret: nS }, anteriores: { access: anterior.a.versaoAtual, secret: anterior.s.versaoAtual }, loja: LOJA.id }, { merge: true });
      return { ok: true, codigo: 'CREDENCIAIS_ATUALIZADAS', versoes: { access: nA, secret: nS }, propagacao: 'O Cloud Run Job usa a nova versão na próxima execução; as Functions leem a nova versão em até 5 minutos (sem reimplantar). Versões anteriores preservadas para reversão.' };
    }, { chave: 'gc_salvar', max: 5, janelaMs: 3600000 });
  }

  async function gcTestar({ auth }) {
    return guardar(auth, 'gc_testar', 'GESTAOCLICK_API', {}, async ({ t }) => {
      const [access, secret] = await Promise.all([sm.lerUltima(SEGREDOS.GC_ACCESS), sm.lerUltima(SEGREDOS.GC_SECRET)]);
      const r = await testarConexaoGc({ access, secret, transporte: transporteGc });
      if (r.ok) await estadoRef(db, 'gestaoclick').set({ ultimaConexaoOkEm: new Date(t).toISOString() }, { merge: true });
      return { ok: r.ok, codigo: r.codigo };
    }, { chave: 'gc_testar', max: 20, janelaMs: 3600000 });
  }

  async function gcReverter({ auth }) {
    return guardar(auth, 'gc_reverter', 'GESTAOCLICK_API', sensivel, async ({ t }) => {
      const est = (await estadoRef(db, 'gestaoclick').get()).data() || {}; const ver = est.versoes;
      if (!ver || !est.anteriores || !est.anteriores.access || !est.anteriores.secret) return { ok: false, codigo: 'SEM_VERSAO_ANTERIOR', mensagem: 'Não há versão anterior registrada por este módulo.' };
      const [va, vs] = await Promise.all([sm.versoes(SEGREDOS.GC_ACCESS), sm.versoes(SEGREDOS.GC_SECRET)]);
      const okA = va.find(x => x.n === est.anteriores.access && x.estado === 'ENABLED'), okS = vs.find(x => x.n === est.anteriores.secret && x.estado === 'ENABLED');
      if (!okA || !okS) return { ok: false, codigo: 'VERSAO_ANTERIOR_INDISPONIVEL', mensagem: 'A versão anterior não está mais ativa.' };
      // desativa só o que ESTE módulo criou, e valida a conexão com o par anterior; se falhar, reativa o novo
      await sm.desabilitar(SEGREDOS.GC_ACCESS, ver.access); await sm.desabilitar(SEGREDOS.GC_SECRET, ver.secret);
      let r = { ok: false, codigo: 'FALHA_CONEXAO' }; try { r = await testarConexaoGc({ access: await sm.lerUltima(SEGREDOS.GC_ACCESS), secret: await sm.lerUltima(SEGREDOS.GC_SECRET), transporte: transporteGc }); } catch (_) { /* r permanece falha */ }
      if (!r.ok) { await sm.habilitar(SEGREDOS.GC_ACCESS, ver.access); await sm.habilitar(SEGREDOS.GC_SECRET, ver.secret); return { ok: false, codigo: 'REVERSAO_DESFEITA', mensagem: 'O par anterior não passou no teste de conexão; as credenciais novas foram mantidas.' }; }
      await estadoRef(db, 'gestaoclick').set({ versoes: { access: est.anteriores.access, secret: est.anteriores.secret }, anteriores: null, revertidoEm: new Date(t).toISOString(), ultimaConexaoOkEm: new Date(t).toISOString() }, { merge: true });
      return { ok: true, codigo: 'REVERTIDO' };
    }, { chave: 'gc_salvar', max: 5, janelaMs: 3600000 });
  }

  // ─────────────── WEBHOOKS ───────────────
  async function whSegredo({ auth, data }) {
    return guardar(auth, 'wh_segredo', 'GESTAOCLICK_WEBHOOK', sensivel, async ({ uid, t }) => {
      const d = data || {}; if (Object.keys(d).some(k => k !== 'segredo')) throw new IntErro('invalid-argument', 'CAMPOS_NAO_PERMITIDOS');
      if (!valorValido(d.segredo, { min: 16, max: 300 })) throw new IntErro('invalid-argument', 'FORMATO_INVALIDO');
      const n = await sm.adicionar(SEGREDOS.WEBHOOK, d.segredo); let conf = false; try { conf = (await sm.lerUltima(SEGREDOS.WEBHOOK)) === d.segredo; } catch (_) { /* conf=false */ }
      if (!conf) { try { await sm.desabilitar(SEGREDOS.WEBHOOK, n); } catch (_) { /* idem */ } return { ok: false, codigo: 'CONFIRMACAO_FALHOU', mensagem: 'A conferência após gravar falhou; a versão nova foi desativada.' }; }
      await estadoRef(db, 'webhook').set({ segredoCadastradoEm: new Date(t).toISOString(), segredoVersao: n, segredoPorUid: uid }, { merge: true });
      return { ok: true, codigo: 'SEGREDO_CADASTRADO', propagacao: 'O receptor passa a usar o novo segredo em até 1 minuto (sem reimplantar).' };
    }, { chave: 'wh_segredo', max: 5, janelaMs: 3600000 });
  }

  async function whModo({ auth, data }) {
    const d = data || {}; const alvo = d.modo;
    return guardar(auth, 'wh_modo_' + (MODOS.includes(alvo) ? alvo.toLowerCase() : 'x'), 'GESTAOCLICK_WEBHOOK', { reauth: alvo !== 'DESLIGADO' }, async ({ uid, t }) => {
      if (!MODOS.includes(alvo) || Object.keys(d).some(k => !['modo', 'confirmacao'].includes(k))) throw new IntErro('invalid-argument', 'MODO_INVALIDO');
      const cfgRef = db.collection('gc_webhook_config').doc('estado'); const atual = (await cfgRef.get()).data() || {}; const modoAtual = MODOS.includes(atual.modo) ? atual.modo : 'DESLIGADO';
      if (alvo === modoAtual) return { ok: true, codigo: 'SEM_MUDANCA', modo: modoAtual };
      if (alvo !== 'DESLIGADO' && !TRANSICOES[modoAtual].includes(alvo)) return { ok: false, codigo: 'TRANSICAO_NAO_PERMITIDA', mensagem: `De ${modoAtual} só é possível ir para ${TRANSICOES[modoAtual].join(', ')}.` };
      const ew = (await estadoRef(db, 'webhook').get()).data() || {};
      if (alvo !== 'DESLIGADO' && !ew.segredoCadastradoEm) return { ok: false, codigo: 'SEM_SEGREDO', mensagem: 'Cadastre o segredo do webhook antes de ligar o receptor.' };
      if (alvo === 'ATIVO') {
        if (d.confirmacao !== FRASE_ATIVAR) return { ok: false, codigo: 'CONFIRMACAO_EXPLICITA_NECESSARIA', mensagem: 'Digite a frase de confirmação exata para ativar.' };
        const hb = (await db.collection('gc_sync_status').doc('ultima').get()).data() || null; const proc = await (async () => { try { return (await db.collection('gc_webhook_eventos').where('status', '==', 'SOMBRA_CONCLUIDA').count().get()).data().count; } catch (_) { return 0; } })();
        const req = await requisitosAtivo({ db, modo: modoAtual, segredoCadastrado: true, hb, contadores: { proc } });
        const falta = req.filter(r => !r.ok); if (falta.length) return { ok: false, codigo: 'REQUISITOS_NAO_ATENDIDOS', mensagem: 'Requisitos técnicos pendentes: ' + falta.map(f => f.texto).join('; ') };
      }
      await cfgRef.set({ modo: alvo, atualizadoPorUid: uid, atualizadoEm: new Date(t).toISOString() }, { merge: true });
      return { ok: true, codigo: 'MODO_ALTERADO', modo: alvo, propagacao: 'Vale em até 30 segundos.' };
    });
  }

  async function whTeste({ auth }) {
    return guardar(auth, 'wh_teste', 'GESTAOCLICK_WEBHOOK', {}, async () => {
      const modo = ((await db.collection('gc_webhook_config').doc('estado').get()).data() || {}).modo || 'DESLIGADO';
      if (modo === 'DESLIGADO') return { ok: true, codigo: 'RECEPTOR_DESLIGADO', mensagem: 'O receptor está desligado: responde 200 sem validar nem gravar.' };
      const segredo = await sm.lerUltima(SEGREDOS.WEBHOOK); const id = 'teste-' + crypto.randomBytes(6).toString('hex'); const corpo = JSON.stringify({ id, evento: 'webhook.teste', loja_id: LOJA.id, empresa_id: '0', dados: { id: '0' } });
      const ts = String(Math.floor(agora() / 1000)); const sig = crypto.createHmac('sha256', segredo).update(ts + '.').update(corpo).digest('hex'); const t0 = agora();
      const r = await fetchReceptor(URL_RECEPTOR, { method: 'POST', headers: { 'content-type': 'application/json', 'x-webhook-assinatura': `t=${ts},v1=${sig}`, 'x-webhook-id': id, 'x-webhook-evento': 'webhook.teste' }, body: corpo, signal: AbortSignal.timeout(10000) });
      let cod = null; try { cod = (await r.json()).codigo; } catch (_) { /* sem corpo */ }
      // evento "webhook.teste" não é suportado de propósito: passar pela assinatura e ser ignorado prova a autenticação sem gravar nada
      const ok = r.status === 200 && cod === 'EVENTO_NAO_SUPORTADO';
      return { ok, codigo: ok ? 'ASSINATURA_ACEITA' : (r.status === 401 ? 'ASSINATURA_RECUSADA' : 'RESPOSTA_INESPERADA'), httpStatus: r.status, latenciaMs: agora() - t0, mensagem: ok ? 'Teste seguro: assinatura aceita; nenhum dado foi gravado.' : 'O receptor não aceitou o teste; confira o segredo cadastrado.' };
    }, { chave: 'wh_teste', max: 10, janelaMs: 3600000 });
  }

  // ─────────────── GOOGLE CLOUD ───────────────
  async function syncManual({ auth }) {
    return guardar(auth, 'sync_manual', 'GOOGLE_CLOUD', {}, async ({ t }) => {
      const trava = (await db.collection('gc_sync_lock').doc('sync-dados').get()).data();
      if (trava && Number(trava.expiraEm) > t) return { ok: false, codigo: 'SYNC_EM_ANDAMENTO', mensagem: 'Já existe uma sincronização em andamento (trava compartilhada).' };
      await requisitarGcp({ url: `https://run.googleapis.com/v2/projects/${PROJETO_GCP}/locations/${REGIAO}/jobs/${JOB}:run`, method: 'POST', data: { overrides: { containerOverrides: [{ env: [{ name: 'INTERVALO_MIN_MINUTOS', value: '0' }] }] } } });
      return { ok: true, codigo: 'SYNC_DISPARADA', mensagem: 'Sincronização manual iniciada; a trava compartilhada impede execução simultânea.' };
    }, { chave: 'sync_manual', max: 3, janelaMs: 3600000 });
  }

  return { status, gcSalvar, gcTestar, gcReverter, whSegredo, whModo, whTeste, syncManual };
}
module.exports = { criarHandlers, testarConexaoGc, MODOS, TRANSICOES, FRASE_ATIVAR, URL_RECEPTOR, LOJA };
