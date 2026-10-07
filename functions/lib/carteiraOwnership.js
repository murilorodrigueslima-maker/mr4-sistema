'use strict';
/**
 * B2 — operações de ownership (server-side, TRANSACIONAIS, idempotentes) — PREPARADAS E INATIVAS.
 * NÃO são exportadas por index.js, não têm callable, gatilho nem job. A B3+ decide quando/como acionar (e a regra dos 120 dias
 * segue em SOMBRA). Garantias: um documento por âncora GC (dois owners simultâneos são impossíveis); `versaoEsperada` obrigatória
 * para mudar uma carteira existente; evento de histórico com id derivado da chave + create() (retry não duplica); auditoria S7
 * gravada DEPOIS do commit; carteira EM_REVISAO (conflito de identidade) nunca é alterada por estas operações, exceto resolverConflito.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const C2 = require('./carteiraV2');
const H2 = require('./carteiraHistoricoV2');
const A = require('./auditoria');

const COLL = 'carteira_comercial', COLL_HIST = 'carteira_comercial_historico';
const err = (code, msg) => new HttpsError(code, msg);

/** Revisor de conflito = role gestor (proprietário) OU módulo fila-comercial-gestao (Camila). Nunca vendedor; nunca exige admin. */
async function autorizarRevisor(store, uid) {
  const [u, s] = await Promise.all([store.collection('users').doc(uid).get(), store.collection('sistema_usuarios').doc(uid).get()]);
  if (!u.exists || !s.exists || !u.data().ativo || s.data().bloqueado === true) throw err('permission-denied', 'SEM_PERMISSAO');
  const gestor = u.data().role === 'gestor', gestao = Array.isArray(s.data().modulos) && s.data().modulos.includes('fila-comercial-gestao');
  if (!gestor && !gestao) throw err('permission-denied', 'SEM_PERMISSAO');
  return { uid, role: u.data().role, papel: gestor ? 'PROPRIETARIO' : 'CAMILA' };
}
async function ownerValido(store, uid) {
  const [u, s] = await Promise.all([store.collection('users').doc(uid).get(), store.collection('sistema_usuarios').doc(uid).get()]);
  return u.exists && s.exists && u.data().ativo === true && s.data().bloqueado !== true && Array.isArray(s.data().modulos) && s.data().modulos.includes('fila-comercial-operar');
}
function exigir(cond, code, msg) { if (!cond) throw err(code, msg); }
const strOk = (v, n = 200) => typeof v === 'string' && v.length > 0 && v.length <= n;

/** Núcleo único: aplica uma transição dentro de uma transação e devolve { repetido, antes, depois, evento, eventoId }. */
async function aplicar(store, FieldValue, p, regras) {
  exigir(C2.ANCORA_RE.test(String(p.portfolioId)), 'invalid-argument', 'portfolioId inválido');
  exigir(strOk(p.chaveIdempotencia, 160), 'invalid-argument', 'chaveIdempotencia obrigatória');
  exigir(strOk(p.motivo, 300), 'invalid-argument', 'motivo obrigatório');
  const eventoId = H2.idDeChave(p.chaveIdempotencia);
  const refC = store.collection(COLL).doc(p.portfolioId), refE = store.collection(COLL_HIST).doc(eventoId);
  const agoraIso = p.agoraIso || new Date().toISOString();
  let res;
  await store.runTransaction(async tx => {
    const [sc, se] = await Promise.all([tx.get(refC), tx.get(refE)]);
    const lido = p.lerTx ? await p.lerTx(tx) : null;                                    // B3: leituras extras ANTES de qualquer escrita (ex.: reserva de reativação)
    if (se.exists) {                                                                   // retry: mesmo evento já aplicado → mesmo resultado, nada novo
      const ev = se.data();
      exigir(ev.portfolioId === p.portfolioId && ev.tipoEvento === regras.tipoEvento, 'already-exists', 'chaveIdempotencia já usada em outra operação');
      res = { repetido: true, antes: null, depois: sc.exists ? sc.data() : null, evento: ev, eventoId }; return;
    }
    const antes = sc.exists ? sc.data() : null;
    const plano = await regras.planejar(antes, { tx, agoraIso, versaoAntes: antes ? antes.versao : null });
    const doc = plano.doc;
    const e = C2.validarDocCarteiraV2(doc); exigir(!e, 'failed-precondition', 'documento v2 inválido: ' + e);
    if (!regras.mudaOwner) exigir((antes ? antes.ownerUid : null) === doc.ownerUid, 'internal', 'operação sem mudança de owner alterou owner');
    const seq = doc.versao;                                                          // sequência monotônica por carteira = versão resultante
    const evento = H2.montarEventoHistoricoV2({ portfolioId: p.portfolioId, identidadeUsada: 'GC_NATIVE:' + p.portfolioId.slice(3), tipoEvento: regras.tipoEvento,
      ownerAnteriorUid: antes ? antes.ownerUid : null, ownerNovoUid: doc.ownerUid, motivo: p.motivo, motivoCodigo: p.motivoCodigo || null, operadorUid: p.operadorUid || null,
      atorTipo: p.atorTipo || 'USER', origemOperacao: p.origemOperacao || 'CALLABLE', criadoEm: agoraIso, versaoCarteiraAntes: antes ? antes.versao : null,
      versaoCarteiraDepois: doc.versao, seq, referencias: p.referencias || null, chaveIdempotencia: p.chaveIdempotencia });
    doc.ultimoEventoId = eventoId;
    tx.set(refC, doc); tx.create(refE, evento);
    if (p.escreverTx) p.escreverTx(tx, lido, { antes, doc, evento, eventoId });         // escritas complementares na MESMA transação
    res = { repetido: false, antes, depois: doc, evento, eventoId };
  });
  if (!res.repetido && p.auditar !== false) {                                           // auditoria S7 SÓ depois do commit
    await A.gravar(store, FieldValue, 'carteira_' + res.eventoId, A.evento({ ator: { uid: p.operadorUid || null, type: p.atorTipo || 'USER', origin: 'CALLABLE_AUTH' }, action: 'PORTFOLIO_' + regras.tipoEvento,
      category: A.CATEGORIAS.COMMERCIAL, entityType: 'carteira_comercial', entityId: p.portfolioId, source: 'LIB:carteiraOwnership',
      before: res.antes ? { ownerUid: res.antes.ownerUid, versao: res.antes.versao, status: res.antes.status || null } : null, after: { ownerUid: res.depois.ownerUid, versao: res.depois.versao, status: res.depois.status },
      metadata: { eventoId: res.eventoId, tipoEvento: regras.tipoEvento } }));
  }
  return res;
}
const apenasAtiva = d => exigir(d && d.schemaVersion === C2.SCHEMA_V2 && d.status === 'ATIVA', 'failed-precondition', d && d.status === 'EM_REVISAO' ? 'CARTEIRA_EM_REVISAO_DE_CONFLITO' : 'CARTEIRA_NAO_ATIVA_OU_V1');
const versaoOk = (d, esp) => exigir(Number.isInteger(esp) && d.versao === esp, 'aborted', 'VERSAO_DESATUALIZADA');

/** Cria carteira para âncora SEM carteira. Recusa se existir carteira ou se a âncora estiver relacionada a conflito aberto. */
async function criarCarteira(store, FieldValue, p) {
  exigir(C2.ORIGENS.includes(p.origem) && p.origem !== 'MIGRACAO_ONDA1_N3526' && p.origem !== 'TRANSFERENCIA_ADMIN', 'invalid-argument', 'origem inválida para criação');
  return aplicar(store, FieldValue, p, { tipoEvento: p.origem === 'REATIVACAO_120D' ? 'CARTEIRA_CRIADA_REATIVACAO' : 'CARTEIRA_CRIADA_PRIMEIRA_VENDA', mudaOwner: true,
    async planejar(antes, { tx, agoraIso }) {
      exigir(!antes, 'already-exists', 'JA_EXISTE_CARTEIRA_PARA_O_CLIENTE');
      exigir(await ownerValido(store, p.ownerUid), 'failed-precondition', 'OWNER_INVALIDO');
      const rel = await tx.get(store.collection(COLL).where('conflito.relacionados', 'array-contains', p.portfolioId).limit(1));
      exigir(rel.empty, 'failed-precondition', 'CLIENTE_EM_CONFLITO_DE_IDENTIDADE');
      return { doc: { schemaVersion: C2.SCHEMA_V2, portfolioId: p.portfolioId, ownerUid: p.ownerUid, ownerDesde: agoraIso, origemComercialUid: p.ownerUid, origemComercialGestaoClickId: p.origemComercialGestaoClickId || null,
        criadoEm: agoraIso, atualizadoEm: agoraIso, versao: 1, status: 'ATIVA', origem: p.origem, cicloAncoraEm: p.cicloAncoraEm || null, clienteMr4Id: p.clienteMr4Id || null, conflito: null } };
    } });
}
/** Transferência: troca o owner (nunca reinicia o ciclo). Exige versão esperada e carteira ATIVA. */
function transferir(store, FieldValue, p) {
  return aplicar(store, FieldValue, p, { tipoEvento: 'TRANSFERENCIA', mudaOwner: true, async planejar(antes, { agoraIso }) {
    exigir(antes, 'not-found', 'SEM_CARTEIRA'); apenasAtiva(antes); versaoOk(antes, p.versaoEsperada);
    exigir(p.novoOwnerUid && p.novoOwnerUid !== antes.ownerUid, 'invalid-argument', 'novo owner igual ao atual ou ausente');
    exigir(await ownerValido(store, p.novoOwnerUid), 'failed-precondition', 'OWNER_INVALIDO');
    return { doc: { ...antes, ownerUid: p.novoOwnerUid, ownerDesde: agoraIso, atualizadoEm: agoraIso, versao: antes.versao + 1, origem: 'TRANSFERENCIA_ADMIN' } };
  } });
}
/** Reativação (120 dias): mudança de owner para o vendedor da venda válida; reinicia a âncora do ciclo. */
async function reativar(store, FieldValue, p) {
  exigir(/^\d{4}-\d{2}-\d{2}$/.test(String(p.cicloAncoraEm)), 'invalid-argument', 'cicloAncoraEm (YYYY-MM-DD) obrigatório');
  return aplicar(store, FieldValue, p, { tipoEvento: 'REATIVACAO_120D_PRIMEIRA_VENDA', mudaOwner: true, async planejar(antes, { agoraIso }) {
    exigir(antes, 'not-found', 'SEM_CARTEIRA'); apenasAtiva(antes); versaoOk(antes, p.versaoEsperada);
    exigir(p.novoOwnerUid && p.novoOwnerUid !== antes.ownerUid, 'invalid-argument', 'novo owner igual ao atual ou ausente');
    exigir(await ownerValido(store, p.novoOwnerUid), 'failed-precondition', 'OWNER_INVALIDO');
    return { doc: { ...antes, ownerUid: p.novoOwnerUid, ownerDesde: agoraIso, atualizadoEm: agoraIso, versao: antes.versao + 1, origem: 'REATIVACAO_120D', cicloAncoraEm: p.cicloAncoraEm } };
  } });
}
/** Renovação: compra válida renova o ciclo do owner ATUAL; owner não muda. */
function renovarCiclo(store, FieldValue, p) {
  return aplicar(store, FieldValue, p, { tipoEvento: 'RENOVACAO_CICLO', mudaOwner: false, async planejar(antes, { agoraIso }) {
    exigir(antes, 'not-found', 'SEM_CARTEIRA'); apenasAtiva(antes); versaoOk(antes, p.versaoEsperada);
    exigir(/^\d{4}-\d{2}-\d{2}$/.test(String(p.cicloAncoraEm)), 'invalid-argument', 'cicloAncoraEm obrigatório');
    exigir(!antes.cicloAncoraEm || p.cicloAncoraEm >= antes.cicloAncoraEm, 'failed-precondition', 'CICLO_RETROCEDERIA');
    return { doc: { ...antes, cicloAncoraEm: p.cicloAncoraEm, atualizadoEm: agoraIso, versao: antes.versao + 1 } };
  } });
}
/** Liberação: remove o owner (carteira LIBERADA). Só revisor autorizado deve chamar (a camada callable valida). */
function liberar(store, FieldValue, p) {
  return aplicar(store, FieldValue, p, { tipoEvento: 'LIBERACAO', mudaOwner: true, async planejar(antes, { agoraIso }) {
    exigir(antes, 'not-found', 'SEM_CARTEIRA'); apenasAtiva(antes); versaoOk(antes, p.versaoEsperada);
    return { doc: { ...antes, ownerUid: null, ownerDesde: null, status: 'LIBERADA', atualizadoEm: agoraIso, versao: antes.versao + 1 } };
  } });
}
/** Resolução de conflito de identidade: SOMENTE revisor autorizado (proprietário/Camila); NUNCA altera owner. */
async function resolverConflito(store, FieldValue, p) {
  const revisor = await autorizarRevisor(store, p.operadorUid);
  exigir(['MANTIDA_SEM_MERGE', 'DESCARTADO_FALSO_POSITIVO'].includes(p.resolucao), 'invalid-argument', 'resolucao inválida');
  return aplicar(store, FieldValue, { ...p, motivo: p.motivo || ('Conflito resolvido por ' + revisor.papel) }, { tipoEvento: 'CONFLITO_RESOLVIDO', mudaOwner: false, async planejar(antes, { agoraIso }) {
    exigir(antes && antes.status === 'EM_REVISAO' && antes.conflito, 'failed-precondition', 'SEM_CONFLITO_ABERTO'); versaoOk(antes, p.versaoEsperada);
    return { doc: { ...antes, status: 'ATIVA', conflito: { ...antes.conflito, revisao: 'RESOLVIDO' }, atualizadoEm: agoraIso, versao: antes.versao + 1 } };
  } });
}
module.exports = { aplicar, exigir, ownerValido, autorizarRevisor, criarCarteira, transferir, reativar, renovarCiclo, liberar, resolverConflito, COLL, COLL_HIST };
