// ponto-regras.js
// Fonte única de verdade para cálculos de jornada e banco de horas.
// Incluído por ponto.html (gestor) e ponto-func.html (funcionário).
// Todas as funções trabalham em MINUTOS INTEIROS — sem floats intermediários.

const JORNADA_SABADO_MIN = 210; // sábado 08:30–12:00 = 3h30

// Motivos que identificam crédito de feriado (usado por getTipoCredito).
const TIPOS_FERIADO = ['Feriado nacional', 'Feriado estadual', 'Feriado municipal'];

// Converte 'HH:MM' ou 'HH:MM:SS' para minutos inteiros. Null se falsy.
function toMin(t) {
  if (!t) return null;
  const [h, m] = t.split(':').map(Number);
  return h * 60 + m;
}

// Formata minutos para '8h30', '-1h15', '0h00', '—'.
function fmtMin(m) {
  if (m === null || m === undefined) return '—';
  const s = m < 0 ? '-' : '';
  const a = Math.abs(Math.round(m));
  return s + Math.floor(a / 60) + 'h' + String(a % 60).padStart(2, '0');
}

// Jornada prevista em minutos para um funcionário numa data específica.
//   Domingo  → 0
//   Sábado   → JORNADA_SABADO_MIN (210)
//   Seg–Sex  → (funcionario.jornada || 8) × 60
function getJornadaPrevista(funcionario, data) {
  const d = new Date(data + 'T12:00:00');
  const diaSemana = d.getDay();
  if (diaSemana === 0) return 0;
  if (diaSemana === 6) return JORNADA_SABADO_MIN;
  return (parseFloat(funcionario.jornada) || 8) * 60;
}

// Alias: recebe jornMin (número) em vez do objeto funcionario.
// Nota: retorna 0 para domingo (diaSemana===0 → não é sábado, retorna jornMin — use
// getJornadaPrevista quando domingo=0 for necessário).
function jornadaParaData(data, jornMin) {
  const d = new Date(data + 'T12:00:00');
  return d.getDay() === 6 ? JORNADA_SABADO_MIN : jornMin;
}

// Classifica um motivo de crédito em tipo usado pelo engine de cálculo.
//   'ferias'    → Férias
//   'feriado'   → Feriado nacional / estadual / municipal
//   'folga_comp'→ Folga compensatória
//   'abono'     → tudo mais (atestado, licença, falta justificada, motivo undefined)
function getTipoCredito(motivo) {
  if (motivo === 'Férias') return 'ferias';
  if (TIPOS_FERIADO.includes(motivo)) return 'feriado';
  if (motivo === 'Folga compensatória') return 'folga_comp';
  return 'abono';
}

// Minutos trabalhados num dia. Retorna null se ponto incompleto ou inválido.
//
// Regras (DEC-12, DEC-11, DEC-1):
//   DEC-12: saída < entrada → null (cruzamento de meia-noite não suportado).
//   DEC-11: quando sa e ra presentes: exige entrada < sa < ra < saída (strict).
//           sa == ra (almoço 0 min) → null.
//   DEC-1:  se (saída − entrada) > 360 e almoço incompleto (só sa, só ra, ou nenhum) → null.
//           Sábado (≤210 min) e jornadas 6h (≤360 min) raramente excedem 360 → isentos naturalmente.
function calcTotal(e, sa, ra, s) {
  if (!e || !s) return null;
  const tE = toMin(e);
  const tS = toMin(s);

  // DEC-12: meia-noite
  if (tS < tE) return null;

  const hasSa = !!sa;
  const hasRa = !!ra;

  // DEC-11: sequência inválida quando ambos sa/ra presentes
  if (hasSa && hasRa) {
    const tSa = toMin(sa);
    const tRa = toMin(ra);
    if (tSa <= tE || tSa >= tRa || tRa >= tS) return null;
  }

  // DEC-1: almoço obrigatório quando intervalo > 6h
  if ((tS - tE) > 360 && !(hasSa && hasRa)) return null;

  let t = tS - tE;
  if (hasSa && hasRa) t -= (toMin(ra) - toMin(sa));
  return t;
}

// Saldo do dia em minutos. Null se ponto incompleto.
function calcSaldoDia(totalMin, jornadaMin) {
  if (totalMin === null || totalMin === undefined) return null;
  return totalMin - jornadaMin;
}

// Constrói objeto dias { 'YYYY-MM-DD': { entrada, saida_almoco, ... } } a partir de registros.
// lancadoPorJustificativa: batida corretiva aprovada pelo gestor sempre prevalece.
function buildDiasFromRegistros(registros) {
  const dias = {};
  registros.forEach(r => {
    if (!dias[r.data]) dias[r.data] = {};
    if (!dias[r.data][r.tipo] || r.lancadoPorJustificativa)
      dias[r.data][r.tipo] = r.hora;
  });
  return dias;
}

// Engine único de cálculo de banco de horas.
//
// Parâmetros:
//   funcionario — objeto com { jornada: '8' | '6' | ... }
//   registros   — array já filtrado por funcId e mês
//   creditos    — array já filtrado por funcId e mês (coleção creditos_jornada)
//   mes         — 'YYYY-MM'
//   hojeStr     — 'YYYY-MM-DD' (dias futuros são ignorados)
//
// Retorna: { trabMin, esperMin, saldo, diasTrab, pendencias }
//   pendencias = [{ data: 'YYYY-MM-DD', tipo: 'PONTO_INCOMPLETO' }]
//
// Regras (DEC-1..DEC-14):
//   FALTA INJUSTIFICADA  = sem registro + sem crédito → esperMin cresce, trabMin não.
//   PONTO INCOMPLETO     = calcTotal=null → NEM esperMin NEM trabMin mudam (PENDENTE).
//   PONTO COMPLETO       = calcTotal > null → trabMin/esperMin crescem; crédito pode ajustar (ver abaixo).
//   CRÉDITO tipo férias  = saldo forçado 0; trabMin = esperMin = jornadaDia (ignora ponto se existir).
//   CRÉDITO tipo feriado = sem ponto: saldo=0; com ponto: saldo = +t (horas extras ganhas).
//   CRÉDITO tipo abono   = sem ponto: cobre jornada; com ponto: abono = max(0, jornada−t).
//   CRÉDITO folga comp   = minutos=0 → débito do banco = −jornadaDia.
//   HOME OFFICE          = não gera crédito; ponto é a fonte de verdade.
//   DOMINGO sem ponto    = ignorado (sem falta, sem crédito).
//   DOMINGO com ponto    = jornadaDia=0; trabalho conta como saldo positivo integral.
//   SÁBADO               = jornadaDia = 210 min.
//   SEQUÊNCIA INVÁLIDA   = calcTotal retorna null → PONTO_INCOMPLETO.
//   MEIA-NOITE           = saída < entrada → calcTotal null → PONTO_INCOMPLETO.
function calcBancoMes(funcionario, registros, creditos, mes, hojeStr) {
  const jornMin = (parseFloat(funcionario.jornada) || 8) * 60;
  const [ano, mesNum] = mes.split('-').map(Number);
  const diasNoMes = new Date(ano, mesNum, 0).getDate();

  const diasMap = buildDiasFromRegistros(registros);
  const creditoMap = {};
  creditos.forEach(c => { creditoMap[c.data] = c; });

  let trabMin = 0, esperMin = 0, diasTrab = 0;
  const pendencias = [];

  for (let d = 1; d <= diasNoMes; d++) {
    const dataStr = `${ano}-${String(mesNum).padStart(2,'0')}-${String(d).padStart(2,'0')}`;
    const diaSemana = new Date(ano, mesNum - 1, d).getDay();
    const diaRegs = diasMap[dataStr];
    const creditoD = creditoMap[dataStr];

    // DEC-7: domingo sem ponto = ignorado (sem falta)
    if (diaSemana === 0 && !diaRegs) continue;
    if (dataStr > hojeStr) continue; // futuro: não conta

    // DEC-7: domingo com ponto tem jornadaDia=0 (todo trabalho = saldo positivo)
    const jornadaDia = diaSemana === 0 ? 0
                     : diaSemana === 6 ? JORNADA_SABADO_MIN
                     : jornMin;

    if (diaRegs) {
      const t = calcTotal(
        diaRegs.entrada?.slice(0, 5),
        diaRegs.saida_almoco?.slice(0, 5),
        diaRegs.retorno_almoco?.slice(0, 5),
        diaRegs.saida?.slice(0, 5)
      );
      if (t !== null && t !== undefined) {
        const tipo = creditoD ? getTipoCredito(creditoD.motivo) : null;
        if (tipo === 'ferias') {
          // DEC-10: férias com ponto → saldo forçado 0
          trabMin += jornadaDia;
          esperMin += jornadaDia;
        } else if (tipo === 'feriado') {
          // DEC-8: feriado trabalhado → jornada abonada + horas reais = saldo positivo
          trabMin += t + (creditoD.minutos || 0);
          esperMin += jornadaDia;
        } else if (tipo === 'abono') {
          // DEC-9: atestado com ponto → abono cobre diferença; saldo nunca inflado
          const abono = Math.max(0, jornadaDia - t);
          trabMin += t + abono;
          esperMin += jornadaDia;
        } else {
          // sem crédito relevante (null, folga_comp): ponto normal
          trabMin += t;
          esperMin += jornadaDia;
        }
        diasTrab++;
      } else {
        // ponto incompleto: nem trabMin nem esperMin mudam → saldo não consolidado
        pendencias.push({ data: dataStr, tipo: 'PONTO_INCOMPLETO' });
      }
    } else if (creditoD) {
      const tipo = getTipoCredito(creditoD.motivo);
      if (tipo === 'ferias') {
        // DEC-10: férias sem ponto → saldo=0
        trabMin += jornadaDia;
        esperMin += jornadaDia;
      } else {
        // feriado, abono, folga_comp: usa creditoD.minutos
        // folga_comp: minutos=0 → débito = −jornadaDia (design intencional DEC-4)
        trabMin += creditoD.minutos || 0;
        esperMin += jornadaDia;
      }
      if ((creditoD.minutos || 0) > 0 || tipo === 'ferias') diasTrab++;
    } else {
      // falta injustificada: esperMin cresce, trabMin não → saldo decresce
      esperMin += jornadaDia;
    }
  }

  const saldo = trabMin - esperMin;
  return { trabMin, esperMin, saldo, diasTrab, pendencias };
}

// Verifica se um espelho pode ser assinado.
//
// Bloqueia se:
//   - Há pendências PONTO_INCOMPLETO no período (calculadas por calcBancoMes).
//   - Há justificativas com status='pendente' no período (mês YYYY-MM).
//
// Permite mesmo com:
//   - Saldo negativo, faltas já resolvidas (aprovadas), férias, atestado,
//     folga compensatória, Home Office com ponto correto.
//
// Parâmetros:
//   pendencias     — array de { data, tipo } retornado por calcBancoMes
//   justificativas — array de justificativas do funcionário (qualquer mês)
//   mes            — 'YYYY-MM' — filtra justificativas pelo período
//
// Retorna: { pode: bool, motivo: string|null }
function podeAssinarEspelho(pendencias, justificativas, mes) {
  if (pendencias.length > 0) {
    return { pode: false, motivo: 'Existem pontos incompletos no período' };
  }
  const justifPendentes = justificativas.filter(
    j => j.data.startsWith(mes) && j.status === 'pendente'
  );
  if (justifPendentes.length > 0) {
    return { pode: false, motivo: 'Existem justificativas pendentes no período' };
  }
  return { pode: true, motivo: null };
}

// ── Snapshot e versionamento de espelho ──────────────────────────────────────

const VERSAO_ENGINE = '3.0.0';

// Constrói snapshot estruturado de um espelho de ponto.
// Usa os mesmos primitivos (calcTotal, getTipoCredito, JORNADA_SABADO_MIN) do
// motor de banco de horas, eliminando implementação paralela de cálculo.
//
// Parâmetros:
//   funcionario    — { id?, nome, cargo, jornada }
//   registros      — array de registros (todos do funcId; filtrado internamente por mes)
//   creditos       — array de créditos_jornada (idem)
//   justificativas — array de justificativas (idem; qualquer status)
//   mes            — 'YYYY-MM'
//   hojeStr        — 'YYYY-MM-DD' (dias futuros não entram no snapshot)
//
// Retorna: objeto snapshot sem 'geradoEm' — o caller define e adiciona antes
// de canonicalizar, pois o timestamp pertence ao momento da persistência.
function buildEspelhoSnapshot(funcionario, registros, creditos, justificativas, mes, hojeStr) {
  const [ano, mesNum] = mes.split('-').map(Number);
  const diasNoMes = new Date(ano, mesNum, 0).getDate();
  const jornMin = (parseFloat(funcionario.jornada) || 8) * 60;
  const TIPOS_SEM_CREDITO = ['Falta injustificada', 'Folga não remunerada', 'Suspensão disciplinar', 'Home Office'];

  const regsDoMes  = (registros      || []).filter(r => r.data && r.data.startsWith(mes));
  const credDoMes  = (creditos        || []).filter(c => c.data && c.data.startsWith(mes));
  const justifDoMes = (justificativas || []).filter(j => j.data && j.data.startsWith(mes) && j.status === 'aprovado');

  const regsPorData = {};
  regsDoMes.forEach(r => { if (!regsPorData[r.data]) regsPorData[r.data] = []; regsPorData[r.data].push(r); });
  const credPorData  = {};
  credDoMes.forEach(c  => { credPorData[c.data]  = c; });
  const justifPorData = {};
  justifDoMes.forEach(j => { justifPorData[j.data] = j; });

  let trabMin = 0, esperMin = 0, diasTrab = 0;
  const dias = [];

  for (let d = 1; d <= diasNoMes; d++) {
    const dataStr  = `${ano}-${String(mesNum).padStart(2, '0')}-${String(d).padStart(2, '0')}`;
    const diaSemana = new Date(ano, mesNum - 1, d).getDay();
    const ehSabado  = diaSemana === 6;
    const ehDomingo = diaSemana === 0;
    const ehFuturo  = dataStr > hojeStr;
    const regsD     = regsPorData[dataStr]  || [];
    const creditoD  = credPorData[dataStr]  || null;
    const justifD   = justifPorData[dataStr] || null;

    // Dias futuros fora do snapshot; domingos sem ponto incluídos só para exibição.
    if (ehFuturo) continue;

    const jornadaDia = ehDomingo ? 0 : ehSabado ? JORNADA_SABADO_MIN : jornMin;

    if (ehDomingo && regsD.length === 0) {
      dias.push({ data: dataStr, diaSemana, entrada: null, saidaAlmoco: null,
                  retornoAlmoco: null, saida: null, totalMin: null, jornadaDia: 0,
                  saldoDia: null, ocorrencia: '', status: 'domingo' });
      continue;
    }

    // Batida: lancadoPorJustificativa prevalece (mesma lógica dos HTMLs).
    const get = tipo => {
      const j = regsD.find(r => r.tipo === tipo && r.lancadoPorJustificativa);
      if (j) return j.hora ? j.hora.slice(0, 5) : null;
      const r = regsD.find(r => r.tipo === tipo);
      return r && r.hora ? r.hora.slice(0, 5) : null;
    };

    const e  = get('entrada');
    const sa = get('saida_almoco');
    const ra = get('retorno_almoco');
    const s  = get('saida');

    let totalMin = calcTotal(e, sa, ra, s);

    const justifCredita = justifD && !TIPOS_SEM_CREDITO.includes(justifD.motivo);
    if (totalMin === null && (creditoD || justifCredita))
      totalMin = (creditoD && creditoD.minutos != null) ? creditoD.minutos : jornadaDia;

    const ehIncompleto      = !ehDomingo && regsD.length > 0 && totalMin === null;
    const saldoDia          = (!ehDomingo && !ehIncompleto && totalMin !== null) ? totalMin - jornadaDia : null;
    const temCreditoSemPonto = !!(creditoD || justifCredita) && totalMin != null && totalMin > 0 && regsD.length === 0;

    let status;
    if      (ehIncompleto)        status = 'incompleto';
    else if (temCreditoSemPonto)  status = 'credito';
    else if (totalMin === null)   status = 'falta';
    else                          status = 'ok';

    const ocorrencia = justifD
      ? (justifD.motivo || '')
      : (creditoD && regsD.length === 0 ? (creditoD.motivo || '') : '');

    if (!ehDomingo && !ehIncompleto) {
      esperMin += jornadaDia;
      if (totalMin !== null) { trabMin += totalMin; diasTrab++; }
    }

    dias.push({ data: dataStr, diaSemana, entrada: e, saidaAlmoco: sa,
                retornoAlmoco: ra, saida: s, totalMin, jornadaDia, saldoDia,
                ocorrencia, status });
  }

  return {
    funcId:      funcionario.id || funcionario.funcId || '',
    funcionario: { nome: funcionario.nome || '', cargo: funcionario.cargo || '', jornada: funcionario.jornada || 8 },
    mes,
    dias,
    totais:      { trabMin, esperMin, saldo: trabMin - esperMin, diasTrab },
    engineVersao: VERSAO_ENGINE,
  };
}

// Representação canônica determinística do snapshot para hashing.
// O campo 'geradoEm' deve ser adicionado ao snapshot pelo caller antes de chamar.
// Campos enumerados explicitamente (nunca dependem de ordem de inserção de objeto).
function canonicalizarSnapshot(snapshot) {
  const diasOrdenados = [...(snapshot.dias || [])].sort((a, b) => a.data < b.data ? -1 : 1);
  return JSON.stringify({
    funcId: snapshot.funcId,
    funcionario: {
      nome:    snapshot.funcionario.nome,
      cargo:   snapshot.funcionario.cargo,
      jornada: snapshot.funcionario.jornada,
    },
    mes: snapshot.mes,
    dias: diasOrdenados.map(d => ({
      data:          d.data,
      diaSemana:     d.diaSemana,
      entrada:       d.entrada,
      saidaAlmoco:   d.saidaAlmoco,
      retornoAlmoco: d.retornoAlmoco,
      saida:         d.saida,
      totalMin:      d.totalMin,
      jornadaDia:    d.jornadaDia,
      saldoDia:      d.saldoDia,
      ocorrencia:    d.ocorrencia,
      status:        d.status,
    })),
    totais: {
      trabMin:  snapshot.totais.trabMin,
      esperMin: snapshot.totais.esperMin,
      saldo:    snapshot.totais.saldo,
      diasTrab: snapshot.totais.diasTrab,
    },
    geradoEm:     snapshot.geradoEm     || '',
    engineVersao: snapshot.engineVersao || '',
  });
}

// Gera as linhas HTML (<tr>) do corpo da tabela de espelho a partir de um snapshot.
// Usada tanto por ponto.html (gestor) quanto por ponto-func.html (funcionário),
// eliminando duplicação da lógica de renderização.
function renderEspelhoRowsHTML(snap) {
  const NOMES_DIA = ['Dom', 'Seg', 'Ter', 'Qua', 'Qui', 'Sex', 'Sáb'];
  return snap.dias.map(d => {
    const ehDomingo   = d.diaSemana === 0;
    const ehFimSemana = d.diaSemana === 0 || d.diaSemana === 6;
    const diaN        = parseInt(d.data.split('-')[2], 10);
    const diaSem      = NOMES_DIA[d.diaSemana];

    let totalLabel = '—';
    if (!ehDomingo) {
      if (d.totalMin !== null && d.totalMin !== undefined) totalLabel = fmtMin(d.totalMin);
      else if (d.status === 'incompleto')                  totalLabel = 'Incompleto';
      else                                                 totalLabel = 'Falta';
    }

    const bgColor       = ehFimSemana                          ? 'background:#eeeeee;'
                        : d.status === 'credito' && !d.entrada ? 'background:#f0fff4;'
                        : d.ocorrencia                         ? 'background:#fff8e1;'
                        : '';
    const totalColor    = totalLabel === 'Falta'      ? 'color:#c0392b;font-weight:600;'
                        : totalLabel === 'Incompleto' ? 'color:#e67e22;font-weight:600;'
                        : 'color:#111;';
    const saldoColor    = d.saldoDia > 0 ? 'color:#1a7a3a;font-weight:600;'
                        : d.saldoDia < 0 ? 'color:#c0392b;font-weight:600;'
                        : 'color:#111;';
    const ocorrColor    = d.status === 'credito' && !d.entrada ? 'color:#1a7a3a;' : 'color:#c0392b;';
    const saldoStr      = d.saldoDia !== null ? (d.saldoDia >= 0 ? '+' : '') + fmtMin(d.saldoDia) : '—';

    return `<tr style="${bgColor}">` +
      `<td style="color:#111;font-weight:600;"><strong>${diaN}</strong> ${diaSem}</td>` +
      `<td style="color:#111;">${d.entrada      || '—'}</td>` +
      `<td style="color:#111;">${d.saidaAlmoco  || '—'}</td>` +
      `<td style="color:#111;">${d.retornoAlmoco|| '—'}</td>` +
      `<td style="color:#111;">${d.saida        || '—'}</td>` +
      `<td style="${totalColor}">${totalLabel}</td>` +
      `<td style="${saldoColor}">${saldoStr}</td>` +
      `<td style="${ocorrColor}font-size:10px;">${d.ocorrencia || ''}</td>` +
      `</tr>`;
  }).join('');
}

// ── calcRevisaoPeriodo ────────────────────────────────────────────────────────
// Função pura: monta os documentos para iniciar uma revisão de período.
// Retorna { v2Doc, v1Update } ou null em caso de validação inválida.
//
// Semântica:
//   - v1 permanece como última versão assinada válida enquanto v2 não for assinada.
//   - v1 recebe revisaoEmAndamento:true (NÃO invalidado) para sinalizar revisão aberta.
//   - v2 nasce com status:'aguardando_assinatura' e assinado:false.
//   - v1.invalidado só muda via calcConcluirRevisao, após assinatura da v2.
//
// novoId deve ser gerado pelo chamador (uid()), mantendo a função testável.
function calcRevisaoPeriodo(espExist, novoId, novoSnap, novoHash, motivo, agora) {
  if (!espExist || !espExist.assinado) return null;
  if (!motivo || !motivo.trim()) return null;

  var novaVersao = (espExist.versao || 1) + 1;

  var v2Doc = {
    id: novoId,
    funcId: espExist.funcId,
    mes: espExist.mes,
    mesLabel: espExist.mesLabel || '',
    versao: novaVersao,
    versaoAnteriorId: espExist.id,
    versaoSucessoraId: null,
    invalidado: false,
    invalidadoEm: null,
    motivoInvalidacao: null,
    status: 'aguardando_assinatura',
    motivoRevisao: motivo.trim(),
    geradoEm: novoSnap.geradoEm || agora,
    geradoPor: 'Gestor',
    snapshot: novoSnap,
    hashSnapshot: novoHash,
    assinado: false,
    assinadoEm: null,
    assinadoPor: null,
    assinaturaImg: null,
    criadoEm: agora,
  };

  // v1 não é invalidada agora — continua sendo a última versão assinada válida.
  // Apenas registra que há uma revisão em andamento e aponta para v2.
  var v1Update = {
    versaoSucessoraId: novoId,
    revisaoEmAndamento: true,
    revisaoAbertaEm: agora,
    motivoRevisao: motivo.trim(),
  };

  return { v2Doc: v2Doc, v1Update: v1Update };
}

// ── calcConcluirRevisao ───────────────────────────────────────────────────────
// Função pura: monta as atualizações para concluir uma revisão após o funcionário
// assinar a v2. Retorna { v2Update, v1Update }.
//
// ATENÇÃO — LIMITAÇÃO DE RULES:
//   - v2Update: pode ser aplicado pelo funcionário (campos de assinatura).
//   - v1Update: requer gestor ou Cloud Function.
//     As futuras Rules restringirão o funcionário a
//     hasOnly(['assinado','assinaturaImg','assinadoEm','assinadoPor','status']).
//     O funcionário não poderá atualizar v1 diretamente.
//     A finalização de v1 deverá ocorrer por ação explícita do gestor ou
//     por Cloud Function (onUpdate trigger em espelhos/{id}).
function calcConcluirRevisao(v1Id, v2Id, assinadoPor, assinaturaImg, agora) {
  var v2Update = {
    assinado: true,
    status: 'assinado',
    assinadoPor: assinadoPor,
    assinadoEm: agora,
    assinaturaImg: assinaturaImg,
  };

  // v1Update só pode ser aplicado com permissões de gestor (ver limitação acima).
  var v1Update = {
    revisaoEmAndamento: false,
    substituido: true,
    substituidoEm: agora,
  };

  return { v2Update: v2Update, v1Update: v1Update, v1Id: v1Id, v2Id: v2Id };
}
