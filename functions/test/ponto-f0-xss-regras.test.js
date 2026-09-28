'use strict';
// PONTO MR4 2.0 — Fase 0 · P1-04 XSS (escape de texto de usuário) + motor: registrosEfetivos (P0-02) e dataIsoDe (assinatura do espelho).
const fs = require('fs'), path = require('path'), vm = require('vm');
const MOD = f => path.resolve(__dirname, '../../modulos', f);
const HTML = { gestor: fs.readFileSync(MOD('ponto.html'), 'utf8'), func: fs.readFileSync(MOD('ponto-func.html'), 'utf8') };
const regras = {}; vm.createContext(regras); vm.runInContext(fs.readFileSync(MOD('ponto-regras.js'), 'utf8'), regras);

/** Carrega esc/sid/sjs exatamente como estão no HTML (sem cópia manual). */
function helpers(src) {
  const linhas = src.split('\n').filter(l => /^function (esc|sid|sjs)\(/.test(l));
  expect(linhas).toHaveLength(3);
  const c = {}; vm.createContext(c); vm.runInContext(linhas.join('\n'), c); return c;
}
const PAYLOADS = {
  script: '<script>alert(1)</script>',
  imgOnerror: '<img src=x onerror="alert(1)">',
  atributo: '" onmouseover="alert(1)" x="',
  atributoAspasSimples: "' onfocus='alert(1)' autofocus='",
  aninhado: '<div><a href="javascript:alert(1)"><svg onload=alert(1)><b>x</b></svg></a></div>',
  template: '`${alert(1)}`',
};
const semTagViva = s => !/<[a-z!/]/i.test(s) && !/["'`]/.test(s);

describe('P1-04 — escape (esc/sid/sjs dos dois HTMLs + escHtml do motor)', () => {
  for (const [tela, src] of Object.entries(HTML)) {
    const { esc, sid, sjs } = helpers(src);
    test(`${tela}: esc neutraliza <script>, <img onerror>, atributos de evento e HTML aninhado`, () => {
      for (const p of Object.values(PAYLOADS)) {
        const out = esc(p);
        expect(semTagViva(out)).toBe(true);
        expect(out.replace(/&(amp|lt|gt|quot|#39|#96);/g, m => ({ '&amp;': '&', '&lt;': '<', '&gt;': '>', '&quot;': '"', '&#39;': "'", '&#96;': '`' }[m]))).toBe(p);   // reversível: nada perdido
      }
      expect(esc(null)).toBe(''); expect(esc(undefined)).toBe(''); expect(esc(0)).toBe('0');
    });
    test(`${tela}: sid só aceita id seguro (ids do Firestore passam; payloads viram vazio)`, () => {
      expect(sid('func-001_2026-09-28_entrada')).toBe('func-001_2026-09-28_entrada');
      expect(sid('Ab9xYz12QwErTy34')).toBe('Ab9xYz12QwErTy34');
      for (const p of Object.values(PAYLOADS)) expect(sid(p)).toBe('');
      expect(sid("x');alert(1);//")).toBe('');
    });
    test(`${tela}: sjs impede fuga de string JS em onclick`, () => {
      for (const p of Object.values(PAYLOADS)) expect(/['"\\<>`]/.test(sjs(p))).toBe(false);
    });
  }
  test('motor: escHtml ≡ esc e renderEspelhoRowsHTML escapa a ocorrência (texto do funcionário)', () => {
    const { esc } = helpers(HTML.func);
    for (const p of Object.values(PAYLOADS)) expect(regras.escHtml(p)).toBe(esc(p));
    const snap = { dias: Object.values(PAYLOADS).map((p, i) => ({ data: `2026-09-${String(i + 1).padStart(2, '0')}`, diaSemana: 2, entrada: '08:00', saidaAlmoco: '12:00',
      retornoAlmoco: '13:00', saida: '17:00', totalMin: 480, jornadaDia: 480, saldoDia: 0, ocorrencia: p, status: 'ok' })) };
    const html = regras.renderEspelhoRowsHTML(snap);
    expect(html.replace(/<\/?(tr|td|strong)\b[^>]*>/g, '')).not.toMatch(/[<>]/);   // só as tags da própria tabela
    expect(html).toContain('&lt;script&gt;alert(1)&lt;/script&gt;');
  });
});

describe('P1-04 — varredura estática: texto livre nunca vai cru para innerHTML', () => {
  // Campos digitados por funcionário/gestor. Qualquer ${...campo...} precisa passar por esc/escHtml/sid/sjs.
  const CAMPOS = /\$\{[^}]*\b(motivo|descricao|obsGestor|funcNome|nome|cargo|cpf|telefone|endereco|mesLabel|ocorrencia|foto)\b[^}]*\}/g;
  // Exceções verificadas uma a uma (não são innerHTML): textContent / prompt / notif(textContent) / constante FERIADOS_2026 / preview local de arquivo / mesLabel calculado.
  const PERMITIDO = [/info\.textContent=/, /prompt\(/, /notif\(/, /FERIADOS_2026\.map/, /\$\{fotoNova\}/, /\$\{mesLabel\}/ /* ponto-func: `${nomes[mesNum-1]}/${ano}` (constante) */];
  for (const [tela, src] of Object.entries(HTML)) {
    test(`${tela}: sem interpolação crua de campo de usuário`, () => {
      const cruas = [];
      src.split('\n').forEach((l, i) => {
        for (const m of l.match(CAMPOS) || []) {
          if (/\b(esc|escHtml|sid|sjs|iniciais)\(|\.length|\?'|\?`<img data-src="\$\{esc/.test(m)) continue;
          if (PERMITIDO.some(re => re.test(l))) continue;
          cruas.push(`${i + 1}: ${m}`);
        }
      });
      expect(cruas).toEqual([]);
    });
  }
});

describe('Motor — correções aditivas (registrosEfetivos) e assinatura do espelho (dataIsoDe)', () => {
  const F = { id: 'fx', nome: 'Fx', jornada: 8 };
  const r = (tipo, hora, x = {}) => ({ funcId: 'fx', data: '2026-09-15', tipo, hora: hora + ':00', ...x });
  const diaCompleto = [r('entrada', '08:00'), r('saida_almoco', '12:00'), r('retorno_almoco', '13:00'), r('saida', '17:00')];
  test('registrosEfetivos: remove só os substituídos; histórico sem o campo fica idêntico', () => {
    expect(regras.registrosEfetivos(diaCompleto)).toHaveLength(4);
    expect(regras.registrosEfetivos([...diaCompleto, r('entrada', '08:30', { substituidoPor: 'corr_1' })])).toHaveLength(4);
    expect(regras.registrosEfetivos(null)).toEqual([]);
  });
  test('banco e espelho ignoram o original substituído (original continua existindo na lista)', () => {
    const regs = [r('entrada', '09:00', { substituidoPor: 'corr_j' }), r('entrada', '08:00', { lancadoPorJustificativa: true, id: 'corr_j' }), ...diaCompleto.slice(1)];
    const b = regras.calcBancoMes(F, regs, [], '2026-09', '2026-09-15');
    const e = regras.buildEspelhoSnapshot(F, regs, [], [], '2026-09', '2026-09-15');
    expect(e.dias.find(d => d.data === '2026-09-15')).toMatchObject({ entrada: '08:00', totalMin: 480, saldoDia: 0 });
    // mesmos totais que um dia sem correção nenhuma
    const b0 = regras.calcBancoMes(F, diaCompleto, [], '2026-09', '2026-09-15');
    expect([b.trabMin, b.esperMin]).toEqual([b0.trabMin, b0.esperMin]);
    expect(regs).toHaveLength(5);
  });
  test('segunda correção: só a última vigente conta (1ª correção substituída)', () => {
    const regs = [r('entrada', '09:00', { substituidoPor: 'c1' }), r('entrada', '08:10', { lancadoPorJustificativa: true, substituidoPor: 'c2' }),
      r('entrada', '07:58', { lancadoPorJustificativa: true }), ...diaCompleto.slice(1)];
    expect(regras.buildDiasFromRegistros(regs)['2026-09-15'].entrada).toBe('07:58:00');
    expect(regras.buildEspelhoSnapshot(F, regs, [], [], '2026-09', '2026-09-15').dias.find(d => d.data === '2026-09-15').entrada).toBe('07:58');
  });
  test('MIRROR_SIGNATURE: dataIsoDe aceita string legada, Timestamp (toDate / {seconds}) e Date — nunca lança', () => {
    expect(regras.dataIsoDe('2026-09-10T14:22:00.000Z')).toBe('2026-09-10');
    const ts = { seconds: Date.UTC(2026, 8, 28, 2, 30) / 1000, nanoseconds: 0 };            // 28/09 02:30Z = 27/09 23:30 em Fortaleza
    expect(regras.dataIsoDe(ts)).toBe('2026-09-27');
    expect(regras.dataIsoDe({ toDate: () => new Date(Date.UTC(2026, 8, 28, 15)) })).toBe('2026-09-28');
    expect(regras.dataIsoDe(new Date(Date.UTC(2026, 8, 28, 15)))).toBe('2026-09-28');
    for (const v of [null, undefined, '', {}, 42, { seconds: NaN }]) expect(() => regras.dataIsoDe(v)).not.toThrow();
    expect(regras.dataIsoDe({})).toBe('');
  });
  test('MIRROR_SIGNATURE: nenhuma tela usa mais assinadoEm?.slice (quebrava com Timestamp)', () => {
    for (const src of Object.values(HTML)) {
      expect(src).not.toMatch(/assinadoEm\??\.slice/);
      expect(src).toMatch(/dataIsoDe\([^)]*assinadoEm\)/);
    }
  });
});

describe('P0-01 — tela do funcionário: feedback e intenção (inspeção estática)', () => {
  const src = HTML.func;
  test('estados REGISTRANDO / PONTO REGISTRADO / incerteza existem', () => {
    expect(src).toMatch(/Registrando…/);
    expect(src).toMatch(/Ponto registrado/);
    expect(src).toMatch(/Não foi possível confirmar\. Verificando o estado…/);
    expect(src).toMatch(/id="est-incerto"/);
  });
  test('toda batida envia requestId + tipoEsperado; a intenção é guardada antes do envio e só limpa após confirmação', () => {
    expect(src).toMatch(/requestId:\s*intencao\.requestId/);
    expect(src).toMatch(/tipoEsperado:\s*intencao\.tipoEsperado/);
    const ini = src.slice(src.indexOf('async function iniciarBatida'), src.indexOf('async function finalizarBatida'));
    expect(ini.indexOf('salvarIntencao(')).toBeGreaterThan(-1);
    expect(ini.indexOf('salvarIntencao(')).toBeLessThan(ini.indexOf('finalizarBatida('));
  });
  test('erro incerto → reconcilia pela MESMA intenção antes de permitir nova (inclui deadline-exceeded de 20 s)', () => {
    expect(src).toMatch(/httpsCallable\(functions, 'registrarPonto', \{ timeout: 20000 \}\)/);
    expect(src).toMatch(/ERROS_INCERTOS=\[[^\]]*'functions\/deadline-exceeded'/);
    expect(src).toMatch(/async function reconciliarIntencao/);
    expect(src).toMatch(/function retentarIntencao/);
    // pendência na abertura do app ou num novo toque → reconcilia primeiro
    const ini = src.slice(src.indexOf('async function iniciarBatida'), src.indexOf('async function finalizarBatida'));
    expect(ini).toMatch(/lerIntencaoPendente\(\)/);
    expect(ini).toMatch(/reconciliarIntencao\(/);
  });
});
