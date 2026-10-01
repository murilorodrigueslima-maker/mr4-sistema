'use strict';
// FINANCEIRO Fase 2 · frontend: modelo de cards, frescor, filtros, paginação sob demanda, XSS, ausência de saldo/capacidade/% falso, sem ERP no navegador.
const fs = require('fs'), path = require('path');
const V = require('../../modulos/financeiro-view.js');
const A = require('../lib/financeiro/agregados');
const C = require('../lib/financeiro/canonico');
const { FORMAS, titulo, receber } = require('./fixtures/financeiro-f1');
const { massa } = require('./fixtures/financeiro-f2');
const HOJE = '2026-09-28', AGORA = new Date('2026-09-28T15:00:00Z');
const refs = { formasPorId: FORMAS };
const canonDe = (ps, rs) => [...ps.map(b => C.mapearTitulo(b, 'PAGAR', refs)), ...rs.map(b => C.mapearTitulo(b, 'RECEBER', refs))];
const m = massa({ hoje: HOJE, nPagar: 900, nReceber: 2400 });
const g = A.construirGeracao({ canon: canonDe(m.pagamentos, m.recebimentos), agora: AGORA, geracao: 'gV', hoje: HOJE });
const HTML = fs.readFileSync(path.join(__dirname, '../../modulos/financeiro-v2.html'), 'utf8');
const VIEW = fs.readFileSync(path.join(__dirname, '../../modulos/financeiro-view.js'), 'utf8');

describe('dashboard', () => {
  test('cards principais (7) e secundários (2); fluxo programado rotulado; nenhum saldo/caixa/capacidade', () => {
    const c = V.modeloCards(g.resumo);
    expect(c.principais.map(x => x.id)).toEqual(['pagar_hoje', 'receber_hoje', 'pagar_7d', 'receber_7d', 'pagar_vencido', 'receber_vencido', 'conferencia']);
    expect(c.secundarios.map(x => x.id)).toEqual(['fluxo_7d', 'fluxo_30d']); expect(c.secundarios[0].titulo).toMatch(/^Fluxo programado/); expect(c.definicaoFluxo).toMatch(/NÃO é saldo bancário nem caixa/);
    const txt = JSON.stringify(c) + HTML + VIEW;
    expect(txt).not.toMatch(/Saldo em caixa|Saldo dispon[ií]vel|Dinheiro dispon[ií]vel|Caixa dispon[ií]vel|Capacidade de compra|dispon[ií]vel para compras/i);
    expect(txt).not.toMatch(/inadimpl[êe]ncia\s*[:=]?\s*\d|%\s*de inadimpl|taxa de inadimpl/i);
  });
  test('valores dos cards = agregados da geração; vencido > 0 vira alerta; conferência > 0 vira atenção; zero não é alerta', () => {
    const c = V.modeloCards(g.resumo).principais; const por = Object.fromEntries(c.map(x => [x.id, x]));
    expect(por.pagar_vencido.valor).toBe(V.brl(g.resumo.pagar.vencido.c)); expect(por.receber_7d.n).toBe(g.resumo.receber.prox_7d.n);
    expect(por.pagar_vencido.tom).toBe('alerta');
    const vazio = A.construirGeracao({ canon: [], agora: AGORA, geracao: 'gE', hoje: HOJE }); const cv = V.modeloCards(vazio.resumo).principais;
    expect(cv.every(x => x.tom === 'neutro')).toBe(true); expect(cv[0].valor).toBe('R$ 0,00');
  });
  test('envelhecimento: 8 linhas, ">365" destacada, somam o vencido', () => {
    const l = V.linhasEnvelhecimento(g.resumo.pagar); expect(l).toHaveLength(8); expect(l[7]).toMatchObject({ id: 'ACIMA_365', destaque: true, rotulo: 'Mais de 365 dias' });
    expect(l.reduce((a, x) => a + x.c, 0)).toBe(g.resumo.pagar.vencido.c);
  });
  test('formatação monetária e datas em pt-BR; fuso de Fortaleza', () => {
    expect(V.brl(123456789)).toBe('R$ 1.234.567,89'); expect(V.brl(5)).toBe('R$ 0,05'); expect(V.brl(-250)).toBe('−R$ 2,50'); expect(V.brl(null)).toBe('—');
    expect(V.dataBR('2026-09-05')).toBe('05/09/2026'); expect(V.dataHoraBR('2026-10-01T02:59:00Z')).toBe('30/09/2026 23:59'); expect(V.dataHoraBR('2026-10-01T03:00:00Z')).toBe('01/10/2026 00:00');
    expect(V.dataComercial(new Date('2027-01-01T02:59:59Z'))).toBe('2026-12-31');
  });
});

describe('frescor (stale)', () => {
  test('CURRENT ≤ 6 h; STALE > 6 h com aviso explícito; UNAVAILABLE sem dado — nunca mostra antigo como atual', () => {
    const pub = '2026-09-28T12:00:00Z';
    expect(V.frescor(pub, Date.parse('2026-09-28T15:00:00Z'))).toMatchObject({ estado: 'CURRENT', idadeMin: 180 }); expect(V.frescor(pub, Date.parse('2026-09-28T18:00:00Z')).estado).toBe('CURRENT');
    const s = V.frescor(pub, Date.parse('2026-09-28T18:01:00Z')); expect(s.estado).toBe('STALE'); expect(s.texto).toMatch(/Dados desatualizados/);
    expect(V.frescor(null, Date.now()).estado).toBe('UNAVAILABLE'); expect(V.frescor('lixo', Date.now()).estado).toBe('UNAVAILABLE');
    expect(V.STALE_HORAS).toBe(require('../lib/financeiro/entrypoints').AGENDA.STALE_HORAS);
  });
});

describe('listas: filtros e paginação (nunca a base inteira)', () => {
  const porId = Object.fromEntries(g.fatias.map(f => [f.id, f.doc]));
  const carregaTudo = (nat, filtro, limite = 1000) => { const est = V.novaLista('gV', nat, filtro, g.resumo, HOJE); const lidas = []; let f; while ((f = V.proximaFatia(est)) && lidas.length < limite) { lidas.push(f.id); V.aplicarFatia(est, porId[f.id]); } return { est, lidas }; };
  test('"Vencidas" lê só fatias do grupo VENCIDO, em ordem, uma por vez; primeira página = 1 leitura', () => {
    const est = V.novaLista('gV', 'RECEBER', 'vencidas', g.resumo, HOJE); const f1 = V.proximaFatia(est);
    expect(f1.id).toBe('gV__RECEBER__VENCIDO__000'); V.aplicarFatia(est, porId[f1.id]); expect(est.itens.length).toBeLessThanOrEqual(250); expect(est.lidas).toBe(1);
    const { est: e2, lidas } = carregaTudo('RECEBER', 'vencidas'); expect(lidas.every(i => i.includes('__VENCIDO__'))).toBe(true); expect(e2.itens).toHaveLength(g.resumo.receber.vencido.n);
  });
  test('"Próximos 7 dias" = HOJE + FUTURO até hoje+7, para cedo (não lê todos os futuros) e bate com o card', () => {
    const { est, lidas } = carregaTudo('PAGAR', 'd7'); expect(est.itens.every(i => i.v >= HOJE && i.v <= V.somarDias(HOJE, 7))).toBe(true);
    expect(est.itens).toHaveLength(g.resumo.pagar.prox_7d.n); expect(est.itens.reduce((a, i) => a + i.val, 0)).toBe(g.resumo.pagar.prox_7d.c);
    const totalFuturo = g.resumo.pagar.detalhe.FUTURO.fatias + g.resumo.pagar.detalhe.HOJE.fatias; expect(lidas.length).toBeLessThanOrEqual(totalFuturo);
  });
  test('REGRESSÃO (achada em produção): "Próximos 7/30 dias" com poucos títulos hoje não pode parar no 1º grupo — a lista carrega fatias até ter itens suficientes (ou acabar) e mostra TODOS os títulos do card', () => {
    const lista = (nat, filtro) => { const est = V.novaLista('gV', nat, filtro, g.resumo, HOJE); let n = 0; do { const f = V.proximaFatia(est); if (!f) break; V.aplicarFatia(est, porId[f.id]); n++; } while (V.precisaMais(est, 50)); return { est, n }; };
    const ps = [...Array(3).fill(0).map((_, i) => titulo({ id: 'h' + i, data_vencimento: HOJE, valor: '10.00', valor_total: '10.00' })), ...Array(20).fill(0).map((_, i) => titulo({ id: 'f' + i, data_vencimento: C.somarDias(HOJE, 1 + (i % 6)), valor: '5.00', valor_total: '5.00' })), ...Array(10).fill(0).map((_, i) => titulo({ id: 'l' + i, data_vencimento: C.somarDias(HOJE, 20 + i), valor: '1.00', valor_total: '1.00' }))];
    const mini = A.construirGeracao({ canon: canonDe(ps, []), agora: AGORA, geracao: 'gM', hoje: HOJE, tamFatia: 5 }); const pm = Object.fromEntries(mini.fatias.map(f => [f.id, f.doc]));
    const est = V.novaLista('gM', 'PAGAR', 'd7', mini.resumo, HOJE); let n = 0; do { const f = V.proximaFatia(est); if (!f) break; V.aplicarFatia(est, pm[f.id]); n++; } while (V.precisaMais(est, 50));
    expect(est.itens).toHaveLength(23); expect(est.itens).toHaveLength(mini.resumo.pagar.prox_7d.n); expect(n).toBeGreaterThanOrEqual(2); expect(est.itens.every(i => i.v <= C.somarDias(HOJE, 7))).toBe(true);   // HOJE (3) + FUTURO até 7 dias (20); os 10 mais distantes ficam de fora
    // sem a regra (parar no 1º grupo) só apareceriam os 3 de hoje
    const so1 = V.novaLista('gM', 'PAGAR', 'd7', mini.resumo, HOJE); V.aplicarFatia(so1, pm[V.proximaFatia(so1).id]); expect(so1.itens.length).toBeLessThan(23);
    const d30 = lista('RECEBER', 'd30'); expect(d30.est.itens.reduce((a, i) => a + i.val, 0)).toBe(g.resumo.receber.prox_30d.c);
    expect(V.precisaMais({ fim: true, itens: [] }, 50)).toBe(false); expect(V.precisaMais({ fim: false, itens: new Array(50) }, 50)).toBe(false); expect(V.precisaMais({ fim: false, itens: new Array(3) }, 50)).toBe(true);
    expect(HTML).toMatch(/V\.precisaMais\(/);
  });
  test('"Próximos 30 dias" bate com o card; "Requer conferência" bate com a contagem; "Pagas" é paginado por fatias recentes primeiro', () => {
    const a = carregaTudo('RECEBER', 'd30').est; expect(a.itens.reduce((x, i) => x + i.val, 0)).toBe(g.resumo.receber.prox_30d.c);
    const u = carregaTudo('PAGAR', 'conferencia').est; expect(u.itens).toHaveLength(g.resumo.pagar.requer_conferencia.n);
    const est = V.novaLista('gV', 'RECEBER', 'pagas', g.resumo, HOJE); V.aplicarFatia(est, porId[V.proximaFatia(est).id]);
    expect(est.itens.length).toBeLessThanOrEqual(250); expect(est.fim).toBe(g.resumo.receber.detalhe.PAGO.fatias <= 1);
  });
  test('primeira página de qualquer lista = 1 documento; dashboard = 2 documentos (ponteiro + resumo); tamanho do resumo pequeno', () => {
    for (const nat of ['PAGAR', 'RECEBER']) for (const f of Object.keys(V.FILTROS)) { const est = V.novaLista('gV', nat, f, g.resumo, HOJE); if (V.proximaFatia(est)) { const x = V.proximaFatia(est); expect(typeof x.id).toBe('string'); } }
    expect(Buffer.byteLength(JSON.stringify(g.resumo))).toBeLessThan(100000);
    expect(HTML).not.toMatch(/\.where\(|collection\(db|getDocs\(/);                      // a página só lê documentos por id (ponteiro, resumo, entidades, fatias)
  });
  test('lista vazia / filtro sem títulos não quebra', () => {
    const vazio = A.construirGeracao({ canon: [], agora: AGORA, geracao: 'gE', hoje: HOJE }); const est = V.novaLista('gE', 'PAGAR', 'vencidas', vazio.resumo, HOJE);
    expect(V.proximaFatia(est)).toBeNull(); expect(est.itens).toEqual([]);
  });
  test('geração do ponteiro ≠ geração do resumo → falha fechada (erro, não números)', () => {
    expect(V.validarGeracao({ geracao: 'a', resumo_id: 'a__resumo' }, g.resumo).ok).toBe(false); expect(V.validarGeracao(null, g.resumo).ok).toBe(false); expect(V.validarGeracao({ geracao: 'gV', resumo_id: 'x' }, g.resumo).ok).toBe(true);
    expect(V.validarGeracao({ geracao: 'gV', resumo_id: 'x' }, { geracao: 'gV' }).motivo).toBe('RESUMO_INCOMPLETO');
  });
});

describe('linhas: texto factual, requer conferência, vínculo, ambiguidade, >365', () => {
  test('modelo de linha por situação', () => {
    const base = { id: 'x', cod: '1', v: '2026-01-01', desc: 'Compra de nº 10', ent: 'Fornecedor Fictício', et: 'FORNECEDOR', val: 12345, pl: null, fp: 'Boleto Inter/Pix', amb: true };
    const venc = V.modeloLinha({ ...base, _g: 'VENCIDO', ag: 'ACIMA_365', lk: { t: 'COMPRA', cod: '10', regra: 'SAFE_DETERMINISTIC_TEXT_LINK' } }, 'PAGAR');
    expect(venc).toMatchObject({ status: 'Vencido', tom: 'alerta', plano: 'Sem classificação', faixa: 'Mais de 365 dias', acimaDeUmAno: true, vinculo: 'Compra nº 10', valor: 'R$ 123,45', forma: 'Boleto Inter/Pix', ambigua: true });
    expect(V.modeloLinha({ ...base, _g: 'UNKNOWN', mot: 'ABERTO_COM_DATA_LIQUIDACAO', motx: 'Status aberto, mas existe data de liquidação', sd: '2026-01-02' }, 'PAGAR')).toMatchObject({ status: 'Requer conferência', conferencia: 'Status aberto, mas existe data de liquidação' });
    expect(V.modeloLinha({ ...base, _g: 'PAGO', sd: '2026-02-03' }, 'RECEBER')).toMatchObject({ status: 'Recebido', pagoEm: '03/02/2026' }); expect(V.modeloLinha({ ...base, _g: 'PAGO', sd: '2026-02-03' }, 'PAGAR').status).toBe('Pago');
    expect(V.modeloLinha({ ...base, _g: 'FUTURO', lk: { t: 'AMBIGUO' } }, 'PAGAR')).toMatchObject({ vinculo: 'Vínculo ambíguo', vinculoAmbiguo: true });
  });
  test('rótulos: filtro "Pagas" vira "Recebidas" em receber; "Hoje"/"7"/"30"/"Requer conferência" presentes', () => {
    expect(V.rotuloFiltro('pagas', 'RECEBER')).toBe('Recebidas'); expect(V.rotuloFiltro('pagas', 'PAGAR')).toBe('Pagas'); expect(Object.keys(V.FILTROS)).toEqual(['vencidas', 'hoje', 'd7', 'd30', 'conferencia', 'pagas']);
  });
  test('"Boleto Inter/Pix" permanece na tabela de formas como ambíguo, nunca PIX', () => {
    const l = V.linhasFormas(g.resumo.receber); const amb = l.find(x => x.forma === 'Boleto Inter/Pix'); expect(amb && amb.ambigua).toBe(true); expect(l.filter(x => x.forma === 'PIX').every(x => !x.ambigua)).toBe(true);
  });
});

describe('XSS e privacidade da página', () => {
  const PAYLOADS = ['<script>alert(1)</script>', '<img src=x onerror=alert(1)>', '"><svg onload=alert(1)>', "'\"><b onmouseover=alert(1)>"];
  test.each(PAYLOADS)('esc() neutraliza %s', p => { const e = V.esc(p); expect(e).not.toMatch(/[<>"]/); expect(e).not.toMatch(/<\w/); });
  test('todo campo vindo do ERP é impresso por esc(): fornecedor, cliente, descrição, plano, forma, motivo, vínculo', () => {
    const campos = ['m.contraparte', 'm.descricao', 'm.plano', 'm.forma', 'm.conferencia', 'm.vinculo', 'm.vencimento', 'm.valor', 'm.status', 'm.faixa', 'e.nome', 'l.forma', 'l.nome', 'l.rotulo'];
    const interp = [...HTML.matchAll(/\$\{([^}]+)\}/g)].map(x => x[1]);
    for (const c of campos) for (const i of interp.filter(x => x.includes(c))) expect([c, /esc\(|V\.brl\(|tag\(|nc\(|mot\(/.test(i) || /^m\.\w+ \?/.test(i)]).toEqual([c, true]);
    expect(HTML).not.toMatch(/\.innerHTML\s*=\s*[^;]*(est\.itens|S\.resumo|e\.nome)\b(?![^;]*esc)/);
  });
  test('renderização de linha com payloads: nenhum HTML executável sai da lista', () => {
    const it = { id: 'p', v: '2026-01-01', desc: PAYLOADS[0], ent: PAYLOADS[1], et: 'CLIENTE', val: 100, pl: PAYLOADS[2], fp: PAYLOADS[3], _g: 'VENCIDO', motx: PAYLOADS[0] };
    const mm = V.modeloLinha(it, 'RECEBER'); const saida = [mm.contraparte, mm.descricao, mm.plano, mm.forma].map(V.esc).join('|');
    expect(saida).not.toMatch(/<script|<img|<svg|<b /); expect(saida).toMatch(/&lt;script&gt;/);
  });
  test('a página não fala com o ERP, não tem segredo, não escreve e não guarda dado financeiro no navegador', () => {
    expect(HTML + VIEW).not.toMatch(/gestaoclick|access-token|secret-access|api\.gestao|Client-Token|z-api/i);
    expect(HTML).not.toMatch(/\bfetch\s*\(|XMLHttpRequest|\bsetDoc\b|\bupdateDoc\b|\baddDoc\b|\bdeleteDoc\b|writeBatch|runTransaction|localStorage|sessionStorage|indexedDB/);
    const botoes = [...HTML.matchAll(/<button[^>]*>([^<]*)</g)].map(x => x[1].trim()); for (const b of botoes) expect(b).not.toMatch(/^(Pagar|Receber|Dar baixa|Baixar|Editar|Excluir|Alterar vencimento|Criar t[ií]tulo|Novo t[ií]tulo|Salvar)$/i);
  });
  test('o aviso de saldo está na página, sem alerta vermelho permanente', () => {
    expect(HTML).toMatch(/O Financeiro acompanha títulos e compromissos programados\. O saldo bancário real ainda não está integrado\./);
    expect(HTML).toMatch(/class="aviso"/);
  });
});
