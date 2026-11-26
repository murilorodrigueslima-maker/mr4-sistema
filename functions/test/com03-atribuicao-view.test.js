'use strict';
// COM-03 — view-model puro da revisão de atribuição (indicadores separados), tela e correção de data da Fila.
const fs = require('fs'), path = require('path');
const V = require('../../modulos/crm-atribuicao-view');
const ler = f => fs.readFileSync(path.join(__dirname, '../../', f), 'utf8');

let n = 0;
const caso = (ex = {}) => {
  n++;
  const { pedido, sistema, ...resto } = ex;
  return { vendaId: String(7000 + n), opportunityInstanceId: 'opp' + n, clienteGcId: 'c' + n, cliente: 'Cliente Fictício ' + n, precisaRevisao: false, prioridade: null, revisao: null,
    contato: { por: 'Vendedor Um' }, pedido: { concluido: true, valor: 100, ...pedido }, sistema: { nivel: 'PROVAVEL', motivo: 'SEM_INTENCAO_REGISTRADA', sinais: [], ...sistema }, ...resto };
};
const decisao = (c, d, ex = {}) => ({ ...c, revisao: { decisao: d, opportunityInstanceId: c.opportunityInstanceId, revisao: 1, ...ex } });

describe('situação do pedido', () => {
  test('"comprovada" só nasce de decisão humana — nem a regra com evidência declarada conta como comprovada', () => {
    const ev = caso({ precisaRevisao: true, sistema: { nivel: 'ATRIBUIDA_COM_EVIDENCIA' } });
    expect(V.situacao(ev)).toEqual({ codigo: 'AGUARDANDO', origem: null });
    expect(V.situacao(decisao(ev, 'COMPROVADA'))).toEqual({ codigo: 'COMPROVADA', origem: 'GESTOR' });
  });
  test('provável sem conflito vem da regra; ambíguo fica aguardando mesmo que a regra sugira provável ou não atribuível', () => {
    expect(V.situacao(caso())).toEqual({ codigo: 'PROVAVEL', origem: 'REGRA' });
    for (const nivel of ['PROVAVEL', 'NAO_ATRIBUIVEL']) expect(V.situacao(caso({ precisaRevisao: true, sistema: { nivel } })).codigo).toBe('AGUARDANDO');
  });
  test('"não atribuída" só por decisão; pedido não concluído não conta mesmo decidido', () => {
    const a = caso({ precisaRevisao: true, sistema: { nivel: 'NAO_ATRIBUIVEL' } });
    expect(V.situacao(decisao(a, 'NAO_ATRIBUIDA'))).toEqual({ codigo: 'NAO_ATRIBUIDA', origem: 'GESTOR' });
    expect(V.situacao(decisao(caso({ pedido: { concluido: false, valor: 10 } }), 'COMPROVADA')).codigo).toBe('FORA');
  });
  test('decisão tomada para outra oportunidade não vale: volta para a fila', () => {
    const c = decisao(caso(), 'COMPROVADA', { opportunityInstanceId: 'outra' });
    expect(V.desatualizada(c)).toBe(true); expect(V.pendente(c)).toBe(true); expect(V.situacao(c).codigo).toBe('AGUARDANDO');
  });
});

describe('indicadores separados', () => {
  const comp = decisao(caso({ precisaRevisao: true, pedido: { concluido: true, valor: 50.1 } }), 'COMPROVADA');
  const compOutro = caso({ opportunityInstanceId: comp.opportunityInstanceId, clienteGcId: comp.clienteGcId, precisaRevisao: true, pedido: { concluido: true, valor: 30 } });   // recompra pendente da MESMA oportunidade
  const prov = caso({ pedido: { concluido: true, valor: 0.2 } });
  const pend = caso({ precisaRevisao: true, sistema: { nivel: 'NAO_ATRIBUIVEL' } });
  const nao = decisao(caso({ precisaRevisao: true }), 'NAO_ATRIBUIDA');
  const fora = caso({ precisaRevisao: true, pedido: { concluido: false, valor: 999 } });
  const foraDaBase = decisao(caso({ precisaRevisao: true, pedido: { concluido: true, valor: 70 } }), 'COMPROVADA');   // janela ainda aberta
  const casos = [comp, compOutro, prov, pend, nao, fora, foraDaBase];
  const base = [comp, prov, pend, nao, fora].map(c => c.opportunityInstanceId).concat(['sem-pedido-1', 'sem-pedido-2', 'sem-pedido-3']);
  const r = V.indicadores(casos, base);

  test('oportunidades: partição excludente do mesmo denominador (soma = base)', () => {
    expect(r.base).toBe(8);
    const p = r.porSituacao;
    expect([p.COMPROVADA.oportunidades, p.PROVAVEL.oportunidades, p.AGUARDANDO.oportunidades, p.NAO_ATRIBUIDA.oportunidades, r.semPedido]).toEqual([1, 1, 1, 1, 4]);
    expect(p.COMPROVADA.oportunidades + p.PROVAVEL.oportunidades + p.AGUARDANDO.oportunidades + p.NAO_ATRIBUIDA.oportunidades + r.semPedido).toBe(r.base);
    expect(p.COMPROVADA.taxa).toBeCloseTo(1 / 8);
  });
  test('pedidos, clientes e valores por situação, em centavos exatos; não concluído fora', () => {
    const p = r.porSituacao;
    expect(p.COMPROVADA).toMatchObject({ pedidos: 2, valor: 120.1, clientes: 2, peloGestor: 2 });
    expect(p.PROVAVEL).toMatchObject({ pedidos: 1, valor: 0.2, pelaRegra: 1, peloGestor: 0 });
    expect(p.AGUARDANDO).toMatchObject({ pedidos: 2 }); expect(p.NAO_ATRIBUIDA).toMatchObject({ pedidos: 1 });
    expect(r.foraDosIndicadores).toBe(1); expect(r.provisorio).toBe(true);
    expect(r.aguardando).toBe(3);   // inclui o não concluído, que ainda pode ser avaliado
    expect(r.decididos).toBe(3);
  });
  test('sem base: taxa ausente (nunca 0%); sem pendências deixa de ser provisório', () => {
    const v = V.indicadores([comp], []);
    expect(v.porSituacao.COMPROVADA.taxa).toBeNull(); expect(V.percentual(null)).toBe('—'); expect(v.provisorio).toBe(false);
  });
  test('filtros e validação da decisão', () => {
    expect(V.filtrar(casos, { fila: 'pendentes' })).toEqual([compOutro, pend, fora]);
    expect(V.filtrar(casos, { fila: 'decididos' })).toHaveLength(3);
    expect(V.filtrar(casos, { fila: 'todos', busca: prov.vendaId })).toEqual([prov]);
    expect(V.validarDecisao({ decisao: 'COMPROVADA', observacao: '  ' }).ok).toBe(false);
    expect(V.validarDecisao({ decisao: 'SIM', observacao: 'conferido' }).ok).toBe(false);
    expect(V.validarDecisao({ decisao: 'PROVAVEL', observacao: ' conferido ' })).toMatchObject({ ok: true, texto: 'conferido' });
    expect(V.validarDecisao({ decisao: 'PROVAVEL', observacao: 'x'.repeat(501) }).ok).toBe(false);
  });
});

describe('tela e empacotamento', () => {
  const h = ler('modulos/crm-atribuicao.html');
  test('só o callable grava; acesso restrito à gestão; textos escapados; sem a taxa do último toque', () => {
    expect(h).not.toMatch(/setDoc|updateDoc|addDoc|deleteDoc|writeBatch|localStorage|sessionStorage/);
    expect(h).toContain("'crmAtribuicaoRevisao'"); expect(h).toMatch(/role === 'gestor' \|\| \(ss\.data\(\)\.modulos \|\| \[\]\)\.includes\('fila-comercial-gestao'\)/);
    expect(h).toMatch(/const esc =/);
    expect(h + ler('modulos/crm-atribuicao-view.js')).not.toMatch(/34[,.]6/);
    expect(h).toContain('não alteram comissão, meta nem carteira');
  });
  test('a gestão tem o atalho; o pacote do Hosting inclui os dois arquivos', () => {
    expect(ler('modulos/crm-gestao.html')).toContain('href="crm-atribuicao.html"');
    const { PERMITIDOS, PROIBIDOS_NOME } = require('../../scripts/hosting/empacotar');
    for (const f of ['modulos/crm-atribuicao.html', 'modulos/crm-atribuicao-view.js']) expect(PERMITIDOS.some(r => r.test(f)) && !PROIBIDOS_NOME.test(f)).toBe(true);
  });
  test('Fila: "hoje" do retorno é o dia comercial (não UTC), como no servidor', () => {
    const f = ler('modulos/fila-comercial.html');
    expect(f).toContain('if (scheduledFor <= hojeComercial())');
    expect(f).not.toMatch(/const hoje = new Date\(\)\.toISOString\(\)\.slice\(0, 10\);/);
    const W = require('../../modulos/fila-worklist-view');
    expect(W.dataComercial(new Date('2026-11-27T01:30:00.000Z'))).toBe('2026-11-26');   // 22:30 em Fortaleza: amanhã (27) é aceito
  });
});
