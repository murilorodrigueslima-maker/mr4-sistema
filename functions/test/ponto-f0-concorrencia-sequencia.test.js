'use strict';
// PONTO MR4 2.0 — concorrência ENTRE tipos de batida (handler real + transações reais do EMULADOR; PROD_WRITES=0).
// Invariantes, para qualquer intercalação: (1) cada tipo no máximo 1× por dia; (2) o estado final é um PREFIXO válido da sequência
// entrada → saída almoço → retorno → saída; (3) nenhum request aceito fica fora de ordem; (4) só há recusas "esperadas" (estado atual informado).
process.env.FIRESTORE_EMULATOR_HOST = 'localhost:8080';
process.env.GCLOUD_PROJECT = 'mr4-ponto';
process.env.PONTO_COOLDOWN_MS = '0';
const admin = require('firebase-admin');
if (!admin.apps.length) admin.initializeApp({ projectId: 'mr4-ponto' });
const db = admin.firestore();
const { _registrarPontoHandler: bater } = require('../index');
const PB = require('../lib/pontoBatida');
jest.setTimeout(120000);

const UID = 'uid-conc-func', FUNC = 'func-conc-001', GPS = { lat: -3.7603154, lng: -38.5634329 };
let n = 0; const rid = () => 'conc' + String(++n).padStart(5, '0') + Math.random().toString(36).slice(2, 8);
const req = tipoEsperado => ({ auth: { uid: UID, token: {} }, data: { ...GPS, requestId: rid(), tipoEsperado } });
const res = p => p.then(r => ({ ok: true, ...r }), e => ({ ok: false, code: e.code, codigo: e.details && e.details.codigo }));
const limpar = async () => { const s = await db.collection('registros').where('funcId', '==', FUNC).get(); const b = db.batch(); s.docs.forEach(d => b.delete(d.ref)); await b.commit(); };
const tipos = async () => (await db.collection('registros').where('funcId', '==', FUNC).get()).docs.map(d => d.data()).sort((a, b) => (a.hora < b.hora ? -1 : a.hora > b.hora ? 1 : a.criadoEm.toMillis() - b.criadoEm.toMillis())).map(d => d.tipo);   // mesmo desempate do servidor (hora, criadoEm)
const semear = async k => { for (const t of PB.TIPOS.slice(0, k)) { const r = await res(bater(req(t))); expect(r.ok).toBe(true); } };
const ESPERADOS = ['TIPO_ESPERADO_DIVERGENTE', 'JA_REGISTRADO', 'COOLDOWN', 'DIA_COMPLETO'];

beforeAll(async () => { await db.doc('users/' + UID).set({ role: 'funcionario', ativo: true, funcionarioId: FUNC, nome: 'Func Conc' }); await db.doc('funcionarios/' + FUNC).set({ nome: 'Func Conc', cargo: 'Teste', modalidade: 'PRESENCIAL' }); });
beforeEach(async () => { await limpar(); });
afterAll(async () => { await limpar(); await db.doc('users/' + UID).delete(); await db.doc('funcionarios/' + FUNC).delete(); });

// [rótulo, quantas batidas já existem, tipos enviados ao mesmo tempo]
const CASOS = [
  ['mesma batida simultânea (entrada ×8, intenções distintas)', 0, Array(8).fill('entrada')],
  ['entrada + almoço concorrentes', 0, ['entrada', 'saida_almoco']],
  ['almoço + retorno concorrentes', 1, ['saida_almoco', 'retorno_almoco']],
  ['retorno + saída concorrentes', 2, ['retorno_almoco', 'saida']],
  ['três ao mesmo tempo a partir do início', 0, ['entrada', 'saida_almoco', 'retorno_almoco']],
  ['todos os tipos ao mesmo tempo (ordem embaralhada)', 0, ['saida', 'retorno_almoco', 'entrada', 'saida_almoco']],
];
describe.each(CASOS)('%s', (rotulo, inicio, enviados) => {
  test('20 rodadas: estado final sempre válido, sem duplicata e sem recusa inesperada', async () => {
    for (let i = 0; i < 20; i++) {
      await limpar(); await semear(inicio);
      const rs = await Promise.all(enviados.map(t => res(bater(req(t)))));
      const final = await tipos();
      expect(final).toEqual(PB.TIPOS.slice(0, final.length));                 // prefixo válido da sequência (ordem e sem buracos)
      expect(new Set(final).size).toBe(final.length);                          // nenhum tipo repetido
      const aceitos = rs.filter(r => r.ok && r.status === 'REGISTRADO').length;
      expect(final.length - inicio).toBe(aceitos);                             // cada aceite = exatamente 1 documento novo
      expect(final.length).toBeGreaterThan(inicio);                            // alguém sempre avança (nada trava)
      for (const r of rs.filter(x => !x.ok)) expect([rotulo, ESPERADOS.includes(r.codigo) || r.code === 'aborted']).toEqual([rotulo, true]);
    }
  });
});
