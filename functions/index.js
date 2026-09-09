'use strict';

/**
 * Cloud Functions — MR4 Ponto Digital
 *
 * AVISO DE SEGURANÇA:
 * - FACIAL CLIENT-SIDE NÃO É BARREIRA DE SEGURANÇA CONTRA USUÁRIO TÉCNICO.
 *   facialScore vem do navegador e é aceito apenas como dado de auditoria.
 *   A barreira real é: autenticação Firebase + validação server-side aqui.
 * - GPS do cliente pode ser falsificado (limitação estrutural da web).
 *   Server recalcula distância com as coordenadas brutas enviadas.
 *   dentroRaio nunca é aceito do cliente.
 *
 * NÃO PUBLICAR EM PRODUÇÃO sem passar pelos testes A-T no emulador.
 */

const { onCall, HttpsError } = require('firebase-functions/v2/https');
const admin = require('firebase-admin');
const { distMetros, fortalezaAgora, validarLatLng } = require('./utils');

if (!admin.apps.length) admin.initializeApp();
const db        = admin.firestore();
const authAdmin = admin.auth();

// ── Constantes ────────────────────────────────────────────────────────────────

const REGION = 'southamerica-east1';

const EMP_LAT  = -3.7603154;
const EMP_LNG  = -38.5634329;
const RAIO_M   = 200;

// Lido em runtime para permitir override nos testes (PONTO_COOLDOWN_MS=0 nos testes de sequência)
const COOLDOWN_MS = () => parseInt(process.env.PONTO_COOLDOWN_MS || '10000', 10);
const FOTO_MAX_BYTES = 350_000;  // ~350 KB base64

const LABEL_PONTO = {
  entrada:        'Entrada',
  saida_almoco:   'Saída almoço',
  retorno_almoco: 'Retorno',
  saida:          'Saída',
};

// ── Handler: registrarPonto ───────────────────────────────────────────────────

async function registrarPontoHandler(request) {
  // 1. Autenticação obrigatória
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para registrar ponto.');
  }
  const uid = request.auth.uid;

  // 2. Identidade server-side: users/{uid}
  const userDoc = await db.collection('users').doc(uid).get();
  if (!userDoc.exists) {
    throw new HttpsError('not-found', 'Conta não vinculada a funcionário. Contate o gestor.');
  }
  const userPerfil = userDoc.data();
  if (userPerfil.role !== 'funcionario') {
    throw new HttpsError('permission-denied', 'Somente funcionários podem registrar ponto por esta função.');
  }
  if (!userPerfil.ativo) {
    throw new HttpsError('permission-denied', 'Conta inativa. Contate o gestor.');
  }
  const funcId = userPerfil.funcionarioId;
  if (!funcId) {
    throw new HttpsError('not-found', 'Funcionário não vinculado ao perfil. Contate o gestor.');
  }

  // 3. Dados do funcionário
  const funcDoc = await db.collection('funcionarios').doc(funcId).get();
  if (!funcDoc.exists) {
    throw new HttpsError('not-found', 'Funcionário não encontrado. Contate o gestor.');
  }
  const func      = funcDoc.data();
  const modalidade = func.modalidade || 'PRESENCIAL';

  // 4. Payload do cliente (campos controlados pelo servidor são ignorados se enviados)
  const { lat, lng, horaCliente, facialScore, foto } = request.data || {};

  // 5. Validação de GPS
  let dentroRaio = null;
  if (modalidade === 'PRESENCIAL') {
    if (!validarLatLng(lat, lng)) {
      throw new HttpsError('invalid-argument', 'Localização GPS inválida ou fora dos limites do Brasil.');
    }
    const dist = distMetros(lat, lng, EMP_LAT, EMP_LNG);
    dentroRaio = dist <= RAIO_M;
    if (!dentroRaio) {
      throw new HttpsError(
        'failed-precondition',
        `Você está a ${Math.round(dist)}m da empresa (raio permitido: ${RAIO_M}m).`,
      );
    }
  } else if (validarLatLng(lat, lng)) {
    dentroRaio = distMetros(lat, lng, EMP_LAT, EMP_LNG) <= RAIO_M;
  }

  // 6. Validação de foto
  if (foto && typeof foto === 'string' && foto.length > FOTO_MAX_BYTES) {
    throw new HttpsError('invalid-argument', 'Foto muito grande. Reduza a qualidade e tente novamente.');
  }

  // 7. Hora oficial do servidor (America/Fortaleza — nunca do cliente)
  const { data, hora } = fortalezaAgora();

  // 8. Sequência + gravação em transação
  const registrosRef = db.collection('registros');
  const regId        = registrosRef.doc().id;  // ID gerado server-side

  let tipoRegistro = null;
  let tipoLabel    = null;

  await db.runTransaction(async (tx) => {
    // 8a. Registros de hoje — sem orderBy (sort em memória; não exige índice na transação)
    const snap = await tx.get(
      registrosRef
        .where('funcId', '==', funcId)
        .where('data',   '==', data),
    );
    const regsHoje = snap.docs
      .map(d => d.data())
      .sort((a, b) => {
        // Quando dois registros têm a mesma hora (ss precision), usa criadoEm como tie-break
        if (a.hora !== b.hora) return a.hora > b.hora ? 1 : -1;
        const ta = a.criadoEm instanceof admin.firestore.Timestamp ? a.criadoEm.toMillis() : 0;
        const tb = b.criadoEm instanceof admin.firestore.Timestamp ? b.criadoEm.toMillis() : 0;
        return ta - tb;
      });

    const ultimo = regsHoje[regsHoje.length - 1];

    // 8b. Próximo tipo na sequência
    if (!ultimo)                          tipoRegistro = 'entrada';
    else if (ultimo.tipo === 'entrada')   tipoRegistro = 'saida_almoco';
    else if (ultimo.tipo === 'saida_almoco')   tipoRegistro = 'retorno_almoco';
    else if (ultimo.tipo === 'retorno_almoco') tipoRegistro = 'saida';
    else throw new HttpsError('failed-precondition', 'Ponto do dia já completo.');

    tipoLabel = LABEL_PONTO[tipoRegistro];

    // 8c. Cooldown (anti-race condition / anti-duplo-clique)
    if (ultimo) {
      const criadoEm = ultimo.criadoEm instanceof admin.firestore.Timestamp
        ? ultimo.criadoEm.toMillis()
        : (typeof ultimo.criadoEm === 'string' ? new Date(ultimo.criadoEm).getTime() : 0);
      if (Date.now() - criadoEm < COOLDOWN_MS()) {
        throw new HttpsError('resource-exhausted', 'Aguarde alguns segundos antes de registrar outro ponto.');
      }
    }

    // 8d. Grava dentro da transação
    tx.set(registrosRef.doc(regId), {
      id:          regId,
      funcId,                                              // SERVIDOR
      funcNome:    func.nome || '',                        // SERVIDOR
      authUid:     uid,                                    // SERVIDOR
      modalidade,                                          // SERVIDOR (do banco)
      data,                                                // SERVIDOR
      hora,                                                // SERVIDOR
      tipo:        tipoRegistro,                           // SERVIDOR
      tipoLabel,                                           // SERVIDOR
      lat:         validarLatLng(lat, lng) ? lat  : null, // CLIENTE/AUDITORIA
      lng:         validarLatLng(lat, lng) ? lng  : null, // CLIENTE/AUDITORIA
      dentroRaio,                                          // SERVIDOR (recalculado)
      horaCliente: typeof horaCliente === 'string'
        ? horaCliente.slice(0, 8) : null,                 // CLIENTE/AUDITORIA
      facialScore: typeof facialScore === 'number'
        ? Math.round(facialScore) : null,                 // CLIENTE/AUDITORIA
      foto:        foto && typeof foto === 'string'
        ? foto : null,                                    // CLIENTE/AUDITORIA
      criadoEm:    admin.firestore.FieldValue.serverTimestamp(), // SERVIDOR
    });
  });

  return {
    ok: true, id: regId, tipo: tipoRegistro, tipoLabel, data, hora, dentroRaio, modalidade,
  };
}

// ── Handler: criarContaFuncionario ────────────────────────────────────────────

async function criarContaFuncionarioHandler(request) {
  // 1. Autenticação obrigatória
  if (!request.auth) {
    throw new HttpsError('unauthenticated', 'Faça login para criar contas.');
  }
  const uid = request.auth.uid;

  // 2. Verificar gestor — FAIL CLOSED
  const callerDoc = await db.collection('users').doc(uid).get();
  const isGestor  =
    callerDoc.exists &&
    callerDoc.data().role === 'gestor' &&
    callerDoc.data().ativo === true;

  if (!isGestor) {
    throw new HttpsError('permission-denied', 'Somente gestores podem criar contas de funcionários.');
  }

  // 3. Payload
  const { email, senha, funcId, funcNome } = request.data || {};
  if (!email  || typeof email   !== 'string') throw new HttpsError('invalid-argument', 'E-mail inválido.');
  if (!senha  || typeof senha   !== 'string' || senha.length < 6) throw new HttpsError('invalid-argument', 'Senha deve ter pelo menos 6 caracteres.');
  if (!funcId || typeof funcId  !== 'string') throw new HttpsError('invalid-argument', 'funcId inválido.');
  if (!funcNome || typeof funcNome !== 'string') throw new HttpsError('invalid-argument', 'Nome do funcionário inválido.');

  // 4. Funcionário existe?
  const funcDoc = await db.collection('funcionarios').doc(funcId).get();
  if (!funcDoc.exists) {
    throw new HttpsError('not-found', `Funcionário ${funcId} não encontrado.`);
  }

  // 5. Conta já vinculada?
  const usersSnap = await db.collection('users').where('funcionarioId', '==', funcId).limit(1).get();
  if (!usersSnap.empty) {
    throw new HttpsError('already-exists', 'Este funcionário já possui uma conta de acesso.');
  }

  // 6. Criar Auth user via Admin SDK (não desloga gestor)
  let newUser;
  try {
    newUser = await authAdmin.createUser({
      email:       email.trim().toLowerCase(),
      password:    senha,
      displayName: funcNome,
    });
  } catch (e) {
    const msgs = {
      'auth/email-already-exists': 'Este e-mail já está em uso por outra conta.',
      'auth/invalid-email':        'E-mail inválido.',
      'auth/weak-password':        'Senha muito fraca (mínimo 6 caracteres).',
    };
    throw new HttpsError('invalid-argument', msgs[e.code] || 'Erro ao criar conta: ' + e.message);
  }

  // 7. Criar users/{uid}
  await db.collection('users').doc(newUser.uid).set({
    funcionarioId: funcId,
    role:          'funcionario',
    ativo:         true,
    nome:          funcNome,
    email:         email.trim().toLowerCase(),
    criadoEm:      admin.firestore.FieldValue.serverTimestamp(),
    criadoPor:     uid,
  });

  return { ok: true, uid: newUser.uid };
}

// ── Exports ───────────────────────────────────────────────────────────────────

exports.registrarPonto          = onCall({ region: REGION }, registrarPontoHandler);
exports.criarContaFuncionario   = onCall({ region: REGION }, criarContaFuncionarioHandler);

// Handlers exportados para testes diretos (sem onCall wrapper)
exports._registrarPontoHandler        = registrarPontoHandler;
exports._criarContaFuncionarioHandler = criarContaFuncionarioHandler;
