'use strict';
// INF-02 — atualização da Fila/CRM por sinalizador (sem polling curto): comportamento do front-end (sandbox, relógio falso)
// e garantias estáticas das telas, das Rules e dos gatilhos. Sem rede e sem emulador.
const fs = require('fs'), path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const SINAL = require('../lib/filaSinal');

const MIN = 60000;
function tela() {
  const docH = {}, winH = {};
  const liga = h => ({ addEventListener: (e, f) => { (h[e] = h[e] || new Set()).add(f); }, removeEventListener: (e, f) => { if (h[e]) h[e].delete(f); } });
  const doc = { hidden: false, ...liga(docH) }, win = liga(winH);
  const emitir = (h, e, a) => [...(h[e] || [])].forEach(f => f(a));
  const fonte = ['js/vivo.js', 'js/fila-ao-vivo.js'].map(f => R(f).replace(/^import .*$/gm, '').replace(/export (function|const)/g, '$1')).join('\n')
    + '\nreturn { observarFila, PRAZOS, ROTULO_FILA };';
  const M = new Function('document', 'window', 'setTimeout', 'clearTimeout', 'setInterval', 'clearInterval', fonte)(
    doc, win, (...a) => setTimeout(...a), t => clearTimeout(t), (...a) => setInterval(...a), t => clearInterval(t));
  return { ...M, doc, win, visibilidade(oculta) { doc.hidden = oculta; emitir(docH, 'visibilitychange'); }, evento: (e, a) => emitir(winH, e, a) };
}
// servidor falso: documento sinalizador + carregador (a versão devolvida é a vigente quando a consulta COMEÇA, como no backend)
function servidor({ versao = 'v1', existe = true } = {}) {
  const S = { versao, existe, subs: [], consultas: 0, falhar: false, atrasoMs: 0 };
  const snap = () => ({ exists: () => S.existe, data: () => ({ versao: S.versao }) });
  S.fns = { doc: (db, c, i) => c + '/' + i, onSnapshot: (ref, ok, err) => { const s = { ref, ok, err, ativo: true }; S.subs.push(s); return () => { s.ativo = false; }; } };
  S.ativos = () => S.subs.filter(s => s.ativo);
  S.derrubar = code => S.ativos().forEach(s => { s.ativo = false; s.err({ code }); });   // o SDK encerra a assinatura que falhou
  S.entregar = () => S.ativos().forEach(s => s.ok(snap()));
  S.mudar = v => { S.versao = v; S.existe = true; S.entregar(); };
  S.carregar = async () => { S.consultas++; const v = S.existe ? S.versao : ''; if (S.atrasoMs) await new Promise(r => setTimeout(r, S.atrasoMs)); return S.falhar ? null : v; };
  return S;
}
const andar = ms => jest.advanceTimersByTimeAsync(ms);
async function abrir(opts) {
  const T = tela(), S = servidor(opts), status = [];
  const h = T.observarFila({ db: 1, fns: S.fns, carregar: S.carregar, aoStatus: s => status.push(s) });
  await andar(0); S.entregar(); await andar(0);
  return { T, S, h, status };
}
beforeEach(() => jest.useFakeTimers({ now: Date.parse('2026-11-26T12:00:00Z') }));
afterEach(() => jest.useRealTimers());

describe('observarFila — consultas só quando há motivo', () => {
  test('abertura: 1 consulta e 1 listener no sinalizador; parado, só a reconciliação de 15 min (32 em 8 h, contra 1.440)', async () => {
    const { S } = await abrir();
    expect(S.consultas).toBe(1); expect(S.ativos().map(s => s.ref)).toEqual(['crm_fila_versao/estado']);
    await andar(14 * MIN + 59000); expect(S.consultas).toBe(1);
    await andar(1000); expect(S.consultas).toBe(2);
    await andar(8 * 60 * MIN - 15 * MIN); expect(S.consultas).toBe(1 + 32);
  });
  test('mudança de versão recarrega em segundos; mesma versão não; rajada vira uma consulta', async () => {
    const { S } = await abrir();
    S.entregar(); await andar(5000); expect(S.consultas).toBe(1);
    S.mudar('v2'); await andar(1500); expect(S.consultas).toBe(2);
    for (let i = 3; i < 13; i++) { S.mudar('v' + i); await andar(100); }
    await andar(5000); expect(S.consultas).toBe(3);
  });
  test('após a própria ação, o sinal da versão já exibida não gera segunda consulta', async () => {
    const { S, h } = await abrir();
    S.versao = 'v2'; await h.atualizar(); expect(S.consultas).toBe(2);
    S.entregar(); await andar(5000); expect(S.consultas).toBe(2);
  });
  test('sinal que chega DURANTE uma consulta (versão mais nova) gera exatamente mais uma', async () => {
    const { S, h } = await abrir();
    S.atrasoMs = 4000; const p = h.atualizar(); await andar(100); S.mudar('v2'); await andar(20000); await p;
    expect(S.consultas).toBe(3);
  });
  test('mudança entre a 1ª consulta e a 1ª leitura do listener não se perde (nos dois sentidos)', async () => {
    for (const atrasoMs of [0, 3000]) {
      const T = tela(), S = servidor(); S.atrasoMs = atrasoMs;
      T.observarFila({ db: 1, fns: S.fns, carregar: S.carregar });
      await andar(100); S.versao = 'v2'; S.entregar(); await andar(10000);
      expect(S.consultas).toBe(2);
      jest.clearAllTimers();
    }
  });
  test('sinalizador ainda inexistente: sem consulta extra; a criação dele recarrega', async () => {
    const { S } = await abrir({ existe: false });
    expect(S.consultas).toBe(1); S.mudar('v1'); await andar(2000); expect(S.consultas).toBe(2);
  });
  test('atualizar() em paralelo é serializado e resolve com dado pedido depois da chamada', async () => {
    const { S, h } = await abrir(); S.atrasoMs = 1000;
    let a = false, b = false; h.atualizar().then(() => { a = true; }); h.atualizar().then(() => { b = true; });
    await andar(1000); expect(S.consultas).toBe(3); expect(a || b).toBe(false);
    await andar(1000); expect([a, b]).toEqual([true, true]);
  });
});

describe('observarFila — reserva, aba oculta e falhas', () => {
  test('listener com erro: consulta a cada 5 min; reconectado, volta a 15 min', async () => {
    const { S, status } = await abrir();
    S.derrubar('permission-denied'); expect(status).toContain('sem_permissao');
    await andar(5 * MIN); expect(S.consultas).toBe(2); await andar(10 * MIN); expect(S.consultas).toBe(4);
  });
  test('erro transitório: reassina com espera e o intervalo volta ao normal', async () => {
    const { S } = await abrir();
    S.derrubar('unavailable'); await andar(5000); expect(S.ativos()).toHaveLength(1); S.entregar();
    await andar(10 * MIN); expect(S.consultas).toBe(1);
  });
  test('aba oculta: sem listener e sem consultas; ao voltar reassina e recarrega se houve mudança ou se venceu', async () => {
    const { T, S } = await abrir();
    T.visibilidade(true); expect(S.ativos()).toHaveLength(0);
    await andar(60 * MIN); expect(S.consultas).toBe(1);
    S.versao = 'v2'; T.visibilidade(false); await andar(0); expect(S.consultas).toBe(2);      // vencido
    S.entregar(); await andar(5000); expect(S.consultas).toBe(2);                              // mesma versão já exibida
    T.visibilidade(true); S.versao = 'v3'; await andar(MIN); T.visibilidade(false); await andar(0); expect(S.consultas).toBe(2);
    S.entregar(); await andar(2000); expect(S.consultas).toBe(3);                              // mudou enquanto oculta
    T.visibilidade(true); await andar(MIN); T.visibilidade(false); S.entregar(); await andar(5000); expect(S.consultas).toBe(3);   // nada mudou
  });
  test('aba oculta durante a reconexão não reassina escondida', async () => {
    const { T, S } = await abrir();
    S.derrubar('unavailable'); T.visibilidade(true); await andar(MIN); expect(S.ativos()).toHaveLength(0);
    T.visibilidade(false); expect(S.ativos()).toHaveLength(1);
  });
  test('consulta com falha repete em 1, 2, 4 e no máximo 5 min, e normaliza no sucesso', async () => {
    const { S } = await abrir(); S.falhar = true; S.mudar('v2'); await andar(1500); expect(S.consultas).toBe(2);
    for (const esperaMin of [1, 2, 4, 5, 5]) {                // precisão do tique: 30 s
      const antes = S.consultas; let s = 0; while (S.consultas === antes && s < 600) { await andar(1000); s++; }
      expect(s).toBeGreaterThanOrEqual(esperaMin * 60 - 2); expect(s).toBeLessThanOrEqual(esperaMin * 60 + 30);
    }
    S.falhar = false; await andar(5 * MIN + 30000); expect(S.consultas).toBe(8); await andar(14 * MIN); expect(S.consultas).toBe(8);
  });
  test('sair e voltar pelo cache do navegador reativa o listener; parar() encerra tudo', async () => {
    const { T, S, h } = await abrir();
    T.evento('pagehide', {}); expect(S.ativos()).toHaveLength(0); await andar(60 * MIN); expect(S.consultas).toBe(1);
    T.evento('pageshow', { persisted: true }); await andar(0); expect(S.ativos()).toHaveLength(1); expect(S.consultas).toBe(2);
    h.parar(); expect(S.ativos()).toHaveLength(0); await andar(60 * MIN); expect(S.consultas).toBe(2);
  });
});

describe('telas, Rules e gatilhos', () => {
  for (const f of ['crm.html', 'fila-comercial.html']) {
    test(`${f}: um observador, botão Atualizar, nenhum intervalo que consulte o servidor, nenhuma escrita`, () => {
      const h = R('modulos/' + f);
      expect((h.match(/observarFila\(\{/g) || []).length).toBe(1);
      expect(h).toContain("import { observarFila, ROTULO_FILA } from '../js/fila-ao-vivo.js';");
      expect(h).toContain('id="btnAtualizar"'); expect(h).toContain('id="vivoStatus"');
      for (const linha of h.split('\n').filter(l => /setInterval\(/.test(l)).map(l => l.split('//')[0])) expect(linha).not.toMatch(/carregar|fnConsulta|_crmConsulta|lerFila/);
      expect(h).not.toMatch(/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch)\b/);
    });
  }
  test('o módulo do front-end não escreve no Firestore', () => { expect(R('js/fila-ao-vivo.js')).not.toMatch(/setDoc|addDoc|updateDoc|deleteDoc/); });
  test('Rules: sinalizador só get por quem usa a fila; sem listagem; escrita negada', () => {
    const m = R('modulos/firestore.rules').match(/match \/crm_fila_versao\/\{id\} \{([^}]*)\}/);
    expect(m[1]).toMatch(/allow get:\s+if isGestor\(\) \|\| temAcessoModulo\('fila-comercial-gestao'\) \|\| temAcessoModulo\('fila-comercial-operar'\);/);
    expect(m[1]).toMatch(/allow list:\s+if false/); expect(m[1]).toMatch(/allow write: if false/);
  });
  test('toda coleção lida pela fila tem gatilho (exceção declarada: vendas_gc e o cadastro de usuários)', () => {
    const src = R('functions/lib/crmConsulta.js');
    const trecho = src.slice(src.indexOf('async function itensReativacao'), src.indexOf('async function crmConsulta(store'))
      + src.slice(src.indexOf('async function vendasDoCliente'), src.indexOf('async function nomesDe'));
    const lidas = [...new Set([...trecho.matchAll(/collection\('([a-z0-9_]+)'\)/g)].map(m => m[1]))].sort();
    const comGatilho = Object.values(SINAL.FONTES).map(d => d.split('/')[0]);
    expect(lidas.filter(c => !comGatilho.includes(c))).toEqual(['vendas_gc']);
    expect(lidas).toEqual(expect.arrayContaining(comGatilho));
  });
  test('index.js exporta um gatilho por fonte, com retry e teto de instâncias', () => {
    const idx = R('functions/index.js');
    for (const nome of Object.keys(SINAL.FONTES)) expect(idx).toMatch(new RegExp(`exports\\.${nome}\\s+= _gatilhoSinalFila\\(FILA_SINAL\\.FONTES\\.${nome}\\);`));
    expect(idx).toMatch(/_gatilhoSinalFila = document => onDocumentWritten\(\{ document, region: REGION, retry: true, maxInstances: 5/);
    expect(SINAL.FONTES.sinalFilaWorklist).toBe('fila_comercial/worklist');     // snapshot (horário) e prévia não sinalizam
  });
  test('o sinalizador grava só versao + atualizadoEm no documento único; evento antigo é descartado', async () => {
    const gravados = []; const db = { collection: c => ({ doc: i => ({ set: async v => gravados.push([c + '/' + i, v]) }) }) };
    const FieldValue = { serverTimestamp: () => 'TS' };
    await SINAL.sinalizarFila({ db, FieldValue, eventId: 'evt-1', eventTime: new Date().toISOString() });
    expect(gravados).toEqual([['crm_fila_versao/estado', { versao: 'evt-1', atualizadoEm: 'TS' }]]);
    const r = await SINAL.sinalizarFila({ db, FieldValue, eventId: 'evt-2', eventTime: new Date(Date.now() - 11 * MIN).toISOString() });
    expect(r).toEqual({ sinalizado: false, motivo: 'EVENTO_ANTIGO' }); expect(gravados).toHaveLength(1);
  });
});
