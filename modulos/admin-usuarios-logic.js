// admin-usuarios-logic.js — N35.17.1
// Lógica PURA do salvamento de usuários da Administração (sem DOM, sem Firebase).
// Incluída por admin.html e testada em functions/test/n35-17-1-admin-queue.test.js.
//
// Regra de ouro: salvar NUNCA apaga módulo que a tela não está alterando explicitamente.
// Módulos desconhecidos (de outras telas, ou criados no futuro) são preservados como estão.
// Fila Comercial: permissões (módulos) ≠ participação na distribuição (sistema_usuarios.filaComercial).
(function (root) {
  'use strict';

  var MOD_OPERAR = 'fila-comercial-operar';
  var MOD_GESTAO = 'fila-comercial-gestao';
  var LIMITE_MIN = 1;
  var LIMITE_MAX = 30;
  var LIMITE_PADRAO = 10;

  function unicos(lista) {
    var vistos = {}; var out = [];
    (lista || []).forEach(function (m) { if (typeof m === 'string' && m && !vistos[m]) { vistos[m] = true; out.push(m); } });
    return out;
  }

  /**
   * Módulos a salvar.
   * @param {object} p
   * @param {string[]} p.existentes     — modulos atuais no Firestore (lidos no momento do salvar)
   * @param {string[]} p.idsDaTela      — módulos que a grade da tela controla (MODULOS_DEF)
   * @param {string[]} p.marcadosNaTela — módulos da grade marcados
   * @param {boolean}  p.isAdmin        — admin: todos os módulos DA GRADE (nunca os da fila)
   * @param {boolean}  p.filaOperar     — checkbox "Pode operar a Fila Comercial"
   * @param {boolean}  p.filaGestao     — checkbox "Gestão / acompanhamento da Fila Comercial"
   */
  function calcularModulos(p) {
    var existentes = unicos(p.existentes);
    var gerenciados = {};
    (p.idsDaTela || []).forEach(function (m) { gerenciados[m] = true; });
    gerenciados[MOD_OPERAR] = true;
    gerenciados[MOD_GESTAO] = true;

    var desejados = {};
    var daGrade = p.isAdmin ? (p.idsDaTela || []) : (p.marcadosNaTela || []).filter(function (m) { return (p.idsDaTela || []).indexOf(m) >= 0; });
    daGrade.forEach(function (m) { desejados[m] = true; });
    if (p.filaOperar) desejados[MOD_OPERAR] = true;
    if (p.filaGestao) desejados[MOD_GESTAO] = true;

    // mantém a ordem existente: desconhecidos sempre ficam; gerenciados ficam só se desejados
    var out = existentes.filter(function (m) { return !gerenciados[m] || desejados[m]; });
    Object.keys(desejados).forEach(function (m) { if (out.indexOf(m) < 0) out.push(m); });
    return out;
  }

  function validarLimite(v) {
    var n = typeof v === 'string' && v.trim() !== '' ? Number(v) : v;
    if (typeof n !== 'number' || !isFinite(n) || Math.floor(n) !== n) return { ok: false, erro: 'Novas oportunidades por dia deve ser um número inteiro.' };
    if (n < LIMITE_MIN || n > LIMITE_MAX) return { ok: false, erro: 'Novas oportunidades por dia deve ficar entre ' + LIMITE_MIN + ' e ' + LIMITE_MAX + '.' };
    return { ok: true, valor: n };
  }

  /**
   * Configuração filaComercial a salvar (contrato N35.17: { ativo, recebeNovasOportunidades, limiteNovasPorDia }).
   * Retorna { valor } — valor === undefined significa "não gravar o campo" (preserva o que existir).
   *  - sem "Pode operar": controles de distribuição desabilitados → configuração existente preservada intacta
   *  - participa=SIM: ativo=true, recebeNovasOportunidades=true, limite validado (1..30)
   *  - participa=NÃO com configuração existente: pausa (recebeNovas=false), preserva ativo e limite
   *  - participa=NÃO sem configuração: nada é criado (gestão/não-vendedor nunca ganha distribuição)
   */
  function calcularFilaComercial(p) {
    var existente = p.existente && typeof p.existente === 'object' ? p.existente : null;
    if (!p.podeOperar) return { valor: undefined };
    if (p.participa) {
      var v = validarLimite(p.limite);
      if (!v.ok) return { erro: v.erro };
      return { valor: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: v.valor } };
    }
    if (!existente) return { valor: undefined };
    var pausado = {};
    Object.keys(existente).forEach(function (k) { pausado[k] = existente[k]; });
    pausado.recebeNovasOportunidades = false;
    return { valor: pausado };
  }

  /** Valores iniciais da seção "Fila Comercial" a partir do documento. */
  function estadoInicialFila(doc) {
    var mods = (doc && Array.isArray(doc.modulos)) ? doc.modulos : [];
    var fc = doc && doc.filaComercial && typeof doc.filaComercial === 'object' ? doc.filaComercial : null;
    var lim = fc && Number.isInteger(fc.limiteNovasPorDia) ? fc.limiteNovasPorDia : LIMITE_PADRAO;
    return {
      podeOperar: mods.indexOf(MOD_OPERAR) >= 0,
      gestao: mods.indexOf(MOD_GESTAO) >= 0,
      participa: !!(fc && fc.ativo === true && fc.recebeNovasOportunidades === true),
      limite: lim,
      temConfiguracao: !!fc,
    };
  }

  /**
   * Payload completo para setDoc(..., { merge: true }) em sistema_usuarios/{uid}.
   * @param {object|null} existente — documento atual (relido no momento do salvar) ou null (usuário novo)
   * @param {object} form — { nome, cargo, email, isAdmin, bloqueado, idsDaTela, marcadosNaTela, filaOperar, filaGestao, filaParticipa, filaLimite }
   * @returns {{ dados?: object, erro?: string }}
   */
  function montarPayloadUsuario(existente, form) {
    var modulos = calcularModulos({
      existentes: existente && existente.modulos, idsDaTela: form.idsDaTela, marcadosNaTela: form.marcadosNaTela,
      isAdmin: !!form.isAdmin, filaOperar: !!form.filaOperar, filaGestao: !!form.filaGestao,
    });
    var fc = calcularFilaComercial({
      existente: existente && existente.filaComercial, podeOperar: !!form.filaOperar,
      participa: !!form.filaParticipa, limite: form.filaLimite,
    });
    if (fc.erro) return { erro: fc.erro };
    var dados = { nome: form.nome, cargo: form.cargo, email: form.email, modulos: modulos, admin: !!form.isAdmin, bloqueado: !!form.bloqueado };
    if (fc.valor !== undefined) dados.filaComercial = fc.valor;
    return { dados: dados };
  }

  var api = {
    MOD_OPERAR: MOD_OPERAR, MOD_GESTAO: MOD_GESTAO, LIMITE_MIN: LIMITE_MIN, LIMITE_MAX: LIMITE_MAX, LIMITE_PADRAO: LIMITE_PADRAO,
    calcularModulos: calcularModulos, calcularFilaComercial: calcularFilaComercial, validarLimite: validarLimite,
    estadoInicialFila: estadoInicialFila, montarPayloadUsuario: montarPayloadUsuario,
  };
  root.AdminUsuariosLogic = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
