'use strict';
// Widget genérico dos agentes: apresentação PURA (Node) + varredura estática de segurança do DOM. Sem rede, sem IA.
const fs = require('fs'), path = require('path');
const W = require('../../modulos/agente-ia-widget.js');
const SRC = fs.readFileSync(path.join(__dirname, '../../modulos/agente-ia-widget.js'), 'utf8');
const CFG = { agentType: 'demo', rotuloAbrir: 'Abrir', onAbrir: () => {}, cartoes: [{ chave: 'a', rotulo: 'A' }, { chave: 'capital', rotulo: 'Capital' }], formatos: { capital: 'brl' }, sugestoes: [{ rotulo: 'Ver <b>x</b>', modo: 'pergunta', pergunta: 'q' }] };
const OK = { ok: true, ia: { status: 'OK', modelo: 'm' }, answer: '<img src=x onerror=alert(1)> Produto <b>X</b>', entities: [{ id: '<s>1', nome: '"><script>alert(1)</script>', reasonCodes: [{ code: 'A', label: '<i>motivo</i>' }], evidence: [{ metric: 'estoque', label: 'Estoque', value: 48 }, { metric: 'capital', label: 'Capital', value: 1234.5 }, { metric: 'ultimaVendaEm', label: 'Última venda', value: '2026-05-01' }, { metric: 'pctX', label: 'v', value: 'x' }] }], recommendations: [{ entity: { nome: 'N' }, actionLabel: 'Revisar', rationale: '<u>r</u>' }], warnings: ['<w>'], unavailable: ['<u>'], dataFreshness: 'ok', avisoFrescor: 'Dados desatualizados' };
describe('apresentação segura', () => {
  test('tudo que vem de dados passa por esc(): sem tag/atributo injetável no HTML final', () => {
    const h = W.htmlResposta(W.modeloResposta(OK, CFG), CFG) + W.htmlChips(CFG, false) + W.htmlCartoes({ a: '<x>', capital: 10 }, CFG);
    expect(h).not.toMatch(/<script|<img|<b>X|<i>motivo|<u>|<w>|<s>1/); expect(h).toMatch(/&lt;script&gt;/); expect(h).toMatch(/data-agw-abrir="&lt;s&gt;1"/);
  });
  test('formatação: R$, data, números; valor ausente vira traço', () => {
    expect(W.formatar('capital', 1234.5, CFG)).toBe('R$ 1.234,50'); expect(W.formatar('ultimaVendaEm', '2026-05-01', CFG)).toBe('01/05/2026'); expect(W.formatar('estoque', 48, CFG)).toBe('48'); expect(W.formatar('x', null, CFG)).toBe('—'); expect(W.formatar('variacaoPct', -12.5, {})).toMatch(/-12,5%/);
  });
  test('falha da IA: mensagem controlada + resultado determinístico (fallback) + módulo segue', () => {
    const m = W.modeloResposta({ ok: true, ia: { status: 'INDISPONIVEL', motivo: 'TIMEOUT' }, fallback: [{ id: 'S1', nome: 'Item', reasonCodes: [{ label: 'm' }], evidence: [] }] }, CFG);
    expect(m.iaOk).toBe(false); expect(m.mensagem).toMatch(/demorou demais.*continua funcionando/); expect(m.entidades[0].nome).toBe('Item'); expect(W.htmlResposta(m, CFG)).toMatch(/calculado pelo sistema \(sem IA\)/);
  });
  test('pergunta: limite de 400 e sem caracteres de controle', () => { expect(W.validarPergunta('a'.repeat(401)).ok).toBe(false); expect(W.validarPergunta('  oi\u0000  ').texto).toBe('oi'); expect(W.validarPergunta('').ok).toBe(false); });
  test('gate do frontend: só libera quando o backend responde acesso === true; erro/negado não libera', async () => {
    let lib = 0; await W.liberarSePermitido(async () => ({ acesso: true }), 'demo', () => lib++); await W.liberarSePermitido(async () => ({ acesso: false }), 'demo', () => lib++); await W.liberarSePermitido(async () => { throw new Error('permission-denied'); }, 'demo', () => lib++); expect(lib).toBe(1);
  });
  test('estático: sem segredo/chave, sem chamada de rede própria, sem escrita de dados; innerHTML só com esc()/htmlX', () => {
    expect(SRC).not.toMatch(/OPENAI|sk-[A-Za-z0-9]|api\.openai|fetch\(|XMLHttpRequest|localStorage|firestore|setDoc|addDoc|updateDoc|deleteDoc/i);
    expect(SRC).not.toMatch(/\.innerHTML\s*=\s*[^;]*\+\s*(r|e|resp|data)\./);
  });
});
