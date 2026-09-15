'use strict';

/**
 * PFUX1–PFUX24 — Redesign interface do funcionário (ponto-func.html)
 *
 * Verificações puramente estruturais: leitura do HTML como string + regex/includes.
 * Sem DOM, sem Firebase, sem emulador.
 *
 * Categorias:
 *   PFUX1-6   — IDs obrigatórios preservados
 *   PFUX7-10  — Tema MR4 (Inter, #1a73e8, fundo claro)
 *   PFUX11-13 — GPS pill: 4 estados presentes no CSS/HTML
 *   PFUX14-15 — Botão CTA: retangular (não circular)
 *   PFUX16-17 — Bottom navigation: 4 abas
 *   PFUX18-20 — Header: avatar, nome, cargo, botão Sair
 *   PFUX21-22 — Sem reconhecimento facial / sem jsPDF
 *   PFUX23    — _funcCache e _FUNC_CACHE_TTL preservados
 *   PFUX24    — batidaEmProgresso guard preservado
 */

const fs   = require('fs');
const path = require('path');

const HTML_PATH = path.resolve(
  __dirname,
  '../../modulos/ponto-func.html'
);

let html;
beforeAll(() => {
  html = fs.readFileSync(HTML_PATH, 'utf8');
});

// ─── Helpers ────────────────────────────────────────────────────────────────
const hasId    = id  => html.includes(`id="${id}"`);
const hasCls   = cls => html.includes(`.${cls}`) || html.includes(`class="${cls}"`);
const hasText  = txt => html.includes(txt);
const hasFn    = fn  => html.includes(`function ${fn}`) || html.includes(`${fn}=`) || html.includes(`window.${fn}`);

// ─── PFUX1-2: IDs de relógio, próxima batida, botão ─────────────────────────
describe('PFUX1-2 — IDs relógio e batida preservados', () => {

  test('PFUX1 — func-hora, func-data-str, btn-bater, lbl-prox presentes', () => {
    expect(hasId('func-hora')).toBe(true);
    expect(hasId('func-data-str')).toBe(true);
    expect(hasId('btn-bater')).toBe(true);
    expect(hasId('lbl-prox')).toBe(true);
  });

  test('PFUX2 — estados est-aguardando, est-gps-bloqueado, est-proc, est-comp presentes', () => {
    expect(hasId('est-aguardando')).toBe(true);
    expect(hasId('est-gps-bloqueado')).toBe(true);
    expect(hasId('est-proc')).toBe(true);
    expect(hasId('est-comp')).toBe(true);
  });
});

// ─── PFUX3-4: IDs de histórico, banco, justificativas, espelho ───────────────
describe('PFUX3-4 — IDs histórico e abas preservados', () => {

  test('PFUX3 — hist-dia, mes-banco, banco-func presentes', () => {
    expect(hasId('hist-dia')).toBe(true);
    expect(hasId('mes-banco')).toBe(true);
    expect(hasId('banco-func')).toBe(true);
  });

  test('PFUX4 — IDs do formulário de justificativa preservados', () => {
    expect(hasId('justif-data')).toBe(true);
    expect(hasId('justif-tipo-ocorr')).toBe(true);
    expect(hasId('justif-batida')).toBe(true);
    expect(hasId('justif-horario')).toBe(true);
    expect(hasId('justif-desc')).toBe(true);
    expect(hasId('justif-anexo')).toBe(true);
    expect(hasId('campos-ponto-nao-batido')).toBe(true);
    expect(hasId('lista-justif-func')).toBe(true);
  });
});

// ─── PFUX5-6: IDs do espelho e modal de assinatura ───────────────────────────
describe('PFUX5-6 — IDs espelho e assinatura preservados', () => {

  test('PFUX5 — mes-espelho-func, minha-folha-container, espelhos-func-lista presentes', () => {
    expect(hasId('mes-espelho-func')).toBe(true);
    expect(hasId('minha-folha-container')).toBe(true);
    expect(hasId('espelhos-func-lista')).toBe(true);
  });

  test('PFUX6 — modal-assinar, assinar-info, espelho-para-assinar, canvas-assinatura presentes', () => {
    expect(hasId('modal-assinar')).toBe(true);
    expect(hasId('assinar-info')).toBe(true);
    expect(hasId('espelho-para-assinar')).toBe(true);
    expect(hasId('canvas-assinatura')).toBe(true);
  });
});

// ─── PFUX7-8: Tema MR4 — Inter e primary #1a73e8 ─────────────────────────────
describe('PFUX7-8 — Tema MR4: fonte Inter e azul #1a73e8', () => {

  test('PFUX7 — Google Fonts Inter carregado via link', () => {
    expect(html).toMatch(/fonts\.googleapis\.com.*Inter/);
  });

  test('PFUX8 — cor primária #1a73e8 presente como token CSS', () => {
    expect(html).toContain('--primary:#1a73e8');
    // não deve usar o azul do tema antigo (laranja #FF6B1A)
    expect(html).not.toContain('#FF6B1A');
    expect(html).not.toContain('#ff6b1a');
  });
});

// ─── PFUX9-10: Fundo claro, sem tema escuro como padrão ─────────────────────
describe('PFUX9-10 — Fundo claro (tema claro como padrão)', () => {

  test('PFUX9 — variável --bg presente e não é preta (#0A0A0A)', () => {
    expect(html).toContain('--bg:');
    expect(html).not.toContain('--bg:#0A0A0A');
    expect(html).not.toContain('--bg:#0a0a0a');
    // Deve ser um tom claro
    expect(html).toContain('--bg:#f1f5f9');
  });

  test('PFUX10 — fonte Barlow (tema antigo) não referenciada', () => {
    expect(html).not.toMatch(/Barlow/i);
  });
});

// ─── PFUX11-12: GPS pill com 4 estados ───────────────────────────────────────
describe('PFUX11-12 — GPS pill: 4 estados visuais distintos', () => {

  test('PFUX11 — loc-dot e loc-txt presentes no HTML', () => {
    expect(hasId('loc-dot')).toBe(true);
    expect(hasId('loc-txt')).toBe(true);
  });

  test('PFUX12 — CSS define 4 classes de estado do ponto GPS (.ok, .warn, .loading, .erro)', () => {
    // .ok = dentro do raio (verde)
    expect(html).toContain('.loc-dot.ok');
    // .warn = fora da área (laranja/amarelo)
    expect(html).toContain('.loc-dot.warn');
    // .loading = aguardando GPS (animação pulse)
    expect(html).toContain('.loc-dot.loading');
    // .erro = GPS não disponível (vermelho)
    expect(html).toContain('.loc-dot.erro');
  });
});

// ─── PFUX13: animação pulse no estado de carregamento GPS ────────────────────
describe('PFUX13 — GPS loading usa animação pulse', () => {

  test('PFUX13 — keyframes pulse definido no CSS', () => {
    expect(html).toContain('@keyframes pulse');
    expect(html).toMatch(/\.loc-dot\.loading\s*\{[^}]*animation.*pulse/s);
  });
});

// ─── PFUX14-15: Botão CTA retangular ─────────────────────────────────────────
describe('PFUX14-15 — Botão CTA: retangular (não circular)', () => {

  test('PFUX14 — btn-bater usa classe btn-ponto-grande (não circular)', () => {
    // O botão não deve ter border-radius:50% que tornaria circular
    // A classe do botão é btn-ponto-grande, não um círculo
    const btnMatch = html.match(/\.btn-ponto-grande\s*\{[^}]+\}/);
    if (btnMatch) {
      expect(btnMatch[0]).not.toContain('border-radius:50%');
      expect(btnMatch[0]).not.toContain('border-radius: 50%');
    }
    expect(hasId('btn-bater')).toBe(true);
    // btn-bater referencia a classe btn-ponto-grande
    expect(html).toContain('class="btn-ponto-grande"');
  });

  test('PFUX15 — botão tem largura 100% (full-width)', () => {
    expect(html).toMatch(/\.btn-ponto-grande\s*\{[^}]*width:100%/s);
  });
});

// ─── PFUX16-17: Bottom navigation ────────────────────────────────────────────
describe('PFUX16-17 — Bottom navigation: 4 abas', () => {

  test('PFUX16 — func-tabs (bottom nav) presente no HTML', () => {
    expect(html).toContain('func-tabs');
    expect(html).toContain('func-tab');
  });

  test('PFUX17 — 4 abas: Ponto, Banco, Justificar, Espelho', () => {
    // Cada aba aciona mudarAba()
    expect(html).toContain("mudarAba('ponto'");
    expect(html).toContain("mudarAba('banco'");
    expect(html).toContain("mudarAba('justif'");
    expect(html).toContain("mudarAba('espelho'");
    // Labels das abas
    expect(html).toContain('Ponto');
    expect(html).toContain('Banco');
    expect(html).toContain('Justificar');
    expect(html).toContain('Espelho');
  });
});

// ─── PFUX18-20: Header com avatar, nome, cargo, Sair ─────────────────────────
describe('PFUX18-20 — Header: avatar, nome, cargo, Sair', () => {

  test('PFUX18 — header com logo/marca MR4 presente', () => {
    expect(html).toContain('func-header');
    expect(html).toContain('MR4');
  });

  test('PFUX19 — avatar, nome e cargo no header', () => {
    expect(hasId('func-avatar-header')).toBe(true);
    expect(hasId('func-nome-top')).toBe(true);
    expect(hasId('func-cargo-top')).toBe(true);
  });

  test('PFUX20 — botão Sair aciona _signOut (não hardcoded "sair" URL)', () => {
    // Deve chamar window._signOut, não redirecionar diretamente
    expect(html).toContain('_signOut');
    expect(html).toContain('Sair');
    // Não deve ter link direto de logout sem função (segurança)
    expect(html).not.toContain('href="logout"');
    expect(html).not.toContain('href="signout"');
  });
});

// ─── PFUX21-22: Sem reconhecimento facial, sem jsPDF ─────────────────────────
describe('PFUX21-22 — Sem reconhecimento facial e sem jsPDF', () => {

  test('PFUX21 — face-api não referenciado no arquivo', () => {
    expect(html).not.toMatch(/face-api/i);
    expect(html).not.toMatch(/faceapi/i);
    expect(html).not.toMatch(/face_rec/i);
    expect(html).not.toMatch(/facialRecognition/i);
  });

  test('PFUX22 — jsPDF não importado no arquivo', () => {
    expect(html).not.toMatch(/jspdf/i);
    expect(html).not.toMatch(/jsPDF/);
    // exportarEspelhoPDF pode existir mas deve usar window.print(), não jsPDF
    if (html.includes('exportarEspelhoPDF')) {
      const fnStart = html.indexOf('exportarEspelhoPDF');
      const fnEnd   = html.indexOf('\n}', fnStart) + 2;
      const fnBody  = html.slice(fnStart, fnEnd);
      expect(fnBody).not.toMatch(/jspdf/i);
      expect(fnBody).not.toMatch(/new jsPDF/i);
    }
  });
});

// ─── PFUX23: _funcCache e _FUNC_CACHE_TTL preservados ────────────────────────
describe('PFUX23 — Cache de leituras preservado', () => {

  test('PFUX23 — _funcCache e _FUNC_CACHE_TTL=30000 presentes', () => {
    expect(html).toContain('_funcCache');
    expect(html).toContain('_FUNC_CACHE_TTL');
    expect(html).toContain('_FUNC_CACHE_TTL=30000');
    // Invalida cache após escrita: delete _funcCache[c]
    expect(html).toContain('delete _funcCache[');
  });
});

// ─── PFUX24: batidaEmProgresso guard preservado ───────────────────────────────
describe('PFUX24 — Guard anti-duplo-clique preservado', () => {

  test('PFUX24 — batidaEmProgresso declarado e usado para bloquear duplo-toque', () => {
    expect(html).toContain('batidaEmProgresso');
    // Deve verificar no início de iniciarBatida()
    expect(html).toContain('if(batidaEmProgresso)return');
    // Deve ser setado para true ao iniciar
    expect(html).toContain('batidaEmProgresso=true');
    // Deve ser setado para false ao finalizar ou em erro
    expect(html).toContain('batidaEmProgresso=false');
  });
});
