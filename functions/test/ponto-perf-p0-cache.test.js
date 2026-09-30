'use strict';
// PONTO — PERFORMANCE P0: camada de leitura das páginas (código REAL extraído do HTML) sem emulador.
// Prova: download duplicado eliminado (promessa compartilhada), invalidação cobre as consultas filtradas,
// falha não fica presa no cache, e as telas iniciais não baixam mais a coleção inteira.
const fs = require('fs'), path = require('path'), vm = require('vm');
const ADMIN = fs.readFileSync(path.join(__dirname, '../../modulos/ponto.html'), 'utf8');
const FUNC = fs.readFileSync(path.join(__dirname, '../../modulos/ponto-func.html'), 'utf8');
const REGRAS = fs.readFileSync(path.join(__dirname, '../../modulos/ponto-regras.js'), 'utf8');
const trecho = (src, ini, fim) => { const i = src.indexOf(ini), f = src.indexOf(fim, i); if (i < 0 || f < 0) throw new Error('trecho não encontrado: ' + ini); return src.slice(i, f); };
const corpo = (src, nome) => { const i = src.indexOf('async function ' + nome + '('); let d = 0, j = src.indexOf('{', i); for (let k = j; k < src.length; k++) { if (src[k] === '{') d++; if (src[k] === '}' && --d === 0) return src.slice(i, k + 1); } throw new Error(nome); };

function ctxFunc(stubs) {
  const ctx = { console, Promise, Date, Object, Array, Set, Number, String, JSON, Math, funcAtivo: { id: 'F1' }, window: stubs };
  vm.createContext(ctx); vm.runInContext(REGRAS, ctx);
  vm.runInContext(trecho(FUNC, 'const _funcCache={};', '// Escritas: registros') + '\n;globalThis.__c=_funcCache;', ctx);
  return ctx;
}
function ctxAdmin(stubs) {
  const ctx = { console, Promise, Date, Object, Array, Set, Number, String, JSON, Math, window: stubs };
  vm.createContext(ctx); vm.runInContext(REGRAS, ctx);
  vm.runInContext('function col(c){return c;} function docRef(c,id){return c+"/"+id;}\n' + trecho(ADMIN, 'const _fbCache={};', '// Navegar meses') + '\n;Object.assign(globalThis,{__c:_fbCache,fbRegistrosDia,fbRegistrosMes,fbJustifMes,fbJustifPendentes});', ctx);
  return ctx;
}

describe('funcionário (ponto-func.html)', () => {
  test('DUPLICATE FETCH eliminado: Histórico do dia e Banco ao mesmo tempo → 1 consulta', async () => {
    let n = 0; const c = ctxFunc({ _fbRegistrosDias: async (f, dias) => { n++; await new Promise(r => setTimeout(r, 5)); return [{ id: 'a', funcId: f, data: dias[0] }, { id: 'b', funcId: f, data: dias[1], substituidoPor: 'x' }]; } });
    const [a, b] = await Promise.all([c.fbRegistrosMes('2026-09'), c.fbRegistrosMes('2026-09')]);
    expect(n).toBe(1); expect(a).toBe(b); expect(a.map(r => r.id)).toEqual(['a']);   // efetivos aplicados
    let m = 0; const c2 = ctxFunc({ _fbGetAll: async () => { m++; await new Promise(r => setTimeout(r, 5)); return []; } });
    await Promise.all([c2.fbGet('justificativas'), c2.fbGet('justificativas')]); expect(m).toBe(1);
  });
  test('consulta do mês usa todos os dias do mês (fevereiro, 30 e 31 dias)', () => {
    const c = ctxFunc({});
    expect(c.diasDoMes('2026-02')).toHaveLength(28); expect(c.diasDoMes('2026-09')).toHaveLength(30); expect(c.diasDoMes('2026-08')).toHaveLength(31);
    expect(c.diasDoMes('2026-09')[0]).toBe('2026-09-01'); expect(c.diasDoMes('2026-09')[29]).toBe('2026-09-30');
  });
  test('invalidação após a batida limpa a coleção E as consultas do mês (renderiza o dado novo)', async () => {
    let n = 0; const c = ctxFunc({ _fbRegistrosDias: async () => { n++; return []; }, _fbGetAll: async () => [] });
    await c.fbRegistrosMes('2026-09'); await c.fbGet('registros'); await c.fbGet('registros', 'F1');
    c.invalidarCache('registros');
    expect(Object.keys(c.__c).filter(k => k.startsWith('registros'))).toEqual([]);
    await c.fbRegistrosMes('2026-09'); expect(n).toBe(2);
  });
  test('falha de rede não fica no cache (próxima tentativa consulta de novo)', async () => {
    let n = 0; const c = ctxFunc({ _fbRegistrosDias: async () => { n++; if (n === 1) throw new Error('unavailable'); return []; } });
    await expect(c.fbRegistrosMes('2026-09')).rejects.toThrow('unavailable');
    await expect(c.fbRegistrosMes('2026-09')).resolves.toEqual([]); expect(n).toBe(2);
  });
  test('abertura (renderHistDia/renderBancoFunc/proxPonto) não baixa mais o histórico completo', () => {
    for (const f of ['renderHistDia', 'renderBancoFunc']) { const b = corpo(FUNC, f); expect(b).toMatch(/fbRegistrosMes\(/); expect(b).not.toMatch(/fbGet\('registros'\)/); }
    expect(corpo(FUNC, 'proxPonto')).toMatch(/fbRegistrosMes\(mesAtual\(\)\)/);
    // assinatura (SIGNED_SNAPSHOT) e espelho legado continuam com a leitura completa — intocados
    expect(corpo(FUNC, 'abrirAssinar')).toMatch(/fbGet\('registros'\)/);
    // a consulta por dias tem fallback para o comportamento anterior
    expect(FUNC).toMatch(/_fbRegistrosDias[\s\S]{0,900}catch \(e\)[\s\S]{0,300}_fbGetAll\('registros', funcId\)/);
  });
});

describe('admin (ponto.html)', () => {
  test('mesma coleção pedida por duas telas ao mesmo tempo → 1 download; consultas filtradas com efetivos', async () => {
    let n = 0, q = 0;
    const c = ctxAdmin({ _getDocs: async () => { n++; await new Promise(r => setTimeout(r, 5)); return { docs: [] }; }, _qDocs: async (col, filtros) => { q++; return [{ id: 'x', data: filtros[0][2] }, { id: 'y', data: filtros[0][2], substituidoPor: 'z' }]; } });
    await Promise.all([c.fbGet('funcionarios'), c.fbGet('funcionarios')]); expect(n).toBe(1);
    const [a, b] = await Promise.all([c.fbRegistrosDia('2026-09-29'), c.fbRegistrosDia('2026-09-29')]); expect(q).toBe(1); expect(a.map(r => r.id)).toEqual(['x']); expect(a).toBe(b);
  });
  test('escrever numa coleção invalida a coleção e todas as consultas dela', async () => {
    const c = ctxAdmin({ _getDocs: async () => ({ docs: [] }), _qDocs: async () => [], _setDoc: async () => {}, _deleteDoc: async () => {} });
    await c.fbGet('registros'); await c.fbRegistrosMes('2026-09'); await c.fbJustifPendentes(); await c.fbJustifMes('2026-09');
    await c.fbSet('registros', 'r1', {}); expect(Object.keys(c.__c).filter(k => k.startsWith('registros'))).toEqual([]);
    expect(Object.keys(c.__c).filter(k => k.startsWith('justificativas')).length).toBe(2);
    await c.fbDel('justificativas', 'j1'); expect(Object.keys(c.__c).filter(k => k.startsWith('justificativas'))).toEqual([]);
  });
  test('primeira tela (renderHoje + badge) não baixa registros/justificativas inteiros', () => {
    const h = corpo(ADMIN, 'renderHoje'); expect(h).toMatch(/fbRegistrosDia\(hoje\(\)\)/); expect(h).not.toMatch(/fbGet\('registros'\)/);
    const b = corpo(ADMIN, 'atualizarBadgeJustif'); expect(b).toMatch(/fbJustifPendentes\(\)/); expect(b).not.toMatch(/fbGet\('justificativas'\)/);
    expect(corpo(ADMIN, 'renderBanco')).toMatch(/fbRegistrosMes\(mesAtual\(\)\)/);
    expect(corpo(ADMIN, 'gerarEspelho')).toMatch(/fbRegistrosMes\(mes\)/);
    expect(ADMIN).toMatch(/invalidarCache\('registros','justificativas','creditos_jornada'\)/);   // após a decisão da justificativa
  });
});
