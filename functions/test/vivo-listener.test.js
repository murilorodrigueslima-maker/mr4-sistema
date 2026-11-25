'use strict';
// js/vivo.js (módulo ES do front-end) carregado em sandbox: ciclo de vida do listener dos agregados.
const fs = require('fs'), path = require('path');
function carregar() {
  const docH = {}, winH = {}; const doc = { hidden: false, addEventListener: (e, f) => { docH[e] = f; }, removeEventListener: (e) => { delete docH[e]; }, getElementById: () => null, createElement: () => ({ style: {}, setAttribute() {} }), body: { appendChild() {} } };
  const win = { addEventListener: (e, f) => { winH[e] = f; }, removeEventListener: (e) => { delete winH[e]; } };
  const src = fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'vivo.js'), 'utf8').replace(/export (function|const)/g, '$1') + '\nreturn { observarAtualizacao, rotuloStatus, statusPadrao };';
  const m = new Function('document', 'window', 'setTimeout', 'clearTimeout', src)(doc, win, (f) => { return 0; }, () => {});
  return { ...m, doc, docH, winH };
}
function fakeFirestore() {
  const subs = []; return { subs, fns: { doc: (db, c, i) => c + '/' + i, onSnapshot: (ref, ok, err) => { const s = { ref, ok, err, ativo: true }; subs.push(s); return () => { s.ativo = false; }; } } };
}
const snap = d => ({ exists: () => !!d, data: () => d });
const flush = () => new Promise(r => setImmediate(r));

describe('observarAtualizacao', () => {
  test('1ª leitura é a base (não recarrega); mudança do marcador recarrega UMA vez; mesmo marcador não recarrega', async () => {
    const V = carregar(), F = fakeFirestore(); let n = 0;
    V.observarAtualizacao({ db: 1, fns: F.fns, colecao: 'painel_cache', id: 'vendas', marcador: d => d.atualizado_em, aoMudar: async () => { n++; } });
    const s = F.subs[0]; s.ok(snap({ atualizado_em: 'A' })); s.ok(snap({ atualizado_em: 'A' })); await flush(); expect(n).toBe(0);
    s.ok(snap({ atualizado_em: 'B' })); await flush(); expect(n).toBe(1); s.ok(snap({ atualizado_em: 'B' })); await flush(); expect(n).toBe(1);
  });
  test('sem listeners duplicados: reassinar o mesmo documento cancela o anterior', () => {
    const V = carregar(), F = fakeFirestore(); const a = () => V.observarAtualizacao({ db: 1, fns: F.fns, colecao: 'c', id: 'i', marcador: d => d.x, aoMudar: async () => {} });
    a(); a(); expect(F.subs.filter(s => s.ativo)).toHaveLength(1);
  });
  test('cancelado ao sair da tela (pagehide) e pausado com a aba oculta; volta ao reaparecer', () => {
    const V = carregar(), F = fakeFirestore(); V.observarAtualizacao({ db: 1, fns: F.fns, colecao: 'c', id: 'i', marcador: d => d.x, aoMudar: async () => {} });
    V.doc.hidden = true; V.docH.visibilitychange(); expect(F.subs.filter(s => s.ativo)).toHaveLength(0);
    V.doc.hidden = false; V.docH.visibilitychange(); expect(F.subs.filter(s => s.ativo)).toHaveLength(1);
    V.winH.pagehide(); expect(F.subs.filter(s => s.ativo)).toHaveLength(0); expect(Object.keys(V.winH)).toEqual([]); expect(Object.keys(V.docH)).toEqual([]);
  });
  test('sem laço: recarregamentos sobrepostos são serializados (no máximo 1 pendente) e o listener nunca escreve', async () => {
    const V = carregar(), F = fakeFirestore(); let n = 0, solta; const trava = new Promise(r => { solta = r; });
    V.observarAtualizacao({ db: 1, fns: F.fns, colecao: 'c', id: 'i', marcador: d => d.x, aoMudar: async () => { n++; if (n === 1) await trava; } });
    const s = F.subs[0]; s.ok(snap({ x: 1 })); s.ok(snap({ x: 2 })); s.ok(snap({ x: 3 })); s.ok(snap({ x: 4 })); await flush(); expect(n).toBe(1); solta(); await flush(); await flush(); expect(n).toBe(2);
    expect(fs.readFileSync(path.join(__dirname, '..', '..', 'js', 'vivo.js'), 'utf8')).not.toMatch(/setDoc|addDoc|updateDoc|deleteDoc/);
  });
  test('falha de conexão: informa "reconectando"; permissão negada: para e não insiste', () => {
    const V = carregar(), F = fakeFirestore(); const st = []; V.observarAtualizacao({ db: 1, fns: F.fns, colecao: 'c', id: 'i', marcador: d => d.x, aoMudar: async () => {}, aoStatus: s => st.push(s) });
    F.subs[0].err({ code: 'unavailable' }); expect(st).toContain('reconectando');
    const V2 = carregar(), F2 = fakeFirestore(); const st2 = []; V2.observarAtualizacao({ db: 1, fns: F2.fns, colecao: 'c', id: 'i', marcador: d => d.x, aoMudar: async () => {}, aoStatus: s => st2.push(s) });
    F2.subs[0].err({ code: 'permission-denied' }); expect(st2).toContain('sem_permissao'); expect(F2.subs).toHaveLength(1);
  });
  test('as telas usam só os listeners necessários: 1 por tela, nos agregados (vendas, estoque)', () => {
    const rd = f => fs.readFileSync(path.join(__dirname, '..', '..', 'modulos', f), 'utf8');
    expect((rd('vendas.html').match(/observarAtualizacao\(\{/g) || [])).toHaveLength(1); expect((rd('estoque.html').match(/observarAtualizacao\(\{/g) || [])).toHaveLength(1);
    expect(rd('vendas.html')).toMatch(/colecao: 'painel_cache', id: 'vendas'/); expect(rd('estoque.html')).toMatch(/colecao: 'painel_cache', id: 'estoque'/);
  });
});
