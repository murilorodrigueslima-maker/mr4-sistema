'use strict';
// Atualização ao vivo de Compras e CRM Gestão: 1 listener por documento, carregador único reutilizado, nada de escrita pela tela,
// sinalizador do CRM sem dados de cliente e protegido pelas Rules; a operação da gestão só sinaliza (melhor-esforço).
const fs = require('fs'), path = require('path');
const R = p => fs.readFileSync(path.join(__dirname, '..', '..', p), 'utf8');
const COMPRAS = R('modulos/compras.html'), CRM = R('modulos/crm-gestao.html'), RULES = R('modulos/firestore.rules');
describe('Compras ao vivo', () => {
  test('um único listener, no documento agregado, reutilizando o carregador existente', () => {
    expect((COMPRAS.match(/observarAtualizacao\(/g) || []).length).toBe(1);
    expect(COMPRAS).toMatch(/colecao: 'compras_n0_view', id: 'sugestoes', marcador: d => d\.gerado_em, aoMudar: carregarCompras/);
    expect(COMPRAS).toMatch(/async function carregarCompras\(\)/);
    expect((COMPRAS.match(/await carregarCompras\(\)/g) || []).length).toBe(1);
  });
  test('a tela não escreve nada no Firestore', () => { expect(COMPRAS).not.toMatch(/\b(setDoc|updateDoc|addDoc|deleteDoc|writeBatch)\b/); });
});
describe('CRM Gestão ao vivo', () => {
  test('um listener no sinalizador; recarrega só a aba aberta', () => {
    expect((CRM.match(/observarAtualizacao\(/g) || []).length).toBe(1);
    expect(CRM).toMatch(/colecao: 'crm_gestao_versao', id: 'estado'/);
    expect(CRM).toMatch(/aoMudar: async \(\) => \{ if \(!\$\('aba-nc'\)\.hidden\) await listarNC\(\); else if \(!\$\('aba-rev'\)\.hidden\) await pendencias\(\); \}/);
  });
  test('Rules: leitura só da gestão, escrita negada; sem dados de cliente no sinalizador', () => {
    const m = RULES.match(/match \/crm_gestao_versao\/\{id\} \{([^}]*)\}/); expect(m).toBeTruthy();
    expect(m[1]).toMatch(/allow read:\s+if isGestor\(\) \|\| temAcessoModulo\('fila-comercial-gestao'\)/); expect(m[1]).toMatch(/allow write: if false/);
  });
  test('o callable sinaliza após naoContatar/devolucao/reversao, sem nunca falhar a operação', async () => {
    const { reativacaoGestaoHandler } = require('../lib/reativacaoGestaoCallable');
    const sets = []; const db = { collection: c => ({ doc: i => ({ set: async v => { sets.push([c, i, v]); throw new Error('falha simulada'); } }) }) };
    // acao inválida não sinaliza
    await expect(reativacaoGestaoHandler({ auth: { uid: 'u' }, data: { acao: 'x' } }, { db })).rejects.toBeTruthy();
    expect(sets.length).toBe(0);
    const src = require('fs').readFileSync(require.resolve('../lib/reativacaoGestaoCallable'), 'utf8');
    expect((src.match(/await sinalizar\(\)/g) || []).length).toBe(3);
    expect(src).toMatch(/try \{ await store\.collection\('crm_gestao_versao'\)[^]*catch \(_\)/);
  });
});
