'use strict';

/**
 * Testes E2E — Auth + Firestore Emulator (sem Functions Emulator HTTP)
 * Os handlers são chamados diretamente com admin SDK apontando para emuladores.
 *
 * Pré-requisito:
 *   firebase emulators:start --only auth,firestore
 *   (portas: firestore=8080, auth=9099)
 *
 * Executar:
 *   cd functions && npm run test:e2e
 */

// !! DEVE ser definido ANTES de qualquer require do firebase-admin !!
process.env.FIRESTORE_EMULATOR_HOST     = 'localhost:8080';
process.env.FIREBASE_AUTH_EMULATOR_HOST = 'localhost:9099';
process.env.GCLOUD_PROJECT              = 'mr4-ponto';
// Cooldown 0 para testes de sequência; o teste de concorrência redefine para 10000
process.env.PONTO_COOLDOWN_MS = '0';

const admin = require('firebase-admin');
if (!admin.apps.length) {
  admin.initializeApp({ projectId: 'mr4-ponto' });
}
const db        = admin.firestore();
const authAdmin = admin.auth();

// Carrega handlers APÓS env vars + initializeApp
const { _registrarPontoHandler, _criarContaFuncionarioHandler } = require('../index');

// ── IDs de teste ──────────────────────────────────────────────────────────────
const UID_GESTOR  = 'uid-gestor-e2e';
const UID_FUNC_A  = 'uid-func-a-e2e';
const UID_FUNC_B  = 'uid-func-b-e2e';
const UID_SEM_DOC = 'uid-sem-doc-e2e';
const FUNC_ID_A   = 'func-e2e-001';
const FUNC_ID_B   = 'func-e2e-002';
const FUNC_ID_C   = 'func-e2e-003'; // para criarContaFuncionario

// Coordenadas: dentro do raio da empresa
const GPS_DENTRO = { lat: -3.7603154, lng: -38.5634329 };
// Coordenadas: fora do raio (~5 km)
const GPS_FORA   = { lat: -3.800, lng: -38.563 };

// Helper para chamar handler com auth mockado
function req(uid, data = {}) {
  return { auth: { uid, token: {} }, data };
}
function reqSemAuth(data = {}) {
  return { auth: null, data };
}

// ── Setup / Teardown ──────────────────────────────────────────────────────────

beforeAll(async () => {
  // Limpa dados antigos de testes anteriores
  await limparColecao('registros');
  await limparColecao('usuarios_e2e_criados');

  // Seed: gestor
  await db.collection('users').doc(UID_GESTOR).set({
    role: 'gestor', ativo: true, nome: 'Gestor E2E',
  });

  // Seed: FUNC_A — PRESENCIAL
  await db.collection('users').doc(UID_FUNC_A).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_A, nome: 'Func A E2E',
  });
  await db.collection('funcionarios').doc(FUNC_ID_A).set({
    nome: 'Func A E2E', cargo: 'Vendedor', modalidade: 'PRESENCIAL',
  });

  // Seed: FUNC_B — também PRESENCIAL (para teste de payload malicioso)
  await db.collection('users').doc(UID_FUNC_B).set({
    role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_B, nome: 'Func B E2E',
  });
  await db.collection('funcionarios').doc(FUNC_ID_B).set({
    nome: 'Func B E2E', cargo: 'Caixa', modalidade: 'PRESENCIAL',
  });

  // Seed: funcionario para criarContaFuncionario
  await db.collection('funcionarios').doc(FUNC_ID_C).set({
    nome: 'Func C E2E', cargo: 'Estoquista', modalidade: 'PRESENCIAL',
  });

  // Auth emulator: criar usuário para FUNC_A (necessário para criarContaFuncionario dup check)
  try {
    await authAdmin.createUser({ uid: UID_FUNC_A, email: 'funca@test.mr4', password: 'senha123' });
  } catch {}
  try {
    await authAdmin.createUser({ uid: UID_GESTOR, email: 'gestor@test.mr4', password: 'senha123' });
  } catch {}
});

afterAll(async () => {
  await limparColecao('registros');
  // Limpeza de users criados nos testes
  const usersSnap = await db.collection('users').get();
  const batch = db.batch();
  usersSnap.docs
    .filter(d => d.id.endsWith('-e2e') || d.id.startsWith('novo-uid-'))
    .forEach(d => batch.delete(d.ref));
  await batch.commit();
});

async function limparColecao(nome) {
  const snap = await db.collection(nome).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

async function limparRegistrosFunc(funcId) {
  const snap = await db.collection('registros').where('funcId', '==', funcId).get();
  const batch = db.batch();
  snap.docs.forEach(d => batch.delete(d.ref));
  await batch.commit();
}

// Utilitário: pequeno delay para simular tempo entre batidas
function delay(ms) { return new Promise(r => setTimeout(r, ms)); }

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 3: Usuário sem users/{uid}
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 3 — Usuário autenticado sem users/{uid}', () => {
  test('3a — registrarPonto sem doc users/ → not-found', async () => {
    await expect(
      _registrarPontoHandler(req(UID_SEM_DOC, GPS_DENTRO))
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  test('3b — criarContaFuncionario sem doc users/ → permission-denied', async () => {
    await expect(
      _criarContaFuncionarioHandler(req(UID_SEM_DOC, {
        email: 'x@x.com', senha: 'abc123', funcId: FUNC_ID_A, funcNome: 'X',
      }))
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 4: Variações de role
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 4 — Variações de role', () => {
  const UID_ROLE = 'uid-role-test';

  afterEach(async () => {
    await db.collection('users').doc(UID_ROLE).delete().catch(() => {});
  });

  async function testarRole(campos, acao) {
    await db.collection('users').doc(UID_ROLE).set(campos);
    return acao(UID_ROLE);
  }

  test('4a — role=funcionario + ativo=true → pode registrar ponto (sem gestor)', async () => {
    // funcionario com funcId válido pode chamar registrarPonto
    await db.collection('users').doc(UID_ROLE).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_ID_A,
    });
    const result = await _registrarPontoHandler(req(UID_ROLE, GPS_DENTRO));
    expect(result.ok).toBe(true);
    await limparRegistrosFunc(FUNC_ID_A);
  });

  test('4b — role=gestor + ativo=true → NÃO pode registrar ponto (permission-denied)', async () => {
    await db.collection('users').doc(UID_ROLE).set({ role: 'gestor', ativo: true });
    await expect(
      _registrarPontoHandler(req(UID_ROLE, GPS_DENTRO))
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('4c — role=admin → NÃO pode registrar ponto (permission-denied)', async () => {
    await db.collection('users').doc(UID_ROLE).set({
      role: 'admin', ativo: true, funcionarioId: FUNC_ID_A,
    });
    await expect(
      _registrarPontoHandler(req(UID_ROLE, GPS_DENTRO))
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('4d — role="" (vazio) → NÃO pode registrar ponto', async () => {
    await db.collection('users').doc(UID_ROLE).set({
      role: '', ativo: true, funcionarioId: FUNC_ID_A,
    });
    await expect(
      _registrarPontoHandler(req(UID_ROLE, GPS_DENTRO))
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('4e — role ausente → NÃO pode registrar ponto', async () => {
    await db.collection('users').doc(UID_ROLE).set({
      ativo: true, funcionarioId: FUNC_ID_A,
    });
    await expect(
      _registrarPontoHandler(req(UID_ROLE, GPS_DENTRO))
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('4f — role=GESTOR (maiúsculo) → NÃO vira gestor (case-sensitive)', async () => {
    await db.collection('users').doc(UID_ROLE).set({ role: 'GESTOR', ativo: true });
    await expect(
      _criarContaFuncionarioHandler(req(UID_ROLE, {
        email: 'x@x.com', senha: 'abc123', funcId: FUNC_ID_C, funcNome: 'X',
      }))
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('4g — role=gestor + ativo=false → NÃO pode criar conta', async () => {
    await db.collection('users').doc(UID_ROLE).set({ role: 'gestor', ativo: false });
    await expect(
      _criarContaFuncionarioHandler(req(UID_ROLE, {
        email: 'x@x.com', senha: 'abc123', funcId: FUNC_ID_C, funcNome: 'X',
      }))
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('4h — gestor ativo=true → pode criar conta', async () => {
    await db.collection('users').doc(UID_ROLE).set({ role: 'gestor', ativo: true });
    const result = await _criarContaFuncionarioHandler(req(UID_ROLE, {
      email: `novo-${Date.now()}@test.mr4`, senha: 'senha123',
      funcId: FUNC_ID_C, funcNome: 'Func C E2E',
    }));
    expect(result.ok).toBe(true);
    // Limpa o user criado
    await authAdmin.deleteUser(result.uid).catch(() => {});
    await db.collection('users').doc(result.uid).delete().catch(() => {});
    // Limpa o vínculo para próximos testes
    const usersSnap = await db.collection('users').where('funcionarioId', '==', FUNC_ID_C).get();
    const batch = db.batch();
    usersSnap.docs.forEach(d => batch.delete(d.ref));
    await batch.commit();
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 5: registrarPonto end-to-end (5 batidas)
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 5 — registrarPonto E2E: sequência de 5 batidas', () => {
  const FUNC_E2E = 'func-seq-e2e';
  const UID_SEQE = 'uid-seq-e2e';

  beforeAll(async () => {
    await db.collection('users').doc(UID_SEQE).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_E2E, nome: 'Seq E2E',
    });
    await db.collection('funcionarios').doc(FUNC_E2E).set({
      nome: 'Seq E2E', modalidade: 'PRESENCIAL',
    });
    await limparRegistrosFunc(FUNC_E2E);
  });

  afterAll(async () => {
    await limparRegistrosFunc(FUNC_E2E);
    await db.collection('users').doc(UID_SEQE).delete().catch(() => {});
    await db.collection('funcionarios').doc(FUNC_E2E).delete().catch(() => {});
  });

  let regs = [];

  test('5a — 1ª batida → tipo=entrada', async () => {
    const r = await _registrarPontoHandler(req(UID_SEQE, GPS_DENTRO));
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('entrada');
    regs.push(r);
  });

  test('5b — 2ª batida → tipo=saida_almoco', async () => {
    await delay(50);
    const r = await _registrarPontoHandler(req(UID_SEQE, GPS_DENTRO));
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('saida_almoco');
    regs.push(r);
  });

  test('5c — 3ª batida → tipo=retorno_almoco', async () => {
    await delay(50);
    const r = await _registrarPontoHandler(req(UID_SEQE, GPS_DENTRO));
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('retorno_almoco');
    regs.push(r);
  });

  test('5d — 4ª batida → tipo=saida', async () => {
    await delay(50);
    const r = await _registrarPontoHandler(req(UID_SEQE, GPS_DENTRO));
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('saida');
    regs.push(r);
  });

  test('5e — 5ª tentativa → PONTO COMPLETO (failed-precondition)', async () => {
    await delay(50);
    await expect(
      _registrarPontoHandler(req(UID_SEQE, GPS_DENTRO))
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('5f — Firestore contém exatamente 4 registros com tipos corretos', async () => {
    const snap = await db.collection('registros').where('funcId', '==', FUNC_E2E).get();
    const { Timestamp } = require('firebase-admin/firestore');
    const docs = snap.docs.map(d => d.data()).sort((a, b) => {
      if (a.hora !== b.hora) return a.hora > b.hora ? 1 : -1;
      const ta = a.criadoEm && a.criadoEm.toMillis ? a.criadoEm.toMillis() : 0;
      const tb = b.criadoEm && b.criadoEm.toMillis ? b.criadoEm.toMillis() : 0;
      return ta - tb;
    });
    expect(docs.length).toBe(4);
    expect(docs[0].tipo).toBe('entrada');
    expect(docs[1].tipo).toBe('saida_almoco');
    expect(docs[2].tipo).toBe('retorno_almoco');
    expect(docs[3].tipo).toBe('saida');
    // Todos foram definidos pelo backend
    docs.forEach(d => {
      expect(d.funcId).toBe(FUNC_E2E);       // SERVIDOR
      expect(d.authUid).toBe(UID_SEQE);      // SERVIDOR
      expect(d.data).toMatch(/^\d{4}-\d{2}-\d{2}$/); // SERVIDOR
      expect(d.hora).toMatch(/^\d{2}:\d{2}:\d{2}$/); // SERVIDOR
      expect(d.modalidade).toBe('PRESENCIAL');         // SERVIDOR
    });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 6: Campos gravados — server vs cliente
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 6 — Campos gravados no documento', () => {
  const FUNC_CAM = 'func-campos-e2e';
  const UID_CAM  = 'uid-campos-e2e';

  beforeAll(async () => {
    await db.collection('users').doc(UID_CAM).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_CAM, nome: 'Campos E2E',
    });
    await db.collection('funcionarios').doc(FUNC_CAM).set({
      nome: 'Campos E2E', modalidade: 'PRESENCIAL',
    });
    await limparRegistrosFunc(FUNC_CAM);
  });

  afterAll(async () => {
    await limparRegistrosFunc(FUNC_CAM);
    await db.collection('users').doc(UID_CAM).delete().catch(() => {});
    await db.collection('funcionarios').doc(FUNC_CAM).delete().catch(() => {});
  });

  test('6 — documento contém todos os campos e classificação SERVIDOR/AUDITORIA está correta', async () => {
    const r = await _registrarPontoHandler(req(UID_CAM, {
      ...GPS_DENTRO,
      horaCliente: '08:00:00',
      facialScore: 87,
      foto: null,
    }));

    const snap = await db.collection('registros').doc(r.id).get();
    const d = snap.data();

    // ── CAMPOS SERVIDOR ────────────────────────────────────────────────────
    expect(d.funcId).toBe(FUNC_CAM);                          // SERVIDOR
    expect(d.authUid).toBe(UID_CAM);                          // SERVIDOR
    expect(d.funcNome).toBe('Campos E2E');                    // SERVIDOR
    expect(d.data).toMatch(/^\d{4}-\d{2}-\d{2}$/);           // SERVIDOR
    expect(d.hora).toMatch(/^\d{2}:\d{2}:\d{2}$/);           // SERVIDOR
    expect(d.tipo).toBe('entrada');                           // SERVIDOR
    expect(d.tipoLabel).toBe('Entrada');                      // SERVIDOR
    expect(d.modalidade).toBe('PRESENCIAL');                  // SERVIDOR
    expect(d.dentroRaio).toBe(true);                          // SERVIDOR (recalculado)
    expect(d.criadoEm).toBeDefined();                         // SERVIDOR (serverTimestamp)

    // ── CAMPOS CLIENTE/AUDITORIA ───────────────────────────────────────────
    expect(d.lat).toBeCloseTo(GPS_DENTRO.lat, 4);             // CLIENTE (coordenada bruta)
    expect(d.lng).toBeCloseTo(GPS_DENTRO.lng, 4);             // CLIENTE (coordenada bruta)
    expect(d.horaCliente).toBe('08:00:00');                   // CLIENTE/AUDITORIA
    expect(d.facialScore).toBe(87);                           // CLIENTE/AUDITORIA
    expect(d.foto).toBeNull();                                // CLIENTE/AUDITORIA

    // ── ID gerado server-side ──────────────────────────────────────────────
    expect(typeof d.id).toBe('string');
    expect(d.id.length).toBeGreaterThan(5);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 7: Payload malicioso
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 7 — Payload malicioso', () => {
  const FUNC_MAL = 'func-mal-e2e';
  const UID_MAL  = 'uid-mal-e2e';

  beforeAll(async () => {
    await db.collection('users').doc(UID_MAL).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_MAL, nome: 'Mal E2E',
    });
    await db.collection('funcionarios').doc(FUNC_MAL).set({
      nome: 'Mal E2E', modalidade: 'PRESENCIAL',
    });
    await limparRegistrosFunc(FUNC_MAL);
  });

  afterAll(async () => {
    await limparRegistrosFunc(FUNC_MAL);
    await db.collection('users').doc(UID_MAL).delete().catch(() => {});
    await db.collection('funcionarios').doc(FUNC_MAL).delete().catch(() => {});
  });

  test('7 — campos injetados no payload são ignorados pelo backend', async () => {
    // Payload malicioso: tenta injetar funcId errado, tipo, data, hora, dentroRaio, modalidade
    const payloadMalicioso = {
      ...GPS_DENTRO,
      // ↓ Campos que deveriam ser ignorados — todos controlados pelo servidor
      funcId:     FUNC_ID_B,          // tentativa de registrar como outro funcionário
      authUid:    'uid-outro',        // tentativa de alterar authUid
      tipo:       'saida',            // tentativa de forçar tipo
      data:       '2000-01-01',       // tentativa de alterar data
      hora:       '01:00:00',         // tentativa de alterar hora
      dentroRaio: true,               // tentativa de forçar dentroRaio
      modalidade: 'HOME_OFFICE',      // tentativa de alterar modalidade
    };

    const r = await _registrarPontoHandler(req(UID_MAL, payloadMalicioso));
    expect(r.ok).toBe(true);

    const snap = await db.collection('registros').doc(r.id).get();
    const d = snap.data();

    // ── Garantir que campos injetados NÃO afetaram o registro ─────────────
    expect(d.funcId).toBe(FUNC_MAL);    // NÃO foi FUNC_ID_B
    expect(d.authUid).toBe(UID_MAL);    // NÃO foi 'uid-outro'
    expect(d.tipo).toBe('entrada');     // NÃO foi 'saida' (sequência server-side)
    expect(d.data).not.toBe('2000-01-01');  // data real do servidor
    expect(d.hora).not.toBe('01:00:00');    // hora real do servidor
    expect(d.modalidade).toBe('PRESENCIAL'); // NÃO foi 'HOME_OFFICE'
    // dentroRaio recalculado: GPS_DENTRO está dentro do raio → true
    expect(d.dentroRaio).toBe(true);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 8: Relógio (horaCliente vs hora servidor)
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 8 — Relógio: hora oficial ≠ horaCliente', () => {
  const FUNC_REL = 'func-rel-e2e';
  const UID_REL  = 'uid-rel-e2e';

  beforeAll(async () => {
    await db.collection('users').doc(UID_REL).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_REL, nome: 'Rel E2E',
    });
    await db.collection('funcionarios').doc(FUNC_REL).set({
      nome: 'Rel E2E', modalidade: 'PRESENCIAL',
    });
    await limparRegistrosFunc(FUNC_REL);
  });

  afterAll(async () => {
    await limparRegistrosFunc(FUNC_REL);
    await db.collection('users').doc(UID_REL).delete().catch(() => {});
    await db.collection('funcionarios').doc(FUNC_REL).delete().catch(() => {});
  });

  test('8 — hora do documento vem do servidor, horaCliente é apenas auditoria', async () => {
    const horaFalsa = '01:00:00'; // relógio manipulado pelo cliente
    const r = await _registrarPontoHandler(req(UID_REL, {
      ...GPS_DENTRO, horaCliente: horaFalsa,
    }));

    const snap = await db.collection('registros').doc(r.id).get();
    const d = snap.data();

    // hora gravada é do servidor — provavelmente diferente de 01:00:00
    expect(d.horaCliente).toBe(horaFalsa); // armazenado para auditoria
    expect(d.hora).toMatch(/^\d{2}:\d{2}:\d{2}$/); // formato correto
    // hora servidor é a hora real — não pode ser 01:00:00 (a não ser que seja de madrugada no Ceará)
    // Verifica que o campo hora existe e foi derivado do servidor
    expect(d.hora).toBeDefined();
    expect(typeof d.hora).toBe('string');
    // horaCliente é armazenado separadamente para auditoria
    expect(d.horaCliente).not.toBeUndefined();
    console.log(`  hora servidor: ${d.hora} | horaCliente: ${d.horaCliente}`);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 10: GPS — cenários A–H
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 10 — GPS', () => {
  const FUNC_GPS_P = 'func-gps-pres-e2e';
  const UID_GPS_P  = 'uid-gps-pres-e2e';
  const FUNC_GPS_H = 'func-gps-home-e2e';
  const UID_GPS_H  = 'uid-gps-home-e2e';

  beforeAll(async () => {
    // PRESENCIAL
    await db.collection('users').doc(UID_GPS_P).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_GPS_P,
    });
    await db.collection('funcionarios').doc(FUNC_GPS_P).set({
      nome: 'GPS Pres', modalidade: 'PRESENCIAL',
    });
    // HOME_OFFICE
    await db.collection('users').doc(UID_GPS_H).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_GPS_H,
    });
    await db.collection('funcionarios').doc(FUNC_GPS_H).set({
      nome: 'GPS Home', modalidade: 'HOME_OFFICE',
    });
    await limparRegistrosFunc(FUNC_GPS_P);
    await limparRegistrosFunc(FUNC_GPS_H);
  });

  afterAll(async () => {
    await limparRegistrosFunc(FUNC_GPS_P);
    await limparRegistrosFunc(FUNC_GPS_H);
    for (const uid of [UID_GPS_P, UID_GPS_H]) {
      await db.collection('users').doc(uid).delete().catch(() => {});
    }
    for (const id of [FUNC_GPS_P, FUNC_GPS_H]) {
      await db.collection('funcionarios').doc(id).delete().catch(() => {});
    }
  });

  // ── PRESENCIAL ─────────────────────────────────────────────────────────────

  test('10A — PRESENCIAL: coordenada DENTRO do raio → PERMITIDO', async () => {
    const r = await _registrarPontoHandler(req(UID_GPS_P, GPS_DENTRO));
    expect(r.ok).toBe(true);
    expect(r.dentroRaio).toBe(true);
    await limparRegistrosFunc(FUNC_GPS_P);
  });

  test('10B — PRESENCIAL: coordenada FORA do raio → REJEITADO (failed-precondition)', async () => {
    await expect(
      _registrarPontoHandler(req(UID_GPS_P, GPS_FORA))
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  test('10C — PRESENCIAL: sem lat/lng (null) → REJEITADO (invalid-argument)', async () => {
    await expect(
      _registrarPontoHandler(req(UID_GPS_P, { lat: null, lng: null }))
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('10D — PRESENCIAL: lat="abc" (string) → REJEITADO (invalid-argument)', async () => {
    await expect(
      _registrarPontoHandler(req(UID_GPS_P, { lat: 'abc', lng: -38.56 }))
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('10E — PRESENCIAL: lat=999 (fora dos limites geográficos) → REJEITADO', async () => {
    await expect(
      _registrarPontoHandler(req(UID_GPS_P, { lat: 999, lng: -38.56 }))
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('10F — PRESENCIAL: cliente envia dentroRaio=true mas coordenada fora → REJEITADO', async () => {
    // dentroRaio enviado pelo cliente é completamente ignorado
    await expect(
      _registrarPontoHandler(req(UID_GPS_P, {
        ...GPS_FORA, dentroRaio: true, // tentativa de injeção — ignorada
      }))
    ).rejects.toMatchObject({ code: 'failed-precondition' });
  });

  // ── HOME_OFFICE ────────────────────────────────────────────────────────────

  test('10G — HOME_OFFICE: sem lat/lng → PERMITIDO (GPS opcional)', async () => {
    const r = await _registrarPontoHandler(req(UID_GPS_H, { lat: null, lng: null }));
    expect(r.ok).toBe(true);
    await limparRegistrosFunc(FUNC_GPS_H);
  });

  test('10H — modalidade do banco=PRESENCIAL ignora modalidade enviada pelo cliente', async () => {
    // FUNC_GPS_P é PRESENCIAL no banco; cliente tenta dizer HOME_OFFICE — ignorado
    await expect(
      _registrarPontoHandler(req(UID_GPS_P, {
        lat: null, lng: null,
        modalidade: 'HOME_OFFICE', // ignorado — modalidade vem do banco
      }))
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 12: Escrita direta em registros → DENIED (validado pelo rules test)
// registrarPonto() → ALLOWED
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 12 — Escrita direta vs Cloud Function', () => {
  const FUNC_DIR = 'func-dir-e2e';
  const UID_DIR  = 'uid-dir-e2e';

  beforeAll(async () => {
    await db.collection('users').doc(UID_DIR).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_DIR,
    });
    await db.collection('funcionarios').doc(FUNC_DIR).set({
      nome: 'Dir E2E', modalidade: 'PRESENCIAL',
    });
    await limparRegistrosFunc(FUNC_DIR);
  });

  afterAll(async () => {
    await limparRegistrosFunc(FUNC_DIR);
    await db.collection('users').doc(UID_DIR).delete().catch(() => {});
    await db.collection('funcionarios').doc(FUNC_DIR).delete().catch(() => {});
  });

  test('12a — Admin SDK pode criar registro (simula gestor/função) — não a regra do client', async () => {
    // Admin SDK bypassa as Rules — apenas valida que a lógica de dados funciona
    await db.collection('registros').doc('dir-admin-test').set({
      funcId: FUNC_DIR, tipo: 'entrada', data: '2026-09-08', hora: '08:00:00',
    });
    const snap = await db.collection('registros').doc('dir-admin-test').get();
    expect(snap.exists).toBe(true);
    await db.collection('registros').doc('dir-admin-test').delete();
  });

  test('12b — registrarPonto() via handler → ALLOWED (retorna comprovante)', async () => {
    const r = await _registrarPontoHandler(req(UID_DIR, GPS_DENTRO));
    expect(r.ok).toBe(true);
    expect(r.tipo).toBe('entrada');
    // Verifica que o documento existe no Firestore
    const snap = await db.collection('registros').doc(r.id).get();
    expect(snap.exists).toBe(true);
  });

  // Nota: o teste de escrita direta pelo client (PERMISSION_DENIED pelas Rules)
  // está coberto no Teste D das rules (rules.test.js), que usa o client SDK.
  test('12c — escrita direta pelo client é coberta pelo Teste D (rules.test.js)', () => {
    expect(true).toBe(true); // documentação — validado no emulador de rules
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 13: criarContaFuncionario — cenários A–H
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 13 — criarContaFuncionario', () => {
  const UID_GEST13 = 'uid-gest-13';
  const FUNC_13    = 'func-13-novo';
  const FUNC_13B   = 'func-13b-vinculado';
  const UID_FUNC13 = 'uid-func-13-vinculado';

  beforeAll(async () => {
    await db.collection('users').doc(UID_GEST13).set({ role: 'gestor', ativo: true });
    // Funcionário para criar conta
    await db.collection('funcionarios').doc(FUNC_13).set({ nome: 'Novo Func 13', cargo: 'Teste' });
    // Funcionário já vinculado (para teste E)
    await db.collection('funcionarios').doc(FUNC_13B).set({ nome: 'Vinculado 13', cargo: 'Teste' });
    await db.collection('users').doc(UID_FUNC13).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_13B,
    });
    try {
      await authAdmin.createUser({ uid: UID_GEST13, email: 'gest13@test.mr4', password: 'senha123' });
    } catch {}
  });

  afterAll(async () => {
    for (const uid of [UID_GEST13, UID_FUNC13]) {
      await db.collection('users').doc(uid).delete().catch(() => {});
    }
    await db.collection('funcionarios').doc(FUNC_13).delete().catch(() => {});
    await db.collection('funcionarios').doc(FUNC_13B).delete().catch(() => {});
  });

  test('13A — sem auth → unauthenticated', async () => {
    await expect(
      _criarContaFuncionarioHandler(reqSemAuth({ email: 'x@x.com', senha: 'abc123', funcId: FUNC_13, funcNome: 'X' }))
    ).rejects.toMatchObject({ code: 'unauthenticated' });
  });

  test('13B — funcionario tenta criar conta → permission-denied', async () => {
    await expect(
      _criarContaFuncionarioHandler(req(UID_FUNC_A, { email: 'x@x.com', senha: 'abc123', funcId: FUNC_13, funcNome: 'X' }))
    ).rejects.toMatchObject({ code: 'permission-denied' });
  });

  test('13C — gestor ativo cria conta → ok=true e users/{uid} criado', async () => {
    const email = `cf13c-${Date.now()}@test.mr4`;
    const r = await _criarContaFuncionarioHandler(req(UID_GEST13, {
      email, senha: 'senha123', funcId: FUNC_13, funcNome: 'Novo Func 13',
    }));
    expect(r.ok).toBe(true);
    const snap = await db.collection('users').doc(r.uid).get();
    expect(snap.exists).toBe(true);
    expect(snap.data().role).toBe('funcionario');
    expect(snap.data().ativo).toBe(true);
    expect(snap.data().funcionarioId).toBe(FUNC_13);
    // Limpa
    await authAdmin.deleteUser(r.uid).catch(() => {});
    await db.collection('users').doc(r.uid).delete().catch(() => {});
  });

  test('13D — funcionarioId inexistente → not-found', async () => {
    await expect(
      _criarContaFuncionarioHandler(req(UID_GEST13, {
        email: 'x@x.com', senha: 'abc123', funcId: 'func-nao-existe', funcNome: 'X',
      }))
    ).rejects.toMatchObject({ code: 'not-found' });
  });

  test('13E — funcionário já vinculado → already-exists', async () => {
    await expect(
      _criarContaFuncionarioHandler(req(UID_GEST13, {
        email: 'novoemail@x.com', senha: 'abc123', funcId: FUNC_13B, funcNome: 'X',
      }))
    ).rejects.toMatchObject({ code: 'already-exists' });
  });

  test('13F — e-mail inválido → invalid-argument', async () => {
    await expect(
      _criarContaFuncionarioHandler(req(UID_GEST13, {
        email: 'emailinvalido', senha: 'abc123', funcId: FUNC_13, funcNome: 'X',
      }))
    ).rejects.toMatchObject({ code: 'invalid-argument' });
  });

  test('13G — e-mail já existente → invalid-argument (tratado)', async () => {
    // Primeiro cria o usuário
    const emailDup = `dup13-${Date.now()}@test.mr4`;
    try { await authAdmin.createUser({ email: emailDup, password: 'senha123' }); } catch {}
    // Tenta criar novamente com mesmo e-mail
    await expect(
      _criarContaFuncionarioHandler(req(UID_GEST13, {
        email: emailDup, senha: 'senha123', funcId: FUNC_13, funcNome: 'X',
      }))
    ).rejects.toMatchObject({ code: 'invalid-argument' }); // mensagem amigável
  });

  test('13H — senha NÃO foi armazenada no Firestore', async () => {
    const email = `cf13h-${Date.now()}@test.mr4`;
    const r = await _criarContaFuncionarioHandler(req(UID_GEST13, {
      email, senha: 'minha-senha-secreta', funcId: FUNC_13, funcNome: 'Novo Func 13',
    }));
    expect(r.ok).toBe(true);
    const snap = await db.collection('users').doc(r.uid).get();
    const dados = snap.data();
    // Nenhum campo do documento deve conter a senha
    expect(JSON.stringify(dados)).not.toContain('minha-senha-secreta');
    // Limpa
    await authAdmin.deleteUser(r.uid).catch(() => {});
    await db.collection('users').doc(r.uid).delete().catch(() => {});
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 14: Concorrência real — Promise.all com duas batidas simultâneas
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 14 — Concorrência real (race condition)', () => {
  const FUNC_RACE = 'func-race-e2e';
  const UID_RACE  = 'uid-race-e2e';

  beforeAll(async () => {
    // Cooldown real (10 s) para este teste — garante que a 2ª chamada seja rejeitada
    process.env.PONTO_COOLDOWN_MS = '10000';

    await db.collection('users').doc(UID_RACE).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_RACE,
    });
    await db.collection('funcionarios').doc(FUNC_RACE).set({
      nome: 'Race E2E', modalidade: 'PRESENCIAL',
    });
    await limparRegistrosFunc(FUNC_RACE);
  });

  afterAll(async () => {
    // Restaura cooldown 0 (outros testes que eventualmente rodem depois)
    process.env.PONTO_COOLDOWN_MS = '0';

    await limparRegistrosFunc(FUNC_RACE);
    await db.collection('users').doc(UID_RACE).delete().catch(() => {});
    await db.collection('funcionarios').doc(FUNC_RACE).delete().catch(() => {});
  });

  test('14 — Promise.all(2 batidas) → exatamente 1 sucesso + 1 falha ou 2 sucessos distintos', async () => {
    const p1 = _registrarPontoHandler(req(UID_RACE, GPS_DENTRO)).catch(e => ({ erro: e.code }));
    const p2 = _registrarPontoHandler(req(UID_RACE, GPS_DENTRO)).catch(e => ({ erro: e.code }));

    const [r1, r2] = await Promise.all([p1, p2]);

    const snap = await db.collection('registros').where('funcId', '==', FUNC_RACE).get();
    const docs = snap.docs.map(d => d.data());

    console.log(`  Promise.all: r1=${JSON.stringify(r1)}, r2=${JSON.stringify(r2)}`);
    console.log(`  Documentos criados: ${docs.length}`);
    docs.forEach(d => console.log(`    tipo=${d.tipo} hora=${d.hora}`));

    // Cenário A: transação garantiu 1 entrada + 1 cooldown/precondition
    // Cenário B: sequência diferente (entrada + saida_almoco) se houve gap de tempo
    // Em QUALQUER caso: não pode haver dois documentos com tipo=entrada
    const entradas = docs.filter(d => d.tipo === 'entrada');
    expect(entradas.length).toBe(1);

    // Verifica que pelo menos 1 chamada foi bem-sucedida
    const sucessos = [r1, r2].filter(r => r.ok);
    expect(sucessos.length).toBeGreaterThanOrEqual(1);
  });
});

// ═════════════════════════════════════════════════════════════════════════════
// TESTE 11: Facial — limitação documentada
// ═════════════════════════════════════════════════════════════════════════════

describe('Teste 11 — Facial: limitação documentada', () => {
  const FUNC_FAC = 'func-fac-e2e';
  const UID_FAC  = 'uid-fac-e2e';

  beforeAll(async () => {
    await db.collection('users').doc(UID_FAC).set({
      role: 'funcionario', ativo: true, funcionarioId: FUNC_FAC,
    });
    await db.collection('funcionarios').doc(FUNC_FAC).set({
      nome: 'Fac E2E', modalidade: 'PRESENCIAL',
    });
    await limparRegistrosFunc(FUNC_FAC);
  });

  afterAll(async () => {
    await limparRegistrosFunc(FUNC_FAC);
    await db.collection('users').doc(UID_FAC).delete().catch(() => {});
    await db.collection('funcionarios').doc(FUNC_FAC).delete().catch(() => {});
  });

  test('11a — facialScore=0 (facial falhou no client) NÃO impede registrarPonto (apenas auditoria)', async () => {
    // RISCO ACEITO: usuário técnico pode chamar a CF diretamente sem passar pelo facial.
    // A barreira real é autenticação Firebase. Facial é apenas auditoria.
    const r = await _registrarPontoHandler(req(UID_FAC, { ...GPS_DENTRO, facialScore: 0 }));
    expect(r.ok).toBe(true);

    const snap = await db.collection('registros').doc(r.id).get();
    expect(snap.data().facialScore).toBe(0);  // armazenado para auditoria
    console.log('  RISCO ACEITO: facialScore=0 não impede o registro (limitação estrutural da web)');
  });

  test('11b — facialScore=100 NÃO é tratado como prova de identidade (apenas auditoria)', async () => {
    await delay(50);
    const r = await _registrarPontoHandler(req(UID_FAC, { ...GPS_DENTRO, facialScore: 100 }));
    expect(r.ok).toBe(true);

    const snap = await db.collection('registros').doc(r.id).get();
    expect(snap.data().facialScore).toBe(100);  // armazenado — não garante identidade real
  });
});
