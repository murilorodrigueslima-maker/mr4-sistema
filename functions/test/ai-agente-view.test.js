'use strict';
// AGENTE COMERCIAL · interface: modelo de tela, XSS, estados de falha, integração segura no crm.html.
const fs = require('fs'), path = require('path');
const V = require('../../modulos/agente-comercial-view.js');
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/crm.html'), 'utf8'), VIEW = fs.readFileSync(path.join(__dirname, '../../modulos/agente-comercial-view.js'), 'utf8');
const OK = { ok: true, ia: { status: 'OK', modelo: 'm', latenciaMs: 3200 }, answer: 'Priorize <b>Alfa</b>', dataFreshness: 'Dados de hoje', warnings: ['w1'], unavailable: ['telefone'], customers: [{ entidade: 'GC_NATIVE:1', nome: '<img src=x onerror=alert(1)>', prioridade: 'alta', responsavel: null, reasonCodes: [{ code: 'QUEDA_DE_COMPRAS', label: 'Queda nas compras (tendência)' }], evidence: [{ metric: 'variacaoPedidosPct', label: 'Variação de pedidos (%)', value: -75 }, { metric: 'ultimoContatoEm', label: 'Último contato', value: '2026-09-10' }, { metric: 'tendencia', label: 'Tendência', value: 'CAINDO' }] }], fallback: [] };

describe('sugestões e resumo', () => {
  test('sugestões iniciais pedidas (não é caixa vazia) + resumo do dia; perguntas dentro do limite', () => {
    expect(V.SUGESTOES.map(s => s.rotulo)).toEqual(['Quem devo contatar hoje?', 'Clientes em risco', 'Clientes com queda de compras', 'Oportunidades de recompra', 'Resumo da minha carteira', 'Resumo comercial do dia']);
    for (const s of V.SUGESTOES) if (s.pergunta) expect(Array.from(s.pergunta).length).toBeLessThanOrEqual(V.PERGUNTA_MAX); expect(V.SUGESTOES.find(s => s.id === 'dia').modo).toBe('resumo');
  });
  test('cards do resumo vêm das contagens do sistema (6 cards, zero quando ausente)', () => {
    expect(V.cardsResumo({ prioridadeAlta: 2, merecemContato: 7, quedaRelevante: 3, proximosDe120: 2, recompraProvavel: 4, followUpsAtrasados: 1 }).map(c => c.valor)).toEqual([2, 7, 3, 2, 4, 1]); expect(V.cardsResumo(null).every(c => c.valor === 0)).toBe(true);
  });
  test('validação da pergunta: vazia, só espaços, 400 ok, 401 não, controles removidos', () => {
    expect(V.validarPergunta('').ok).toBe(false); expect(V.validarPergunta('   ').ok).toBe(false); expect(V.validarPergunta('a'.repeat(400)).ok).toBe(true); expect(V.validarPergunta('a'.repeat(401)).ok).toBe(false); expect(V.validarPergunta('oi\u0000\n').texto).toBe('oi');
  });
});
describe('resposta, evidências e falhas', () => {
  test('modelo de resposta: motivos em português, evidências formatadas, rodapé de IA', () => {
    const m = V.modeloResposta(OK); expect(m.iaOk).toBe(true); expect(m.clientes[0].motivos).toEqual(['Queda nas compras (tendência)']); expect(m.clientes[0].evidencias).toEqual([{ rotulo: 'Variação de pedidos (%)', valor: '-75%' }, { rotulo: 'Último contato', valor: '10/09/2026' }, { rotulo: 'Tendência', valor: 'Caindo' }]); expect(m.rodape).toMatch(/fatos calculados pelo MR4/); expect(m.mensagem).toBeNull();
  });
  test('IA indisponível: mensagem controlada + lista determinística; CRM continua', () => {
    for (const motivo of ['TIMEOUT', 'PROVEDOR_OCUPADO', 'PROVEDOR_INDISPONIVEL', 'RESPOSTA_INVALIDA', 'IA_NAO_CONFIGURADA']) { const m = V.modeloResposta({ ok: true, ia: { status: 'INDISPONIVEL', motivo }, answer: null, customers: [], fallback: [{ entidade: 'GC_NATIVE:1', nome: 'Cliente', prioridade: 'media', reasonCodes: [{ code: 'PROXIMO_120D', label: 'Perto de 120 dias' }] }] }); expect(m.iaOk).toBe(false); expect(m.mensagem).toMatch(/CRM continua funcionando normalmente/); expect(m.clientes[0]).toMatchObject({ deterministico: true, nome: 'Cliente' }); expect(m.resposta).toBeNull(); }
    expect(V.modeloResposta({ ok: true, ia: { status: 'SEM_DADOS' }, customers: [], fallback: [] }).mensagem).toMatch(/Não encontrei clientes/);
  });
  test('formatação de valores: datas, %, R$ (gestão), enums', () => { expect(V.valorEvidencia('faturamento90d', 1234.5)).toMatch(/^R\$ 1\.234,50$/); expect(V.valorEvidencia('diasSemComprar', 65)).toBe('65'); expect(V.valorEvidencia('situacaoRetorno', 'ATRASADO')).toBe('Atrasado'); expect(V.valorEvidencia('x', null)).toBe('—'); });
});
describe('XSS e integração no CRM', () => {
  test('texto do modelo, nomes e motivos são impressos só por esc()', () => {
    expect(V.esc(OK.customers[0].nome)).not.toMatch(/[<>"]/); expect(V.esc(OK.answer)).toMatch(/&lt;b&gt;/);
    const trecho = HTML.slice(HTML.indexOf('function agRender'), HTML.indexOf('async function agPerguntar')); const interp = [...trecho.matchAll(/\$\{([^}]+)\}/g)].map(x => x[1]);
    for (const i of interp) expect([i, /esc\(|\.map\(|c\.motivos|m\.clientes|e\.rotulo|c\.responsavel \?|m\.avisos|c\.evidencias\.length \?/.test(i)]).toEqual([i, true]);
    expect(trecho).not.toMatch(/innerHTML\s*=\s*m\.(resposta|mensagem)\b/);
  });
  test('o navegador não tem chave, não chama OpenAI e só usa o callable aiAgente; sem ferramentas de escrita na tela', () => {
    expect(HTML + VIEW).not.toMatch(/OPENAI|api\.openai|sk-[A-Za-z0-9]{10}|Bearer/i); expect(HTML).toMatch(/httpsCallable\(funcs, 'aiAgente'\)/);
    const trecho = HTML.slice(HTML.indexOf('// ── Agente Comercial'), HTML.indexOf('// ── Auth + listeners')); expect(trecho).not.toMatch(/fnClaim|fnOutcome|fnRelease|setDoc|updateDoc|whatsapp|z-api|fetch\(/i);
  });
  test('o agente só abre cliente por callable existente (abrirCliente) e a aba existe sem quebrar Hoje/Agenda', () => {
    expect(HTML).toMatch(/id="tabAgente"/); expect(HTML).toMatch(/id="viewAgente" hidden/); expect(HTML).toMatch(/if \(S\.aba === 'agente'\) return;/); expect(HTML).toMatch(/abrirCliente\(b\.dataset\.agCli\)/);
    expect(HTML).toMatch(/agente-comercial-view\.js\?v=\w+/);
  });
});
