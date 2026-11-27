'use strict';
// PONTO — P1/P5/P6: fiação das páginas (ponto-func.html, ponto.html) e lógica de tela extraída do próprio HTML. Sem rede, sem emulador.
const fs = require('fs'), path = require('path'), vm = require('vm');
const root = path.resolve(__dirname, '../..');
const FUNC = fs.readFileSync(path.join(root, 'modulos/ponto-func.html'), 'utf8');
const ADM = fs.readFileSync(path.join(root, 'modulos/ponto.html'), 'utf8');
const REGRAS = fs.readFileSync(path.join(root, 'modulos/ponto-regras.js'), 'utf8');
const fn = (src, nome) => { const i = src.indexOf('function ' + nome); expect(i).toBeGreaterThan(-1); let d = 0, j = src.indexOf('{', i); const ini = i; for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; else if (src[k] === '}') { d--; if (!d) return src.slice(ini, k + 1); } } throw new Error('sem fim ' + nome); };

describe('P1 · botão "Encerrar expediente" (tela do funcionário)', () => {
  const montar = (data, hora) => {
    const els = { 'btn-encerrar': { style: { display: 'none' } } };
    const c = { hoje: () => data, hojeHora: () => hora, document: { getElementById: id => els[id] || null }, console };
    vm.createContext(c);
    vm.runInContext('const MAX_MIN_SEM_ALMOCO_UI=360;' + fn(FUNC, 'podeEncerrarDireto') + fn(FUNC, 'atualizarBotaoEncerrar') + ';this.p=podeEncerrarDireto;this.a=atualizarBotaoEncerrar;', c);
    return { c, els };
  };
  const ENT = { tipo: 'entrada', hora: '08:40:15' };
  test('sábado + entrada + ≤ 6h ⇒ pode; limite exato de 6h ok; 1 min acima não', () => {
    expect(montar('2026-10-24', '12:30:00').c.p(ENT)).toBe(true);
    expect(montar('2026-10-24', '14:40:00').c.p(ENT)).toBe(true);     // 08:40 → 14:40 = 360 min
    expect(montar('2026-10-24', '14:41:00').c.p(ENT)).toBe(false);
  });
  test('dia útil, domingo, sem entrada, ou após a saída de almoço ⇒ não', () => {
    expect(montar('2026-10-23', '12:30:00').c.p(ENT)).toBe(false);
    expect(montar('2026-10-25', '12:30:00').c.p(ENT)).toBe(false);
    expect(montar('2026-10-24', '12:30:00').c.p(null)).toBe(false);
    expect(montar('2026-10-24', '12:30:00').c.p({ tipo: 'saida_almoco', hora: '11:00:00' })).toBe(false);
    expect(montar('2026-10-24', 'lixo').c.p(ENT)).toBe(false);
  });
  test('atualizarBotaoEncerrar mostra/oculta conforme a dica do próximo ponto', () => {
    const { c, els } = montar('2026-10-24', '12:30:00');
    c.a({ podeEncerrarDireto: true }); expect(els['btn-encerrar'].style.display).toBe('block');
    c.a({ podeEncerrarDireto: false }); expect(els['btn-encerrar'].style.display).toBe('none');
    c.a(null); expect(els['btn-encerrar'].style.display).toBe('none');
  });
  test('HTML: botão oculto por padrão, com ação própria; confirmação explícita; só ele passa encerramentoDireto; payload só envia a flag quando true', () => {
    expect(FUNC).toMatch(/id="btn-encerrar" style="display:none;" onclick="encerrarExpediente\(\)"/);
    const enc = fn(FUNC, 'encerrarExpediente');
    expect(enc).toMatch(/window\.confirm\(/); expect(enc).toMatch(/iniciarBatida\(\{encerramentoDireto:true\}\)/);
    expect(FUNC).toMatch(/onclick="iniciarBatida\(\)"/);                                               // o botão normal NÃO manda a flag
    expect(FUNC).toMatch(/\.\.\.\(intencao\.encerramentoDireto===true\?\{encerramentoDireto:true\}:\{\}\)/);
    expect(FUNC).toMatch(/tipoEsperado:direto\?'saida':prox\.tipo/);
    expect(FUNC).toMatch(/if\(direto&&!prox\.podeEncerrarDireto\)/);
    expect(FUNC).toMatch(/ENCERRAMENTO_DIRETO_EXIGE_ALMOCO/);
  });
  test('o botão some quando o ponto fecha (Concluído) e é reavaliado em voltarPonto e renderHistDia', () => {
    expect((FUNC.match(/atualizarBotaoEncerrar\(/g) || []).length).toBeGreaterThanOrEqual(4);
    expect(fn(FUNC, 'proxPonto').length).toBeGreaterThan(0);
  });
});

describe('P5 · espelho usa a origem das batidas (gestor e funcionário)', () => {
  test('admin e funcionário constroem a origem e passam ao renderizador + legenda; snapshot assinado não é alterado', () => {
    expect(ADM).toMatch(/const origem=buildOrigemBatidas\(regsDoMes,mes\)/); expect(ADM).toMatch(/renderEspelhoRowsHTML\((anotarFolgasExibicao\(snapExib,[^;]*?\)|snapExib),origem\)/); expect(ADM).toMatch(/renderLegendaOrigemHTML\(origem\)/);
    expect(FUNC).toMatch(/buildOrigemBatidas\(regsOrigem/); expect(FUNC).toMatch(/renderEspelhoRowsHTML\(anotarFolgasExibicao\(snap,[^;]*?\),origem\)/); expect(FUNC).toMatch(/renderLegendaOrigemHTML\(origem\)/);
    expect(ADM).toMatch(/const snap=buildEspelhoSnapshot\(func,regsDoMes,creditosFuncMes,justifDoMes,mes,hojeStr\)/);   // cálculo do snapshot inalterado
    expect(ADM).toMatch(/canonicalizarSnapshot\(snap\)/);
  });
  test('espelho assinado (funcionário): a origem vem de UMA consulta do mês do próprio funcionário e falha sem quebrar', () => {
    expect(FUNC).toMatch(/try\{regsOrigem=await window\._fbRegistrosDias\(funcId,diasDoMes\(mes\)\);\}catch\(e\)\{regsOrigem=null;\}/);
  });
  test('o motor continua sem referências de DOM e o exemplo de saída compatível (sem origem) está coberto em ponto-p5', () => {
    expect(REGRAS).not.toMatch(/document\.|window\./);
  });
});

describe('P6 · gestor vê originais e alertas; evidência obrigatória', () => {
  const ctx = fn(ADM, 'anexarContextoJustificativa') || '';
  test('contexto de decisão lista os registros ORIGINAIS (incl. substituídos) e os alertas de controle', () => {
    expect(ADM).toMatch(/Registros originais do dia \(como batidos\)/);
    expect(ADM).toMatch(/substituída/); expect(ADM).toMatch(/lançada por justificativa/);
    expect(ADM).toMatch(/avaliarAlertasJustificativa\(j,\{justificativas:/); expect(ADM).toMatch(/Alertas de controle/);
    expect(ADM).toMatch(/timeZone:'America\/Fortaleza'/);
  });
  test('aprovar sem evidência (antiga): bloqueio na tela exige observação ≥ mínimo; o par também; erro do servidor traduzido', () => {
    expect(ADM).toMatch(/ctxJ\.exigeObsEvidencia&&obs0\.length<MIN_DESCRICAO_EVIDENCIA/);
    expect(ADM).toMatch(/window\._ctxJustif\.exigeObsEvidencia=precisaObs/);
    expect(ADM).toMatch(/\[j,\.\.\.parPend\]\.some\(x=>exigeEvidenciaJustificativa\(x,hoje\(\)\)&&!temEvidenciaJustificativa\(x\)\)/);
    expect(ADM).toMatch(/EVIDENCIA_OBRIGATORIA_JUSTIFICATIVA_ANTIGA:'/);
    expect(ADM).toMatch(/rejeitado'&&obs0\.length<5/);          // rejeitar segue como antes (sem exigir evidência)
  });
  test('a decisão continua SEMPRE no servidor (sem escrita direta de aprovação na tela)', () => {
    const resp = ADM.slice(ADM.indexOf('async function _decidirJustif'), ADM.indexOf('window.responderJustificativa=responderJustificativa;'));
    expect(resp).toMatch(/window\._justDecidir/); expect(resp).not.toMatch(/_writeBatch|batch\.|fbSet\(|\.commit\(/);
  });
  test('funcionário: justificativa de batida antiga exige descrição (≥ mínimo) ou anexo antes de enviar; aviso no formulário', () => {
    expect(FUNC).toMatch(/exigeEvidenciaJustificativa\(\{tipoPonto:batida,horarioPonto:horarioBatida,data\},hoje\(\)\)&&!temEvidenciaJustificativa\(\{descricao:desc,anexo:anexoFile\?'x':null\}\)/);
    expect(FUNC).toMatch(/mais de 3 dias atrás exigem descrição/);
    const form = fn(FUNC, 'enviarJustificativa'); expect(form.indexOf('exigeEvidenciaJustificativa')).toBeGreaterThan(form.indexOf("const anexoFile"));
  });
  test('motor copiado idêntico ao do navegador (backend usa a mesma regra)', () => {
    expect(fs.readFileSync(path.join(root, 'functions/lib/ponto-regras.copy.js'), 'utf8')).toBe(REGRAS);
    expect(fs.readFileSync(path.join(root, 'functions/lib/pontoJustificativa.js'), 'utf8')).toMatch(/EVIDENCIA_OBRIGATORIA_JUSTIFICATIVA_ANTIGA/);
  });
});

describe('P6 (correção) · aviso "Evidência obrigatória" só com ação de aprovação pendente', () => {
  const R = {}; vm.createContext(R); vm.runInContext(REGRAS, R);
  const H = vm.createContext({});
  vm.runInContext(fn(ADM, 'acaoDeAprovacaoPendente') + fn(ADM, 'textoAlertaControle') + ';this.a=acaoDeAprovacaoPendente;this.t=textoAlertaControle;', H);
  const base = { id: 'j', funcId: 'F1', data: '2026-10-21', motivo: 'Ponto não batido — Saída almoço', tipoPonto: 'saida_almoco', horarioPonto: '13:39', criadoEm: '2026-11-11T12:26:00Z' };
  const precisa = (j, proprio = false, assinado = false, futura = false) => {
    const decidida = !!(j.status && j.status !== 'pendente');
    const acao = H.a(j, proprio, decidida, assinado, futura);
    return acao && R.exigeEvidenciaJustificativa(j, '2026-11-16') && !R.temEvidenciaJustificativa(j);
  };
  test('PENDENTE antiga sem evidência ⇒ aviso/bloqueio presentes; com descrição ⇒ ausentes', () => {
    expect(precisa({ ...base, status: 'pendente' })).toBe(true);
    expect(precisa({ ...base, status: 'pendente', descricao: 'Saí para almoçar às 13:39 com o gerente' })).toBe(false);
  });
  test('APROVADA e REJEITADA (já decididas) ⇒ SEM aviso, mesmo antigas e sem evidência', () => {
    expect(precisa({ ...base, status: 'aprovado' })).toBe(false);
    expect(precisa({ ...base, status: 'rejeitado' })).toBe(false);
  });
  test('pendente porém sem ação possível (ponto próprio, mês assinado, data futura) ⇒ sem aviso de evidência', () => {
    expect(precisa({ ...base, status: 'pendente' }, true)).toBe(false);
    expect(precisa({ ...base, status: 'pendente' }, false, true)).toBe(false);
    expect(precisa({ ...base, status: 'pendente' }, false, false, true)).toBe(false);
  });
  test('texto do alerta: com ação pendente mantém a instrução; decidida mostra só o fato (sem "para aprovar…")', () => {
    const a = R.avaliarAlertasJustificativa({ ...base, status: 'aprovado' }, { justificativas: [], registros: [], hojeStr: '2026-11-16' }).alertas[0];
    expect(a.msg).toMatch(/para aprovar, registre na observação/);
    expect(H.t(a.msg, true)).toBe(a.msg);
    expect(H.t(a.msg, false)).toBe('Justificativa lançada 26 dias depois do dia e SEM descrição suficiente, anexo ou evidência.');
    expect(H.t('Horário repetido: sem instrução', false)).toBe('Horário repetido: sem instrução');
  });
  test('HTML: o aviso depende de acaoPend; histórico, observações, registros originais e alertas seguem SEMPRE renderizados', () => {
    expect(ADM).toMatch(/const precisaObs=acaoPend&&\[j,\.\.\.parPend\]/);
    expect(ADM).toMatch(/const acaoPend=acaoDeAprovacaoPendente\(j,proprio,decidida,assinado,futura\)/);
    expect(ADM).toMatch(/esc\(textoAlertaControle\(a\.msg,acaoPend\)\)/);
    expect(ADM).toMatch(/\$\{blocoOrig\}/); expect(ADM).toMatch(/\$\{hist\.length\?/); expect(ADM).toMatch(/\$\{alertas6\?/);
    expect(ADM).toMatch(/\$\{precisaObs\?'<div[^']*Evidência obrigatória/);
  });
  test('regras de aprovação, motor e servidor INALTERADOS (esta correção é só de tela)', () => {
    const rodado = fs.readFileSync(path.join(root, 'functions/lib/ponto-regras.copy.js'), 'utf8');
    expect(rodado).toBe(REGRAS);
    expect(ADM).toMatch(/ctxJ\.exigeObsEvidencia&&obs0\.length<MIN_DESCRICAO_EVIDENCIA/);        // bloqueio ao clicar continua dependendo do mesmo flag
  });
});
