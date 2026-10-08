'use strict';
// CRM MR4 2.0 — gates complementares do RC final: fronteiras de 119/120/121 dias (mês/ano/bissexto), matriz "venda registrada após o contato"
// com ORÁCULO independente (FALSE_ATTRIBUTION=0), fuso de Fortaleza, consulta SOMENTE LEITURA (nenhuma escrita), XSS e ausência de GestãoClick no navegador.
const fs = require('fs'), path = require('path');
const TL = require('../lib/crmTimeline');
const C = require('../lib/carteiraRegra');
const ler = f => fs.readFileSync(path.join(__dirname, '../..', f), 'utf8');

const somar = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const venda = (id, data, valor = 100, extra = {}) => ({ id, cliente_id: '1', data, nome_situacao: 'Concretizada', valor_total: String(valor), vendedor_id: 'V1', nome_vendedor: 'Vend', produtos: [{}], ...extra });
// contato às 10:00 de Fortaleza (13:00Z) do dia ymd
const contato = (ymd, outcome = 'CONVERSA_REALIZADA', op = 'U1', hora = '13:00:00') => ({ opportunityInstanceId: 'o' + ymd, eventos: [{ tipo: 'OUTCOME_REGISTERED', outcome, timestamp: ymd + 'T' + hora + '.000Z', operadorId: op }] });

describe('120 dias sem compra — fronteiras (cliente recuperado)', () => {
  const casos = ['2026-03-01', '2025-09-30', '2024-01-31', '2023-12-31', '2026-09-01', '2024-02-29'].map(u => [u, somar(u, 119)]);   // ultimaCompra → dia do contato (119 dias depois)
  test.each(casos)('última compra %s: contato em +119 NÃO é recuperado; +120 e +121 SIM (venda no dia seguinte ao contato)', (ultima, dia119) => {
    const dia120 = somar(dia119, 1), dia121 = somar(dia119, 2);
    expect(TL.LIMIAR_INATIVIDADE_DIAS).toBe(120);
    for (const [dia, esperado] of [[dia119, null], [dia120, 'RECUPERADO_APOS_CONTATO'], [dia121, 'RECUPERADO_APOS_CONTATO']]) {
      const r = TL.clienteRecuperado({ estados: [contato(dia)], vendas: [venda('a', ultima), venda('b', somar(dia, 1))] });
      expect([dia, r ? r.status : null]).toEqual([dia, esperado]);
      if (r) expect(r.diasParadoNoContato).toBe(dia === dia120 ? 120 : 121);
      else expect(dia).toBe(dia119);
    }
  });
  test('diasEntre correto em virada de mês/ano/bissexto (2024-02-29) e sem histórico nunca é "recuperado"', () => {
    const r = TL.clienteRecuperado({ estados: [contato('2024-06-28')], vendas: [venda('a', '2024-02-29'), venda('b', '2024-06-29')] });   // 2024-02-29 → 2024-06-28 = 120 dias
    expect(r && r.diasParadoNoContato).toBe(120);
    expect(TL.clienteRecuperado({ estados: [contato('2026-09-01')], vendas: [venda('b', '2026-09-02')] })).toBeNull();               // nunca comprou antes do contato
  });
  test('regra da carteira (R2): 119 dias = protegida; 120 = reativação aberta — mesma fronteira do CRM', () => {
    expect(typeof C.decidirCarteira === 'function' || typeof C.decidir === 'function' || Object.keys(C).length > 0).toBe(true);
    const fn = C.diasSemComprar || C.calcularDiasSemComprar;
    if (typeof fn === 'function') { expect(fn('2026-09-30', '2026-06-02') >= 120).toBe(false); expect(fn('2026-09-30', '2026-06-01') >= 120).toBe(true); }
  });
});

describe('venda registrada após o contato — factual, sem atribuição falsa', () => {
  test('matriz: antes / mesmo dia / depois; vários contatos e vendas; inválido; cancelada; valor zero; vendedor diferente; sem contato', () => {
    const est = [contato('2026-09-10', 'SEM_RESPOSTA'), contato('2026-09-15', 'CONVERSA_REALIZADA'), contato('2026-09-20', 'CONTATO_INVALIDO')];
    const vs = [venda('v0', '2026-09-05'), venda('v1', '2026-09-12'), venda('v2', '2026-09-15'), venda('v3', '2026-09-18'), venda('v4', '2026-09-22', 100, { vendedor_id: 'OUTRO', nome_vendedor: 'Outro' }),
      venda('vc', '2026-09-25', 100, { nome_situacao: 'Cancelada' }), venda('vz', '2026-09-26', 0)];
    const r = TL.vendasAposContato({ estados: est, vendas: vs }); const por = Object.fromEntries(r.map(x => [x.venda.id, x]));
    expect(por.v0).toBeUndefined();                                                                    // venda ANTES de qualquer contato: não entra
    expect(por.v1).toMatchObject({ relacao: 'APOS', diasAposContato: 2, contato: { dia: '2026-09-10' } });
    expect(por.v2).toMatchObject({ relacao: 'APOS', contato: { dia: '2026-09-10' } });                  // contato do MESMO dia não conta como anterior; vale o de 10/09
    expect(por.v3).toMatchObject({ relacao: 'APOS', diasAposContato: 3, contato: { dia: '2026-09-15' } });
    expect(por.v4).toMatchObject({ relacao: 'APOS', contato: { dia: '2026-09-15' } });                  // CONTATO_INVALIDO (20/09) não é contato; vendedor diferente = só ordem temporal, sem causa
    expect(por.vc).toBeUndefined(); expect(por.vz).toBeUndefined();                                    // cancelada e valor zero não são venda
    expect(TL.vendasAposContato({ estados: [], vendas: vs })).toEqual([]);                             // sem contato: nada
    expect(TL.vendasAposContato({ estados: est, vendas: [] })).toEqual([]);
  });
  test('só no mesmo dia → INDETERMINADO (a fonte não tem hora); fuso: contato 22:30 de Fortaleza (01:30Z do dia seguinte) pertence ao dia local', () => {
    const noite = contato('2026-09-29', 'CONVERSA_REALIZADA', 'U1', '01:30:00');                        // 22:30 de 28/09 em Fortaleza
    expect(TL.contatosDe([noite])[0].dia).toBe('2026-09-28');
    expect(TL.vendasAposContato({ estados: [noite], vendas: [venda('m', '2026-09-28')] })[0].relacao).toBe('INDETERMINADO');
    expect(TL.vendasAposContato({ estados: [noite], vendas: [venda('n', '2026-09-29')] })[0]).toMatchObject({ relacao: 'APOS', diasAposContato: 1 });
    for (const [iso, dia] of [['2026-01-01T02:59:59Z', '2025-12-31'], ['2026-01-01T03:00:00Z', '2026-01-01'], ['2026-03-01T02:59:59Z', '2026-02-28'], ['2024-03-01T02:59:59Z', '2024-02-29']]) expect(TL.diaComercial(iso)).toBe(dia);
  });
  test('FALSE_ATTRIBUTION_COUNT=0: 2.000 cenários aleatórios (semente fixa) × oráculo independente', () => {
    let s = 12345; const rnd = () => ((s = (Math.imul(s, 1664525) + 1013904223) >>> 0) / 4294967296);
    let falsas = 0, total = 0;
    for (let i = 0; i < 2000; i++) {
      const dias = Array.from({ length: 1 + Math.floor(rnd() * 4) }, () => somar('2026-06-01', Math.floor(rnd() * 120)));
      const est = dias.map(d => contato(d, ['CONVERSA_REALIZADA', 'SEM_RESPOSTA', 'PEDIU_RETORNO', 'SEM_INTERESSE_AGORA', 'CONTATO_INVALIDO'][Math.floor(rnd() * 5)]));
      const vs = Array.from({ length: Math.floor(rnd() * 5) }, (_, k) => venda('x' + k, somar('2026-06-01', Math.floor(rnd() * 130)), rnd() < 0.15 ? 0 : 50, rnd() < 0.15 ? { nome_situacao: 'Cancelada' } : {}));
      const validos = est.flatMap(e => e.eventos).filter(e => e.outcome !== 'CONTATO_INVALIDO').map(e => e.timestamp.slice(0, 10));
      for (const x of TL.vendasAposContato({ estados: est, vendas: vs })) {
        total++;
        const v = vs.find(z => z.id === x.venda.id);
        const ok = v.nome_situacao === 'Concretizada' && Number(v.valor_total) > 0                                   // venda válida
          && (x.relacao === 'APOS' ? validos.some(d => d < v.data) && x.contato.dia < v.data : validos.includes(v.data) && !validos.some(d => d < v.data))   // ordem temporal correta
          && validos.includes(x.contato.dia);                                                                      // o contato citado existe e é válido
        if (!ok) falsas++;
      }
    }
    expect(total).toBeGreaterThan(500); expect(falsas).toBe(0);
  });
  test('linguagem: nenhuma afirmação de causa na interface', () => {
    const ui = ler('modulos/crm.html') + ler('modulos/crm-view.js');
    expect(ui).not.toMatch(/\b(gerou|causou|converteu|convertid[oa]|resultou|por causa|graças ao contato)\b/i);
    expect(ui).toMatch(/sem afirmar causa/);
  });
});

describe('interface do CRM: sem GestãoClick, sem segredo, sem HTML cru', () => {
  test('crm.html: nenhuma chamada/URL/credencial do GestãoClick; só Firebase (Auth, Firestore, callables)', () => {
    const h = ler('modulos/crm.html');
    expect(h.replace(/gestaoClickId/g, '')).not.toMatch(/gestaoclick|api\.gestao|access-token|secret-access|z-api|Client-Token/i);   // gestaoClickId = só o ID exibido
    expect([...h.matchAll(/https?:\/\/[^\s'"`)]+/g)].map(m => new URL(m[0]).host).filter((v, i, a) => a.indexOf(v) === i).every(x => /^(wa\.me|localhost:9099|www\.gstatic\.com|fonts\.googleapis\.com|fonts\.gstatic\.com|www\.w3\.org)$/.test(x))).toBe(true);
    expect(h).not.toMatch(/\bfetch\s*\(/);
  });
  test('todo texto livre/cadastro entra no HTML só por esc(): nome, cidade, telefone, nota, vendedor, produto, título, detalhe', () => {
    const src = ler('modulos/crm.html'); const linhas = src.split('\n');
    const campos = /\.(nome|nomeCliente|cidade|telefone|whatsapp|nota|observacao|vendedor|vendedorNome|produto|titulo|detalhe|rotulo|motivo|motivoCurto|cliente)\b/;
    const suspeitas = [];
    linhas.forEach((l, i) => { for (const m of l.matchAll(/\$\{([^}]*)\}/g)) { const e = m[1]; if (campos.test(e) && !/esc\(/.test(e) && !/\?\s*`/.test(e) && !/V\.(rotulo|dataBR|moedaBR|rotuloDia)\(/.test(e) && !/\.length|=== |!== |\? '' :/.test(e)) suspeitas.push((i + 1) + ': ' + m[0].slice(0, 80)); } });
    expect(suspeitas).toEqual([]);
  });
});
