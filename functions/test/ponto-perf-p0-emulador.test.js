'use strict';
// PONTO — PERFORMANCE P0: as consultas filtradas do RC devolvem EXATAMENTE o que as telas filtravam em memória,
// são permitidas pelas Rules para quem já tinha acesso, e leem uma fração dos documentos. Emulador; dados sintéticos.
const { initializeTestEnvironment, assertFails, assertSucceeds } = require('@firebase/rules-unit-testing');
const { readFileSync } = require('fs'); const { resolve } = require('path');

const PROJECT_ID = 'mr4-ponto';
const U = { gestor: 'pp-gestor', func1: 'pp-func-1', func2: 'pp-func-2' };
const F = { f1: 'FUNC-PP-1', f2: 'FUNC-PP-2', f3: 'FUNC-PP-3' };
const HOJE = '2026-09-29', ONTEM = '2026-09-28';
const FOTO = 'data:image/jpeg;base64,' + 'A'.repeat(30000);   // peso sintético equivalente à selfie da batida
let env;

const dias = mes => { const [y, m] = mes.split('-').map(Number); const n = new Date(Date.UTC(y, m, 0)).getUTCDate(); return Array.from({ length: n }, (_, i) => mes + '-' + String(i + 1).padStart(2, '0')); };
function fixture() {
  const regs = []; let n = 0;
  const tipos = ['entrada', 'saida_almoco', 'retorno_almoco', 'saida'];
  for (const mes of ['2026-07', '2026-08', '2026-09']) for (const d of dias(mes)) {
    if (d > HOJE) continue;
    for (const f of Object.values(F)) tipos.forEach((t, i) => { if ((n + i) % 7 === 0) return; regs.push({ id: 'R' + (++n), funcId: f, funcNome: 'Sintético ' + f, data: d, hora: String(8 + i * 2).padStart(2, '0') + ':0' + (n % 10) + ':00', tipo: t, tipoLabel: t, criadoEm: (n % 3 ? d + 'T12:00:00Z' : null), foto: n % 2 ? FOTO : null }); });
  }
  regs.push({ ...regs.find(r => r.data === HOJE && r.funcId === F.f1), id: 'R-SUB', substituidoPor: 'R-NOVA' });   // substituída: não conta
  const just = [];
  for (let i = 0; i < 40; i++) just.push({ id: 'J' + i, funcId: Object.values(F)[i % 3], data: dias('2026-09')[i % 28], status: ['pendente', 'aprovado', 'rejeitado'][i % 3], motivo: 'sintético', anexo: i === 3 ? FOTO : null });
  return { regs, just };
}
const FX = fixture();
const efetivos = l => l.filter(r => !r.substituidoPor);

beforeAll(async () => {
  env = await initializeTestEnvironment({ projectId: PROJECT_ID, firestore: { rules: readFileSync(resolve(__dirname, '../../modulos/firestore.rules'), 'utf8'), host: 'localhost', port: 8080 } });
  await env.withSecurityRulesDisabled(async c => {
    const db = c.firestore();
    await db.collection('users').doc(U.gestor).set({ role: 'gestor', ativo: true });
    await db.collection('sistema_usuarios').doc(U.gestor).set({ nome: 'G', modulos: ['ponto'], admin: false, bloqueado: false });
    await db.collection('users').doc(U.func1).set({ role: 'funcionario', ativo: true, funcionarioId: F.f1 });
    await db.collection('users').doc(U.func2).set({ role: 'funcionario', ativo: true, funcionarioId: F.f2 });
    let b = db.batch(), k = 0;
    for (const r of FX.regs) { b.set(db.collection('registros').doc(r.id), r); if (++k % 400 === 0) { await b.commit(); b = db.batch(); } }
    for (const j of FX.just) b.set(db.collection('justificativas').doc(j.id), j);
    await b.commit();
  });
}, 120000);
afterAll(async () => { await env.cleanup(); });

const fs = uid => env.authenticatedContext(uid).firestore();
const ids = s => s.docs.map(d => d.id).sort();
const bytes = s => s.docs.reduce((t, d) => t + Buffer.byteLength(JSON.stringify(d.data())), 0);

describe('ADMIN — consultas do RC = filtros antigos em memória', () => {
  test('Hoje: data == hoje (antes: coleção inteira + filter)', async () => {
    const q = await fs(U.gestor).collection('registros').where('data', '==', HOJE).get();
    expect(ids(q)).toEqual(FX.regs.filter(r => r.data === HOJE).map(r => r.id).sort());
  });
  test('Mês (Registros/Banco/Espelho): data >= mes-01 && data <= mes-31 = startsWith(mes)', async () => {
    for (const mes of ['2026-07', '2026-08', '2026-09']) {
      const q = await fs(U.gestor).collection('registros').where('data', '>=', mes + '-01').where('data', '<=', mes + '-31').get();
      expect(ids(q)).toEqual(FX.regs.filter(r => r.data.startsWith(mes)).map(r => r.id).sort());
      const j = await fs(U.gestor).collection('justificativas').where('data', '>=', mes + '-01').where('data', '<=', mes + '-31').get();
      expect(ids(j)).toEqual(FX.just.filter(x => x.data.startsWith(mes)).map(x => x.id).sort());
    }
  });
  test('Badge: status == pendente = filtro antigo', async () => {
    const q = await fs(U.gestor).collection('justificativas').where('status', '==', 'pendente').get();
    expect(ids(q)).toEqual(FX.just.filter(j => j.status === 'pendente').map(j => j.id).sort());
  });
  test('Últimas batidas: 40 mais recentes por data contêm o último dia completo; top 5 = 5 mais recentes reais', async () => {
    const q = await fs(U.gestor).collection('registros').orderBy('data', 'desc').limit(40).get();
    const ord = (a, b) => (a.data + ' ' + a.hora) > (b.data + ' ' + b.hora) ? -1 : 1;
    const top = efetivos(q.docs.map(d => ({ id: d.id, ...d.data() }))).sort(ord).slice(0, 5).map(r => r.id);
    expect(top).toEqual(efetivos(FX.regs).sort(ord).slice(0, 5).map(r => r.id));
  });
  test('desempenho: abertura (hoje + pendentes) lê uma fração da coleção', async () => {
    const tudo = await fs(U.gestor).collection('registros').get(), jt = await fs(U.gestor).collection('justificativas').get();
    const h = await fs(U.gestor).collection('registros').where('data', '==', HOJE).get(), p = await fs(U.gestor).collection('justificativas').where('status', '==', 'pendente').get();
    const r = { antes_docs: tudo.size + jt.size, antes_bytes: bytes(tudo) + bytes(jt), rc_docs: h.size + p.size, rc_bytes: bytes(h) + bytes(p) };
    console.log('PONTO_PERF_ADMIN ' + JSON.stringify(r));
    expect(r.rc_docs * 20).toBeLessThan(r.antes_docs); expect(r.rc_bytes * 20).toBeLessThan(r.antes_bytes);
  });
});

describe('FUNCIONÁRIO — consulta do próprio mês', () => {
  const doMes = (funcId, mes) => { const d = dias(mes); return [d.slice(0, 30), d.slice(30)].filter(x => x.length); };
  test('funcId == próprio && data in (≤ 30 dias por consulta) = todos dele + startsWith(mes)', async () => {
    for (const mes of ['2026-07', '2026-08', '2026-09']) {
      const got = [];
      for (const lote of doMes(F.f1, mes)) got.push(...(await fs(U.func1).collection('registros').where('funcId', '==', F.f1).where('data', 'in', lote).get()).docs.map(d => d.id));
      expect(got.sort()).toEqual(FX.regs.filter(r => r.funcId === F.f1 && r.data.startsWith(mes)).map(r => r.id).sort());
    }
  });
  test('Rules: a consulta nova é permitida para o próprio; negada para outro funcionário e sem o filtro de funcId', async () => {
    await assertSucceeds(fs(U.func1).collection('registros').where('funcId', '==', F.f1).where('data', 'in', [HOJE, ONTEM]).get());
    await assertFails(fs(U.func1).collection('registros').where('funcId', '==', F.f2).where('data', 'in', [HOJE]).get());
    await assertFails(fs(U.func1).collection('registros').where('data', 'in', [HOJE]).get());
    await assertSucceeds(fs(U.func1).collection('registros').where('funcId', '==', F.f1).get());   // fallback (comportamento anterior) continua permitido
  });
  test('desempenho: abertura lê o mês (1 download) em vez de todo o histórico duas vezes', async () => {
    const tudo = await fs(U.func1).collection('registros').where('funcId', '==', F.f1).get();
    let rc = 0, rcB = 0; for (const lote of doMes(F.f1, '2026-09')) { const s = await fs(U.func1).collection('registros').where('funcId', '==', F.f1).where('data', 'in', lote).get(); rc += s.size; rcB += bytes(s); }
    const r = { antes_docs: tudo.size * 2, antes_bytes: bytes(tudo) * 2, rc_docs: rc, rc_bytes: rcB };
    console.log('PONTO_PERF_FUNC ' + JSON.stringify(r));
    expect(r.rc_docs * 4).toBeLessThan(r.antes_docs);
  });
});
