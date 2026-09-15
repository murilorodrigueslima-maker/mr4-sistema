'use strict';

/**
 * Testes F1-F5, P1-P6, G1-G7
 *
 * Cobre os três bugs corrigidos em ponto.html e ponto-func.html:
 *   F – jornada não populada ao editar funcionário
 *   P – foto de referência salva sem validação facial
 *   G – batidaEmProgresso não resetado nos retornos de GPS
 *
 * Todos os testes são unitários puros (sem DOM, sem Firebase, sem face-api real).
 * A lógica de decisão é replicada como funções puras, seguindo o padrão de
 * ponto-auth.unit.test.js.
 */

// ─── F — Jornada: mapeamento do campo no formulário ──────────────────────────

/**
 * Simula o mapeamento que abrirModalFunc() faz ao carregar um funcionário.
 * Retorna o valor que será atribuído a f-jornada.value.
 */
function mapearJornadaParaSelect(funcDoc) {
  return funcDoc.jornada || '8';
}

/**
 * Simula o payload gerado por salvarFuncionario().
 * Recebe o valor atual do select (após mapeamento) e retorna o payload.
 */
function buildPayloadFuncionario(selectJornada, fotoNova, isNovo) {
  const data = {
    nome: 'Funcionário Teste',
    jornada: selectJornada,
  };
  if (fotoNova) data.foto = fotoNova;
  if (isNovo) data.criadoEm = '2026-09-15T00:00:00.000Z';
  // campos de banco de horas NÃO aparecem no payload (merge:true preserva)
  return data;
}

describe('F — Jornada: população correta do select ao editar', () => {
  test('F1 — funcionário jornada 8 → select recebe "8"', () => {
    const f = { jornada: '8' };
    expect(mapearJornadaParaSelect(f)).toBe('8');
  });

  test('F2 — funcionário jornada 6 → select recebe "6"', () => {
    const f = { jornada: '6' };
    expect(mapearJornadaParaSelect(f)).toBe('6');
  });

  test('F3 — editar somente foto de funcionário jornada 6 → payload mantém jornada "6"', () => {
    const f = { jornada: '6' };
    const selectValor = mapearJornadaParaSelect(f);
    const payload = buildPayloadFuncionario(selectValor, 'data:image/jpeg;base64,NOVA', false);
    expect(payload.jornada).toBe('6');
    expect(payload.foto).toBe('data:image/jpeg;base64,NOVA');
  });

  test('F4 — payload NÃO inclui controleBancoHoras, inicioBancoHoras, afastamentoBanco', () => {
    const f = { jornada: '8' };
    const payload = buildPayloadFuncionario(mapearJornadaParaSelect(f), null, false);
    expect(payload).not.toHaveProperty('controleBancoHoras');
    expect(payload).not.toHaveProperty('inicioBancoHoras');
    expect(payload).not.toHaveProperty('afastamentoBanco');
    expect(payload).not.toHaveProperty('calcBancoMes');
  });

  test('F5 — funcionário novo sem jornada definida → default "8"', () => {
    const f = {};
    expect(mapearJornadaParaSelect(f)).toBe('8');
  });
});

// ─── P — Foto: gate de validação facial antes do save ────────────────────────

/**
 * Simula a lógica de salvarFuncionario() para o trecho de validação da foto.
 * Parâmetros simulam o resultado de _carregarModelosCadastro e _detectarRostoFoto.
 *
 * Retorna:
 *   { saved: true }                      → foto foi incluída no payload e save ocorreu
 *   { saved: false, reason: 'no_models'} → modelos não carregaram
 *   { saved: false, reason: 'no_face'}   → nenhum rosto detectado
 *   { saved: true, fotoIncluida: false } → fotoNova=null, skip de validação (foto antiga preservada)
 */
async function simularSalvarFuncionario({ fotoNova, modelosOk, rostoDetectado }) {
  // Gate: só entra se fotoNova estiver definida
  if (!fotoNova) return { saved: true, fotoIncluida: false };

  // Simula _carregarModelosCadastro
  if (!modelosOk) return { saved: false, reason: 'no_models' };

  // Simula _detectarRostoFoto
  if (!rostoDetectado) return { saved: false, reason: 'no_face' };

  // Passou validação → inclui foto no payload e salva
  return { saved: true, fotoIncluida: true };
}

describe('P — Foto: validação facial antes do save', () => {
  test('P1 — foto válida com rosto detectado → aceita e salva', async () => {
    const r = await simularSalvarFuncionario({
      fotoNova: 'data:image/jpeg;base64,VALIDA',
      modelosOk: true,
      rostoDetectado: true,
    });
    expect(r.saved).toBe(true);
    expect(r.fotoIncluida).toBe(true);
  });

  test('P2 — foto sem rosto detectado → rejeita', async () => {
    const r = await simularSalvarFuncionario({
      fotoNova: 'data:image/jpeg;base64,SEMROSTO',
      modelosOk: true,
      rostoDetectado: false,
    });
    expect(r.saved).toBe(false);
    expect(r.reason).toBe('no_face');
  });

  test('P3 — foto sem rosto → Firestore NÃO recebe nova foto (saved=false)', async () => {
    const r = await simularSalvarFuncionario({
      fotoNova: 'data:image/jpeg;base64,SEMROSTO',
      modelosOk: true,
      rostoDetectado: false,
    });
    expect(r.saved).toBe(false);
    // saved=false significa que fbSet não foi chamado — Firestore intacto
  });

  test('P4 — erro ao carregar modelos face-api → não salva silenciosamente', async () => {
    const r = await simularSalvarFuncionario({
      fotoNova: 'data:image/jpeg;base64,QUALQUER',
      modelosOk: false,
      rostoDetectado: false, // irrelevante, modelos falharam primeiro
    });
    expect(r.saved).toBe(false);
    expect(r.reason).toBe('no_models');
  });

  test('P5 — foto antiga preservada: quando fotoNova rejeitada, foto anterior permanece no Firestore', async () => {
    // Foto antiga está no Firestore. fotoNova foi selecionada mas rejeitada.
    // Como saved=false, fbSet não é chamado → foto no Firestore não muda.
    const r = await simularSalvarFuncionario({
      fotoNova: 'data:image/jpeg;base64,RUIM',
      modelosOk: true,
      rostoDetectado: false,
    });
    expect(r.saved).toBe(false);
    // Foto antiga está segura: nenhum write ocorreu
  });

  test('P6 — editar funcionário sem trocar foto (fotoNova=null) → skip validação, foto permanece intacta', async () => {
    const r = await simularSalvarFuncionario({
      fotoNova: null,
      modelosOk: true,   // não importa — nem é chamado
      rostoDetectado: true,
    });
    expect(r.saved).toBe(true);
    expect(r.fotoIncluida).toBe(false); // foto não vai no payload → merge preserva a do Firestore
  });
});

// ─── G — GPS: batidaEmProgresso reseta em todos os retornos de GPS ────────────

const RAIO = 200;
const EMP_LAT = -3.7603154;
const EMP_LNG = -38.5634329;

function distM(lat1, lng1, lat2, lng2) {
  const R = 6371000;
  const dLat = ((lat2 - lat1) * Math.PI) / 180;
  const dLng = ((lng2 - lng1) * Math.PI) / 180;
  const a =
    Math.sin(dLat / 2) ** 2 +
    Math.cos((lat1 * Math.PI) / 180) *
      Math.cos((lat2 * Math.PI) / 180) *
      Math.sin(dLng / 2) ** 2;
  return R * 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
}

/**
 * Replica a lógica de iniciarBatida() como função pura.
 * Retorna o estado final do flag e a ação tomada.
 */
function simularIniciarBatida({ batidaEmProgresso, prox, foto, modalidade, locAtual, dist }) {
  // Guard duplo toque
  if (batidaEmProgresso) return { batidaEmProgresso: true, acao: 'guard' };
  batidaEmProgresso = true;

  // Ponto completo
  if (!prox) return { batidaEmProgresso: false, acao: 'completo' };

  // Sem foto
  if (!foto) return { batidaEmProgresso: false, acao: 'sem_foto' };

  // GPS check
  if ((modalidade || 'PRESENCIAL') === 'PRESENCIAL') {
    if (locAtual === null) {
      // CORREÇÃO: batidaEmProgresso=false antes de return
      batidaEmProgresso = false;
      return { batidaEmProgresso, acao: 'gps_nulo' };
    }
    const d = dist !== undefined ? dist : distM(locAtual.lat, locAtual.lng, EMP_LAT, EMP_LNG);
    if (d > RAIO) {
      // CORREÇÃO: batidaEmProgresso=false antes de return
      batidaEmProgresso = false;
      return { batidaEmProgresso, acao: 'gps_fora' };
    }
  }

  return { batidaEmProgresso: true, acao: 'camera' };
}

describe('G — GPS: batidaEmProgresso reseta em bloqueios de GPS', () => {
  const BASE = { batidaEmProgresso: false, prox: { tipo: 'entrada' }, foto: 'url.jpg', modalidade: 'PRESENCIAL' };

  test('G1 — GPS nulo (locAtual===null) → bloqueia batida e exibe GPS screen', () => {
    const r = simularIniciarBatida({ ...BASE, locAtual: null });
    expect(r.acao).toBe('gps_nulo');
  });

  test('G2 — após bloqueio GPS nulo → batidaEmProgresso volta para false', () => {
    const r = simularIniciarBatida({ ...BASE, locAtual: null });
    expect(r.batidaEmProgresso).toBe(false);
  });

  test('G3 — nova tentativa após GPS nulo (sem reload) → funciona normalmente', () => {
    // Primeira tentativa: GPS bloqueia, flag reseta
    const r1 = simularIniciarBatida({ ...BASE, locAtual: null });
    expect(r1.batidaEmProgresso).toBe(false);
    // Segunda tentativa: GPS resolvido → deve chegar à câmera
    const r2 = simularIniciarBatida({
      ...BASE,
      batidaEmProgresso: r1.batidaEmProgresso,
      locAtual: { lat: EMP_LAT, lng: EMP_LNG },
      dist: 50,
    });
    expect(r2.acao).toBe('camera');
  });

  test('G4 — GPS fora do raio (dist > RAIO) → bloqueia batida', () => {
    const r = simularIniciarBatida({
      ...BASE,
      locAtual: { lat: -3.77, lng: -38.57 },
      dist: RAIO + 1,
    });
    expect(r.acao).toBe('gps_fora');
  });

  test('G5 — após bloqueio GPS fora do raio → batidaEmProgresso volta para false', () => {
    const r = simularIniciarBatida({
      ...BASE,
      locAtual: { lat: -3.77, lng: -38.57 },
      dist: RAIO + 1,
    });
    expect(r.batidaEmProgresso).toBe(false);
  });

  test('G6 — nova tentativa após estar fora do raio → funciona quando dentro do raio', () => {
    const r1 = simularIniciarBatida({ ...BASE, locAtual: { lat: -3.77, lng: -38.57 }, dist: RAIO + 1 });
    expect(r1.batidaEmProgresso).toBe(false);
    const r2 = simularIniciarBatida({
      ...BASE,
      batidaEmProgresso: r1.batidaEmProgresso,
      locAtual: { lat: EMP_LAT, lng: EMP_LNG },
      dist: 50,
    });
    expect(r2.acao).toBe('camera');
  });

  test('G7 — guard duplo-toque: batidaEmProgresso=true inicial bloqueia nova chamada sem trava', () => {
    // Guard dispara ANTES de mudar o flag → o flag permanece true (bloqueio intencional de duplo-toque)
    const r = simularIniciarBatida({
      ...BASE,
      batidaEmProgresso: true,
      locAtual: { lat: EMP_LAT, lng: EMP_LNG },
      dist: 50,
    });
    expect(r.acao).toBe('guard');
    expect(r.batidaEmProgresso).toBe(true); // permanece true — câmera está aberta
  });

  test('G — HOME_OFFICE ignora GPS: locAtual=null não bloqueia', () => {
    const r = simularIniciarBatida({ ...BASE, modalidade: 'HOME_OFFICE', locAtual: null });
    expect(r.acao).toBe('camera');
    expect(r.batidaEmProgresso).toBe(true);
  });
});
