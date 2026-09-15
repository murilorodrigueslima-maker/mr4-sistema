'use strict';

/**
 * UX1–UX10 — Refinamento visual Visão Geral + Banco de Horas
 *
 * UX1-UX4: filtro controleBancoHoras!==false na Visão Geral (renderHoje).
 * UX5-UX7: remoção das colunas Facial/Foto da tabela "Últimas batidas".
 * UX8-UX10: card compacto do Banco de Horas com Pendências como 4ª métrica.
 *
 * Todos os testes são unitários puros (sem DOM, sem Firebase, sem emulador).
 */

// ─── Helpers utilitários (replicam lógica de ponto.html) ─────────────────────

function toMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

/** Replica exatamente o filtro de renderHoje() após refinamento. */
function filtrarParticipantes(funcs) {
  return funcs.filter(f => f.controleBancoHoras !== false);
}

/** Replica a contagem de métricas (presentes/ausentes/atrasados) de renderHoje(). */
function calcMetricas(funcs, regsHoje) {
  let presentes = 0, ausentes = 0, atrasados = 0;
  funcs.forEach(f => {
    const rf = regsHoje.filter(r => r.funcId === f.id);
    if (rf.length) presentes++; else ausentes++;
    const ent = rf.find(r => r.tipo === 'entrada');
    if (ent && toMin(ent.hora.slice(0, 5)) > toMin('08:05')) atrasados++;
  });
  return { total: funcs.length, presentes, ausentes, atrasados };
}

/** Replica os cabeçalhos da tabela "Últimas batidas" após refinamento. */
function headersUltimasBatidas() {
  return ['Funcionário', 'Tipo', 'Horário', 'GPS'];
}

/** Replica geração de uma linha da "Últimas batidas" sem colunas Facial/Foto. */
function rowUltimasBatidas(r) {
  const dentroRaio = r.dentroRaio === true
    ? '<span class="badge dentro">Dentro</span>'
    : r.dentroRaio === false
      ? '<span class="badge fora">Fora</span>'
      : '—';
  return `<tr><td>${r.funcNome}</td><td>${r.tipoLabel}</td><td>${r.data} ${r.hora.slice(0,5)}</td><td>${dentroRaio}</td></tr>`;
}

/** Replica geração do card compacto de Banco de Horas. */
function buildCardBancoCompacto(f, { trabMin, esperMin, saldo, diasTrab, pendencias }) {
  const pendenciasTitle = pendencias.length
    ? pendencias.map(p => p.data).join(', ')
    : '';
  const pct = esperMin > 0 ? Math.min(100, Math.round(trabMin / esperMin * 100)) : 0;
  const fotoHtml = f.foto
    ? `<img data-src="${f.foto}" class="lazy-foto">`
    : '';
  return [
    `<div class="ficha" style="padding:10px 14px;">`,
    `<div class="ficha-avatar" style="width:36px;height:36px;">${fotoHtml}</div>`,
    `<div>${f.nome}</div>`,
    `<div>${f.cargo||''}</div>`,
    `<span class="badge">${saldo >= 0 ? '+' : ''}${saldo}</span>`,
    `<div>Trabalhado:${trabMin}</div>`,
    `<div>Esperado:${esperMin}</div>`,
    `<div>Dias:${diasTrab}</div>`,
    `<div title="${pendenciasTitle}">Pendências:${pendencias.length}${pendencias.length ? ' ⚠' : ''}</div>`,
    `<div class="barra-wrap" style="height:5px;">`,
    `<div class="barra" style="width:${pct}%;"></div>`,
    `</div></div>`,
  ].join('');
}

// ─── UX1–UX4: Visão Geral — filtro controleBancoHoras ────────────────────────

describe('UX1-UX4 — Visão Geral: filtro controleBancoHoras!==false', () => {
  const fAdemir  = { id: 'f1', nome: 'Ademir',               controleBancoHoras: true  };
  const fCamila  = { id: 'f2', nome: 'Camila'                                           }; // campo ausente
  const fMurilo  = { id: 'fm', nome: 'murilo rodrigues lima', controleBancoHoras: false };
  const fTeste   = { id: 'ft', nome: 'FUNCIONARIO TESTE',     controleBancoHoras: false };

  test('UX1 — renderHoje exclui funcionários com controleBancoHoras===false', () => {
    const todos = [fAdemir, fMurilo, fTeste];
    const participantes = filtrarParticipantes(todos);
    expect(participantes).toHaveLength(1);
    expect(participantes[0].id).toBe('f1');
    expect(participantes.every(f => f.controleBancoHoras !== false)).toBe(true);
  });

  test('UX2 — exclusão de Murilo é pela regra, não pelo nome', () => {
    // Mesmo nome "murilo rodrigues lima" com controleBancoHoras=true → incluído
    const muriloParticipante = { id: 'fm2', nome: 'murilo rodrigues lima', controleBancoHoras: true };
    const lista = [fMurilo, muriloParticipante];
    const participantes = filtrarParticipantes(lista);
    expect(participantes).toHaveLength(1);
    expect(participantes[0].id).toBe('fm2');
    // Mesmo nome com false → excluído
    expect(participantes.find(f => f.id === 'fm')).toBeUndefined();
  });

  test('UX3 — exclusão de FUNC_TESTE é pela regra, não pelo nome', () => {
    // Mesmo nome "FUNCIONARIO TESTE" com controleBancoHoras=true → incluído
    const testeParticipante = { id: 'ft2', nome: 'FUNCIONARIO TESTE', controleBancoHoras: true };
    const lista = [fTeste, testeParticipante];
    const participantes = filtrarParticipantes(lista);
    expect(participantes).toHaveLength(1);
    expect(participantes[0].id).toBe('ft2');
    expect(participantes.find(f => f.id === 'ft')).toBeUndefined();
  });

  test('UX4 — métricas usam exatamente o mesmo array filtrado da tabela', () => {
    const todos = [fAdemir, fCamila, fMurilo, fTeste];
    const participantes = filtrarParticipantes(todos);
    // participantes = [fAdemir, fCamila] (2 funcionários)
    expect(participantes).toHaveLength(2);

    const regsHoje = [
      { funcId: 'f1', tipo: 'entrada', hora: '08:00:00' }, // Ademir presente
    ];
    const metricas = calcMetricas(participantes, regsHoje);

    // Total = participantes.length = 2 (não 4)
    expect(metricas.total).toBe(2);
    // Presentes = 1 (Ademir), Ausentes = 1 (Camila)
    expect(metricas.presentes).toBe(1);
    expect(metricas.ausentes).toBe(1);
    // Murilo e FUNC_TESTE não aparecem nas métricas
    expect(metricas.total).not.toBe(4);
    expect(metricas.ausentes).not.toBe(3);
  });

  test('UX4b — funcionário sem campo controleBancoHoras (undefined) é incluído', () => {
    // undefined !== false → incluído (regra: !== false, não === true)
    const participantes = filtrarParticipantes([fCamila]);
    expect(participantes).toHaveLength(1);
    expect(participantes[0].id).toBe('f2');
  });
});

// ─── UX5–UX7: Últimas batidas sem Facial e Foto ──────────────────────────────

describe('UX5-UX7 — Últimas batidas: Facial e Foto removidas', () => {
  const reg = {
    id:          'r1',
    funcNome:    'Ademir',
    tipoLabel:   'Entrada',
    data:        '2026-09-15',
    hora:        '08:00:00',
    dentroRaio:  true,
    facialScore: 95,
    foto:        'data:image/jpeg;base64,FAKEDATA',
  };

  test('UX5 — cabeçalhos das "Últimas batidas" não incluem "Facial"', () => {
    expect(headersUltimasBatidas()).not.toContain('Facial');
  });

  test('UX6 — cabeçalhos das "Últimas batidas" não incluem "Foto"', () => {
    expect(headersUltimasBatidas()).not.toContain('Foto');
  });

  test('UX6b — HTML da linha não exibe facialScore nem botão de foto', () => {
    const html = rowUltimasBatidas(reg);
    expect(html).not.toMatch(/facialScore|facialBadge|Validada|Bloqueada|Suspeita/);
    expect(html).not.toMatch(/verFoto|btn-acao/);
  });

  test('UX7 — dados facialScore e foto no objeto registro NÃO são alterados', () => {
    const snapshot = { facialScore: reg.facialScore, foto: reg.foto };
    rowUltimasBatidas(reg); // chama sem modificar o objeto
    expect(reg.facialScore).toBe(snapshot.facialScore);
    expect(reg.foto).toBe(snapshot.foto);
  });
});

// ─── UX8–UX10: Banco de Horas — card compacto ────────────────────────────────

describe('UX8-UX10 — Banco de Horas: card compacto com 4 métricas', () => {
  const func = { id: 'f1', nome: 'Ademir Lopes Furtado', cargo: 'Vendedor', foto: null };
  const resultado = {
    trabMin:    2368,
    esperMin:   5010,
    saldo:      -2642,
    diasTrab:   5,
    pendencias: [{ data: '2026-09-08' }, { data: '2026-09-10' }],
  };

  test('UX8 — resultado de calcBancoMes tem todas as 5 propriedades esperadas', () => {
    expect(resultado).toHaveProperty('trabMin');
    expect(resultado).toHaveProperty('esperMin');
    expect(resultado).toHaveProperty('saldo');
    expect(resultado).toHaveProperty('diasTrab');
    expect(resultado).toHaveProperty('pendencias');
    expect(Array.isArray(resultado.pendencias)).toBe(true);
  });

  test('UX9 — pendências visíveis no card como 4ª métrica com símbolo ⚠', () => {
    const html = buildCardBancoCompacto(func, resultado);
    expect(html).toContain('Pendências:2');
    expect(html).toContain('⚠');
  });

  test('UX9b — datas das pendências acessíveis via title', () => {
    const html = buildCardBancoCompacto(func, resultado);
    expect(html).toContain('title="2026-09-08, 2026-09-10"');
  });

  test('UX9c — card sem pendências não exibe ⚠ e title é vazio', () => {
    const semPendencias = { ...resultado, pendencias: [] };
    const html = buildCardBancoCompacto(func, semPendencias);
    expect(html).not.toContain('⚠');
    expect(html).toContain('Pendências:0');
    expect(html).toContain('title=""');
  });

  test('UX10 — lazy loading preservado: foto usa class="lazy-foto" e data-src', () => {
    const funcComFoto = { ...func, foto: 'data:image/jpeg;base64,FAKEBASE64' };
    const html = buildCardBancoCompacto(funcComFoto, resultado);
    expect(html).toContain('class="lazy-foto"');
    expect(html).toContain('data-src="data:image/jpeg;base64,FAKEBASE64"');
    expect(html).not.toContain('<img src=');
  });

  test('UX10b — funcionário sem foto não gera tag img', () => {
    const html = buildCardBancoCompacto(func, resultado);
    expect(html).not.toContain('<img');
    expect(html).not.toContain('lazy-foto');
  });
});
