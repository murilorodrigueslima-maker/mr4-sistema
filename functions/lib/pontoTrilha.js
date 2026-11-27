'use strict';
/**
 * TRILHA APPEND-ONLY DO PONTO (E2). Gatilhos de escrita em registros, justificativas, creditos_jornada, funcionarios,
 * espelhos e banco_horas_config → um documento em `ponto_trilha` por escrita: antes, depois, campos alterados e autor
 * derivado do CONTEXTO DE AUTENTICAÇÃO do evento (nunca do que o navegador declara; o declarado vai à parte).
 *  • Só adiciona: create() com id = id do evento (reentrega não duplica). Nenhum update/delete no código; Rules negam escrita.
 *  • Não altera o documento de origem nem o comportamento do sistema; não recalcula nada.
 *  • Textos grandes (foto, anexo, assinatura) vão como resumo {sha256,tamanho}. O conteúdo que SERIA PERDIDO (valor anterior de
 *    uma alteração ou exclusão) é preservado em `ponto_trilha_blobs/{sha256}`.
 *  • Na assinatura do espelho, o servidor recalcula o hash do snapshot e registra se confere (D13).
 */
const crypto = require('crypto');
const A = require('./auditoria');

const SCHEMA = 'ponto-trilha-v1';
const COLECAO = 'ponto_trilha';
const BLOBS = 'ponto_trilha_blobs';
const LIMITE_TEXTO = 2000;
const COLECOES = ['registros', 'justificativas', 'creditos_jornada', 'funcionarios', 'espelhos', 'banco_horas_config'];
const DECLARADOS = ['aprovadoPorUid', 'respondidoPorUid', 'infoSolicitadaPorUid', 'propostoPorUid', 'lancadoPorUid', 'geradoPorUid', 'revisaoAbertaPorUid', 'assinadoPorUid', 'inativadoPorUid', 'authUid'];
const MOTIVOS = ['motivoRevisao', 'motivoCorrecao', 'obsGestor', 'infoSolicitada', 'motivoInativacao', 'evidenciaGestao', 'motivo'];

const sha = s => crypto.createHash('sha256').update(s).digest('hex');
const ehTimestamp = v => v && typeof v.toMillis === 'function';

/** forma estável para comparar valores (ordem de chaves e Timestamps) */
function estavel(v) {
  if (v === undefined) return 'u';
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (ehTimestamp(v)) return 'T' + v.toMillis() + ':' + (v.nanoseconds || 0);
  if (v instanceof Date) return 'D' + v.getTime();
  if (Array.isArray(v)) return '[' + v.map(estavel).join(',') + ']';
  return '{' + Object.keys(v).sort().map(k => JSON.stringify(k) + ':' + estavel(v[k])).join(',') + '}';
}
function camposAlterados(antes, depois) {
  const chaves = new Set([...Object.keys(antes || {}), ...Object.keys(depois || {})]);
  return [...chaves].filter(k => estavel((antes || {})[k]) !== estavel((depois || {})[k])).sort();
}
/** troca textos grandes por resumo; acumula em `blobs` quando o conteúdo precisa ser preservado */
function resumir(v, blobs, preservar) {
  if (typeof v === 'string') {
    if (v.length <= LIMITE_TEXTO) return v;
    const h = sha(v);
    if (preservar) blobs.set(h, v);
    return { _resumo: true, sha256: h, tamanho: v.length };
  }
  if (v === null || typeof v !== 'object' || ehTimestamp(v) || v instanceof Date) return v === undefined ? null : v;
  if (Array.isArray(v)) return v.map(x => resumir(x, blobs, preservar));
  const o = {}; for (const [k, x] of Object.entries(v)) o[k] = resumir(x, blobs, preservar); return o;
}

function classificar(colecao, antes, depois, campos) {
  const criou = !antes, apagou = !depois, mudou = c => campos.includes(c);
  if (colecao === 'registros') {
    if (criou) return depois.lancadoPorJustificativa ? 'CORRECAO_REGISTRADA' : 'BATIDA_REGISTRADA';
    if (apagou) return 'REGISTRO_EXCLUIDO';
    return mudou('substituidoPor') ? 'REGISTRO_SUBSTITUIDO_POR_CORRECAO' : 'REGISTRO_ALTERADO';
  }
  if (colecao === 'justificativas') {
    if (criou) return depois.lancadoPorGestor ? 'LANCAMENTO_DA_GESTAO' : 'PEDIDO_DO_FUNCIONARIO';
    if (apagou) return 'JUSTIFICATIVA_EXCLUIDA';
    if (mudou('status')) return 'JUSTIFICATIVA_DECIDIDA';
    return 'JUSTIFICATIVA_ALTERADA';
  }
  if (colecao === 'creditos_jornada') return criou ? 'CREDITO_LANCADO' : apagou ? 'CREDITO_EXCLUIDO' : 'CREDITO_ALTERADO';
  if (colecao === 'funcionarios') {
    if (criou) return 'CADASTRO_CRIADO';
    if (apagou) return 'CADASTRO_EXCLUIDO';
    if (mudou('inativo')) return depois.inativo ? 'CADASTRO_INATIVADO' : 'CADASTRO_REATIVADO';
    return 'CADASTRO_ALTERADO';
  }
  if (colecao === 'espelhos') {
    if (apagou) return 'ESPELHO_EXCLUIDO';
    if (depois.assinado === true && !(antes && antes.assinado === true)) return 'ESPELHO_ASSINADO';
    if (criou) return depois.versaoAnteriorId ? 'REVISAO_CRIADA' : 'ESPELHO_ENVIADO';
    if (antes.assinado === true && depois.assinado !== true) return 'ASSINATURA_REMOVIDA';
    if (mudou('substituido')) return 'REVISAO_CONCLUIDA';
    if (mudou('revisaoEmAndamento') || mudou('versaoSucessoraId')) return 'MES_REABERTO';
    if (mudou('snapshot') || mudou('hashSnapshot')) return antes.assinado === true ? 'ESPELHO_ASSINADO_ALTERADO' : 'ESPELHO_REENVIADO';
    return 'ESPELHO_ALTERADO';
  }
  return criou ? 'CONFIG_CRIADA' : apagou ? 'CONFIG_EXCLUIDA' : 'CONFIG_ALTERADA';
}

let motor = null;
function hashDoSnapshot(snapshot) {
  motor = motor || require('./pontoBanco').M;
  return sha(motor.canonicalizarSnapshot(snapshot));
}

/** Monta o evento (puro, exceto o hash). Devolve null quando nada mudou. */
function montar({ colecao, id, antes, depois }) {
  const campos = camposAlterados(antes, depois);
  if (!campos.length && antes && depois) return null;
  const ref = depois || antes;
  const funcId = typeof ref.funcId === 'string' ? ref.funcId : colecao === 'funcionarios' ? id : null;
  const data = typeof ref.data === 'string' ? ref.data : typeof ref.dataAusencia === 'string' ? ref.dataAusencia : null;
  const mes = typeof ref.mes === 'string' ? ref.mes : data ? data.slice(0, 7) : null;
  const evento = classificar(colecao, antes, depois, campos);
  const blobs = new Map();
  // valor anterior de campo alterado/apagado é o que se perderia: preservado integralmente
  const antesR = antes ? Object.fromEntries(Object.entries(antes).map(([k, v]) => [k, resumir(v, blobs, !depois || campos.includes(k))])) : null;
  const depoisR = depois ? resumir(depois, blobs, false) : null;
  const declarado = {}; DECLARADOS.forEach(k => { if (depois && typeof depois[k] === 'string' && campos.includes(k)) declarado[k] = depois[k]; });
  const justificativa = {}; MOTIVOS.forEach(k => { if (depois && typeof depois[k] === 'string' && depois[k] && campos.includes(k)) justificativa[k] = depois[k].slice(0, LIMITE_TEXTO); });
  const extras = {};
  if (colecao === 'registros') extras.natureza = ref.lancadoPorJustificativa ? 'AJUSTE_ADMINISTRATIVO' : 'BATIDA_ORIGINAL';
  if (colecao === 'justificativas') extras.natureza = ref.lancadoPorGestor ? 'INSERIDO_PELA_GESTAO' : 'PEDIDO_DO_FUNCIONARIO';
  if (evento === 'ESPELHO_ASSINADO') {
    let recalculado = null; try { recalculado = depois.snapshot ? hashDoSnapshot(depois.snapshot) : null; } catch (_) { recalculado = null; }
    extras.assinatura = { hashAssinado: depois.hashAssinado || null, hashRecalculadoPeloServidor: recalculado, hashConfere: !!recalculado && recalculado === depois.hashAssinado };
  }
  return {
    doc: { schema: SCHEMA, colecao, docId: id, evento, operacao: !antes ? 'CRIACAO' : !depois ? 'EXCLUSAO' : 'ALTERACAO', funcId, data, mes,
      camposAlterados: campos, antes: antesR, depois: depoisR, declarado, justificativa, ...extras },
    blobs,
  };
}

const jaExiste = e => e && (e.code === 6 || /ALREADY_EXISTS/.test(String(e.message)));
const naoCabe = e => e && e.code === 3;   // INVALID_ARGUMENT (documento acima do limite): repetir não resolve
async function criar(ref, dados) { try { await ref.create(dados); return true; } catch (e) { if (jaExiste(e)) return false; throw e; } }

/**
 * Autor a partir do contexto do evento. O formato do identificador depende do tipo de principal (a documentação não o fixa),
 * então o valor BRUTO é sempre guardado e o usuário é resolvido por ID de `users` ou, se for um e-mail, pelo e-mail único.
 */
async function resolverAutor(db, authType, authId) {
  const base = A.atorDoContexto(authType, authId);
  if (!authId || base.type === 'SYSTEM') return base;
  let uid = null;
  if (String(authId).includes('@')) { const q = await db.collection('users').where('email', '==', String(authId).toLowerCase()).limit(2).get(); if (q.size === 1) uid = q.docs[0].id; }
  else if (!String(authId).includes('/')) { const u = await db.collection('users').doc(String(authId)).get(); if (u.exists) uid = u.id; }
  if (!uid) return { ...base, uid: base.type === 'USER' ? base.uid : null };
  return A.enriquecerAtor(db, { uid, type: 'USER', origin: base.origin });
}

/** Handler do gatilho. `deps` injetáveis para teste. */
async function registrar(event, colecao, { db, FieldValue, logger = console }) {
  const lado = s => (s && s.exists ? s.data() : null);
  const antes = lado(event.data && event.data.before), depois = lado(event.data && event.data.after);
  if (!antes && !depois) return { gravado: false };
  const id = (event.params && event.params.id) || (event.data.after || event.data.before).id;
  const m = montar({ colecao, id, antes, depois });
  if (!m) return { gravado: false };
  const ator = await resolverAutor(db, event.authType, event.authId);
  // blobs ANTES do evento: se a trilha aponta para um conteúdo, ele já está guardado
  const naoPreservados = [];
  for (const [h, conteudo] of m.blobs) {
    try { await criar(db.collection(BLOBS).doc(h), { conteudo, tamanho: conteudo.length, colecao, docId: id, criadoEm: FieldValue.serverTimestamp() }); }
    catch (e) { if (!naoCabe(e)) throw e; naoPreservados.push(h); }
  }
  const ref = db.collection(COLECAO).doc(String(event.id).replace(/\//g, '_'));
  const dados = { ...m.doc, autorUid: ator.uid || null, autorTipo: ator.type, autorPapel: ator.role || null, autorAdmin: ator.admin === undefined ? null : ator.admin, autorOrigem: ator.origin,
    autorAuthType: event.authType || null, autorAuthId: event.authId || null,
    eventoEm: event.time || null, criadoEm: FieldValue.serverTimestamp(), ...(naoPreservados.length ? { conteudosNaoPreservados: naoPreservados } : {}) };
  let gravado;
  try { gravado = await criar(ref, dados); }
  catch (e) {
    if (!naoCabe(e)) throw e;   // grande demais: registra o fato, o autor e o resumo (hash) do antes/depois
    if (logger.error) logger.error('[ponto-trilha] evento sem antes/depois (tamanho)', JSON.stringify({ colecao, docId: id }));
    gravado = await criar(ref, { ...dados, antes: antes ? { _resumo: true, sha256: sha(estavel(antes)) } : null, depois: depois ? { _resumo: true, sha256: sha(estavel(depois)) } : null, incompleto: true });
  }
  if (m.doc.assinatura && !m.doc.assinatura.hashConfere && logger.warn) logger.warn('[ponto-trilha] hash recalculado diferente do assinado', JSON.stringify({ docId: id }));
  return { gravado, evento: m.doc.evento };
}

module.exports = { registrar, resolverAutor, montar, classificar, camposAlterados, resumir, SCHEMA, COLECAO, BLOBS, COLECOES, LIMITE_TEXTO };
