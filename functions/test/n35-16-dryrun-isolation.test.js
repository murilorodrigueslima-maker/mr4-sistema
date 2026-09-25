'use strict';
// N35.16 — Isolamento do DRY_RUN: a prévia nunca chega à vendedora nem cria estado operacional.
const fs = require('fs');
const path = require('path');
const G = require('../lib/worklistGenerator');
const QC = require('../lib/filaQueueConfig');

const FAB = 'UGXinD3KVXX0ouYEfamBWjizC5C2';
const NOW = new Date('2026-09-25T09:00:00.000Z');
const quiet = { log() {} };
const ROOT = path.join(__dirname, '..', '..');

function vendas(n) {
  const out = [];
  for (let i = 0; i < n; i++) {
    const gc = String(66600000 + i);
    for (let k = 0; k < 5; k++) {
      const d = new Date(Date.UTC(2026, 2, 10 + (i % 15)) - k * 20 * 86400000).toISOString().slice(0, 10);
      out.push({ id: gc + 'v' + k, cliente_id: gc, data: d, nome_situacao: 'Concretizada', valor_total: '300', cadastrado_em: d + ' 10:00:00', vendedor_id: '1', produtos: [] });
    }
  }
  return out;
}
const dados = () => ({
  perfis: [], clientes: [], vendas: vendas(15), estados: new Map(),
  users: new Map([[FAB, { ativo: true, role: 'funcionario' }]]),
  sistema: new Map([[FAB, { modulos: ['fila-comercial-operar'], filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } }]]),
});
function fakeDb(inicial = {}) {
  const docs = new Map(Object.entries(inicial));
  const writes = [];
  return {
    writes, docs,
    collection: c => ({ doc: id => ({
      get: async () => ({ exists: docs.has(`${c}/${id}`), data: () => docs.get(`${c}/${id}`) }),
      set: async d => { writes.push(`${c}/${id}`); docs.set(`${c}/${id}`, d); },
      delete: async () => { writes.push(`DELETE ${c}/${id}`); docs.delete(`${c}/${id}`); },
    }) }),
  };
}

test('DR-01 modo efetivo do repositório = DRY_RUN', () => {
  expect(QC.WORKLIST_V2_MODE).toBe('DRY_RUN');
});

test('DR-02 função agendada não sobrescreve o modo (usa o valor do config)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'index.js'), 'utf8');
  const bloco = src.slice(src.indexOf('exports.gerarWorklistDiaria'), src.indexOf('// N35.11 — Callables da Fila Comercial'));
  expect(bloco).toContain('executarGeracaoWorklist({ db, lookupNome })');
  expect(bloco).not.toMatch(/mode\s*:/);
  expect(bloco).not.toMatch(/LIVE/);
});

test('DR-03 DRY_RUN grava exatamente 1 documento: fila_comercial/worklist_preview', async () => {
  const db = fakeDb();
  const r = await G.executarGeracaoWorklist({ db, now: NOW, logger: quiet, lookupNome: async gc => 'N' + gc, dados: dados() });
  expect(r.escrito).toBe('fila_comercial/worklist_preview');
  expect(db.writes).toEqual(['fila_comercial/worklist_preview']);
});

test('DR-04 DRY_RUN com worklist LIVE existente: LIVE intocada (nem lida para decidir, nem regravada)', async () => {
  const live = { schemaVersion: 'worklist-v2', dataReferencia: '2026-09-25', marcador: 'LIVE-ORIGINAL' };
  const db = fakeDb({ 'fila_comercial/worklist': live });
  await G.executarGeracaoWorklist({ db, now: NOW, logger: quiet, lookupNome: async gc => 'N' + gc, dados: dados() });
  expect(db.docs.get('fila_comercial/worklist')).toBe(live);
  expect(db.writes).not.toContain('fila_comercial/worklist');
});

test('DR-05 DRY_RUN nunca escreve interacoes_fila, perfis_360, clientes, vendas_gc, users ou sistema_usuarios', async () => {
  const db = fakeDb();
  await G.executarGeracaoWorklist({ db, now: NOW, logger: quiet, lookupNome: async gc => 'N' + gc, dados: dados() });
  expect(db.writes.filter(w => !w.startsWith('fila_comercial/worklist_preview'))).toEqual([]);
});

test('DR-06 a tela assina SOMENTE fila_comercial/worklist (nunca a prévia)', () => {
  const html = fs.readFileSync(path.join(ROOT, 'modulos', 'fila-comercial.html'), 'utf8');
  expect(html).toContain("doc(db, 'fila_comercial', 'worklist')");
  expect(html).not.toContain('worklist_preview');
});

test('DR-07 a callable de claim valida atribuição SOMENTE contra fila_comercial/worklist', () => {
  const src = fs.readFileSync(path.join(ROOT, 'functions', 'lib', 'canaryCallable.js'), 'utf8');
  expect(src).toMatch(/const WORKLIST_DOC = 'worklist';/);
  expect(src).not.toContain('worklist_preview');
});

test('DR-08 a prévia só usa campos permitidos (mesma validação do LIVE)', async () => {
  const db = fakeDb();
  await G.executarGeracaoWorklist({ db, now: NOW, logger: quiet, lookupNome: async gc => 'N' + gc, dados: dados() });
  const doc = db.docs.get('fila_comercial/worklist_preview');
  expect(JSON.stringify(doc)).not.toMatch(/prioridade|faturamento|cpf|cnpj|telefone|email|endereco/i);
  expect(doc.vendedores[FAB].novas).toHaveLength(10);
});
