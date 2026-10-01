'use strict';
// AGENTE DE COMPRAS · UI (varredura estática: gate oculto, backend decide, nada de segredo/escrita) + o motor/módulo existente NÃO foi alterado.
const fs = require('fs'), path = require('path'), { execSync } = require('child_process');
const RAIZ = path.join(__dirname, '../..');
const HTML = fs.readFileSync(path.join(RAIZ, 'modulos/compras.html'), 'utf8');
const BASE_COMMIT = 'c79ad64';

describe('integração na página de Compras', () => {
  test('aba/botão "Agente" OCULTO por padrão; painel oculto; só aparece por montarAgente (depois do backend)', () => {
    expect(HTML).toMatch(/<button data-aba="agente" id="tabAgente" hidden>Agente<\/button>/); expect(HTML).toMatch(/<div id="painelAgente" hidden>/);
    expect((HTML.match(/getElementById\('tabAgente'\)\.hidden = false/g) || []).length).toBe(1); expect(HTML).toMatch(/function montarAgente\(\) \{\s*document\.getElementById\('tabAgente'\)\.hidden = false;/);
    expect(HTML).toMatch(/liberarSePermitido\(fnAgente, 'purchasing', montarAgente\)/);
  });
  test('o gate é chamado SÓ depois do login + guard do módulo (nunca no carregamento do script) e sem bloquear a página', () => {
    const iGuard = HTML.indexOf("verificarAcessoModulo(db, user.uid, 'compras')"), iChamada = HTML.indexOf('  liberarAgente();'), iDef = HTML.indexOf('async function liberarAgente');
    expect(iGuard).toBeGreaterThan(0); expect(iChamada).toBeGreaterThan(iGuard); expect(iDef).toBeGreaterThan(0); expect((HTML.match(/^\s+liberarAgente\(\);/gm) || []).length).toBe(1); expect(HTML).toMatch(/async function liberarAgente\(\) \{\s*try \{/);   // falha isolada
    const trecho = HTML.slice(iChamada - 200, iChamada + 80); expect(trecho).toMatch(/mainContent'\)\.style\.display = ''/);   // depois de a página já estar visível
  });
  test('usa a callable aiAgente com agentType purchasing; chave/provedor nunca no navegador; sem escrita de dados', () => {
    expect(HTML).toMatch(/httpsCallable\(getFunctions\(app, 'southamerica-east1'\), 'aiAgente'\)/); expect(HTML).toMatch(/await import\('https:\/\/www\.gstatic\.com\/firebasejs\/10\.12\.0\/firebase-functions\.js'\)/);   // dinâmico e isolado: falha do SDK não derruba a página expect(HTML).toMatch(/agentType: 'purchasing'/); expect(HTML).toMatch(/<script src="agente-ia-widget\.js"><\/script>/);
    expect(HTML).not.toMatch(/OPENAI|sk-[A-Za-z0-9]{8}|api\.openai\.com/i); expect(HTML).not.toMatch(/\b(setDoc|addDoc|updateDoc|deleteDoc|writeBatch|runTransaction)\b/);
    const agente = HTML.slice(HTML.indexOf('// ── Agente de Compras'), HTML.indexOf('function sincronizarAbas'));
    expect(agente).not.toMatch(/Firestore|getDoc|fetch\(|localStorage|\.innerHTML\s*=\s*[^;]*\+/);
  });
  test('chips pedidos + orçamento editável + pergunta livre (widget) + cartões do resumo', () => {
    for (const r of ['O que comprar?', 'Compras urgentes', 'Compras que podem esperar', 'Risco de ruptura', 'Resumo de compras', 'Estou comprando demais?', 'Revisar sugestões']) expect(HTML).toContain("rotulo: '" + r + "'");
    expect(HTML).toMatch(/id="agcValor"/); expect(HTML).toMatch(/id="agcOrc"/); expect(HTML).toMatch(/'Se eu tiver R\$ '/);
    for (const c of ['produtosParaRepor', 'capitalSugerido', 'itensCriticos', 'podemAguardar', 'riscoRuptura']) expect(HTML).toContain("chave: '" + c + "'");
    expect(HTML).toMatch(/Não cria pedido nem altera sugestões/);
  });
  test('o resto da página foi preservado: abas, orçamento, filtros e simulador continuam; diff só adiciona (1 linha de render reescrita)', () => {
    for (const t of ['data-aba="sug"', 'data-aba="aten"', 'id="tabRev"', 'id="tabOrc"', 'iniciarOrcamento()', 'function atualizarOrcamento', 'compras-simulador.js', "doc(db, 'compras_n0_view', 'sugestoes')"]) expect(HTML).toContain(t);
    const d = execSync(`git diff --numstat ${BASE_COMMIT} -- modulos/compras.html`, { cwd: RAIZ }).toString().trim().split('\t'); expect(Number(d[1])).toBeLessThanOrEqual(2);   // remoções: só a linha de `const aba…` reescrita
  });
});

describe('o agente de Compras só LÊ (guard de escopo do RC removido na integração)', () => {
  test('o agente só LÊ: nenhum require de escrita/Admin SDK nem de módulos de sync/execução do motor', () => {
    const dir = path.join(RAIZ, 'functions/lib/ai/agents/purchasing'); const src = fs.readdirSync(dir).map(f => fs.readFileSync(path.join(dir, f), 'utf8')).join('\n');
    expect(src).not.toMatch(/\.doc\([^)]*\)\.(set|update|delete)\(|\.collection\([^)]*\)\.add\(|batch\(|runTransaction|firebase-admin|require\('[^']*compras\/(snapshot|execucao|entrypoints|fetch|canonico)'\)/);
    expect(src).toMatch(/require\('..\/..\/..\/compras\/simulador'\)/);   // reutiliza o simulador do motor
  });
  test('o simulador do motor é o MESMO da tela (cópia idêntica em js/)', () => {
    const a = fs.readFileSync(path.join(RAIZ, 'functions/lib/compras/simulador.js'), 'utf8'), b = fs.readFileSync(path.join(RAIZ, 'js/compras-simulador.js'), 'utf8'); expect(b).toBe(a);
  });
});
