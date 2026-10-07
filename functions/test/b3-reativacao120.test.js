'use strict';
// B3 — motor dos 120 dias (PURO): fronteira 119/120, cobertura, reativação, gestão neutra, conflitos, restrições, limites, idempotência, devolução.
const R = require('../lib/reativacao120');
const ADE = 'u-ade', FAB = 'u-fab', GES = 'u-ges';
const mk = (uid, gc, extra = {}) => ({ uid, user: { ativo: true, role: 'funcionario' }, sistema: { bloqueado: false, modulos: ['fila-comercial-operar'], carteiraComercial: { podePossuirCarteira: true, ativoComercialmente: true, gestaoClickVendedorId: gc, pausaTemporaria: false, desligado: false, ...(extra.cc || {}) }, filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10, ...(extra.fc || {}) } } });
const vend = (ex = {}) => R.indexarVendedores([mk(ADE, '111', ex.ade), mk(FAB, '222', ex.fab)]);
const HOJE = '2026-10-07';
const dia = n => R.somarDias(HOJE, -n);
const venda = (id, cli, data, gcVend, extra = {}) => ({ id: String(id), cliente_id: String(cli), data, vendedor_id: String(gcVend), nome_situacao: 'Concretizada', valor_total: '100', ...extra });
const cart = (gc, owner, ex = {}) => ({ ownerUid: owner, status: 'ATIVA', conflito: null, cicloAncoraEm: null, ...ex });
const mapa = (...pares) => new Map(pares);

describe('B3 — fronteira dos 120 dias', () => {
  const v = vend();
  const estado = (diasDesde, owner = ADE, vendedorGc = '111') => R.cicloDoCliente({ vendasCliente: [venda(1, 10, dia(diasDesde), vendedorGc)], carteira: cart(10, owner), vend: v, hoje: HOJE });
  test('119 dias → continua protegido (não abre reativação)', () => { expect(estado(119)).toMatchObject({ dias: 119, aberta: false }); });
  test('120 dias exatos → exclusividade termina (elegível)', () => { expect(estado(120)).toMatchObject({ dias: 120, aberta: true }); });
  test('121+ dias → elegível', () => { expect(estado(121).aberta).toBe(true); expect(estado(400).aberta).toBe(true); });
  test('planejamento: 119 não libera; 120 e 121 liberam para o OUTRO vendedor; owner NÃO muda', () => {
    for (const [n, esperado] of [[119, 0], [120, 1], [121, 1]]) {
      const p = R.planejarLiberacao({ hoje: HOJE, carteiras: mapa(['GC:10', cart(10, ADE)]), vend: v, vendasPorCliente: mapa(['10', [venda(1, 10, dia(n), '111')]]) });
      expect(p.liberar).toHaveLength(esperado); if (esperado) { expect(p.liberar[0]).toMatchObject({ destinoUid: FAB, ownerUid: ADE, tipo: 'CARTEIRA', ciclo: dia(n) }); expect(p.liberar[0].reservaAte).toBe(R.somarDias(HOJE, 7)); }
    }
  });
  test('destino é sempre o OUTRO: Fabiana owner → oportunidade para Ademir', () => {
    const p = R.planejarLiberacao({ hoje: HOJE, carteiras: mapa(['GC:10', cart(10, FAB)]), vend: v, vendasPorCliente: mapa(['10', [venda(1, 10, dia(150), '222')]]) });
    expect(p.liberar[0]).toMatchObject({ destinoUid: ADE, ownerUid: FAB });
  });
});

describe('B3 — venda da gestão e cobertura', () => {
  const v = vend();
  test('venda da gestão/outros funcionários NÃO renova os 120 dias do vendedor (e segue elegível)', () => {
    const vs = [venda(1, 10, dia(130), '111'), venda(2, 10, dia(10), '999')];                    // 999 = Camila/proprietário (não é vendedor de carteira)
    const c = R.cicloDoCliente({ vendasCliente: vs, carteira: cart(10, ADE), vend: v, hoje: HOJE });
    expect(c).toMatchObject({ aberta: true, dias: 130, ciclo: dia(130) });
  });
  test('decisão: venda de gestão é neutra (sem troca de owner, sem crédito de meta/comissão)', () => {
    const d = R.decidirVendaB3({ venda: venda(2, 10, dia(10), '999'), vendasCliente: [venda(1, 10, dia(130), '111'), venda(2, 10, dia(10), '999')], carteira: cart(10, ADE), vend: v, hoje: HOJE });
    expect(d).toMatchObject({ decisao: 'VENDA_GESTAO_NEUTRA', ownerDepoisUid: ADE, creditoUid: null, renovaCicloDe: null });
    expect(R.decidirVendaB3({ venda: venda(3, 10, dia(5), ''), vendasCliente: [], carteira: null, vend: v, hoje: HOJE }).decisao).toBe('VENDA_GESTAO_NEUTRA');   // sem vendedor também é neutra
  });
  test('venda da gestão em cliente SEM carteira não cria carteira', () => {
    expect(R.decidirVendaB3({ venda: venda(1, 11, dia(2), '999'), vendasCliente: [venda(1, 11, dia(2), '999')], carteira: null, vend: v, hoje: HOJE }).decisao).toBe('VENDA_GESTAO_NEUTRA');
  });
  test('cobertura ANTES de 120 dias: owner não muda, crédito do vendedor que vendeu, ciclo do owner original renova', () => {
    const vs = [venda(1, 10, dia(60), '111'), venda(2, 10, dia(5), '222')];
    const d = R.decidirVendaB3({ venda: vs[1], vendasCliente: vs, carteira: cart(10, ADE), vend: v, hoje: HOJE });
    expect(d).toMatchObject({ decisao: 'COBERTURA_RENOVA_OWNER', ownerDepoisUid: ADE, creditoUid: FAB, renovaCicloDe: ADE });
    const c = R.cicloDoCliente({ vendasCliente: vs, carteira: cart(10, ADE), vend: v, hoje: HOJE }); expect(c).toMatchObject({ dias: 5, aberta: false });     // o ciclo do ADE foi renovado pela cobertura
  });
  test('cobertura com 119 dias de intervalo ainda é cobertura (não é reativação)', () => {
    const vs = [venda(1, 10, dia(119 + 3), '111'), venda(2, 10, dia(3), '222')];
    expect(R.decidirVendaB3({ venda: vs[1], vendasCliente: vs, carteira: cart(10, ADE), vend: v, hoje: HOJE }).decisao).toBe('COBERTURA_RENOVA_OWNER');
  });
  test('pausa temporária do dono protege a carteira (venda do outro vira cobertura, nunca transfere; e não libera reativação)', () => {
    const vp = vend({ ade: { cc: { pausaTemporaria: true, pausaMotivo: 'FERIAS' } } });
    const vs = [venda(1, 10, dia(200), '111'), venda(2, 10, dia(1), '222')];
    expect(R.decidirVendaB3({ venda: vs[1], vendasCliente: vs, carteira: cart(10, ADE), vend: vp, hoje: HOJE }).decisao).toBe('COBERTURA_PAUSA');
    const p = R.planejarLiberacao({ hoje: HOJE, carteiras: mapa(['GC:10', cart(10, ADE)]), vend: vp, vendasPorCliente: mapa(['10', [vs[0]]]) });
    expect(p.liberar).toHaveLength(0); expect(p.bloqueados.OWNER_EM_PAUSA).toEqual(['10']);
  });
});

describe('B3 — reativação e transferência', () => {
  const v = vend();
  const vs0 = [venda(1, 10, dia(150), '111')];
  const reserva = (ex = {}) => ({ estado: 'RESERVADA', destinoUid: FAB, liberadoEm: dia(3), reservaAte: R.somarDias(dia(3), 7), ...ex });
  const chave = R.chaveReativacao('GC:10', dia(150));
  test('reativação SEM venda → owner não muda (reserva só expira)', () => {
    const p = R.planejarLiberacao({ hoje: HOJE, carteiras: mapa(['GC:10', cart(10, ADE)]), vend: v, vendasPorCliente: mapa(['10', vs0]) });
    expect(p.liberar[0].ownerUid).toBe(ADE); expect(p.liberar[0].destinoUid).toBe(FAB);                       // oportunidade ≠ transferência
  });
  test('reativação + venda válida do vendedor destino DURANTE a reserva → owner muda', () => {
    const venda2 = venda(2, 10, dia(1), '222'); const d = R.decidirVendaB3({ venda: venda2, vendasCliente: [...vs0, venda2], carteira: cart(10, ADE), vend: v, reservas: mapa([chave, reserva()]), hoje: HOJE });
    expect(d).toMatchObject({ decisao: 'TRANSFERIR_REATIVACAO', ownerAntesUid: ADE, ownerDepoisUid: FAB, creditoUid: FAB, referencias: { reservaChave: chave, ciclo: dia(150), vendaId: '2', portfolioId: 'GC:10' } });
  });
  test('venda >=120 dias SEM oportunidade para o vendedor, reserva alheia, vencida ou já convertida → NÃO transfere (revisão da gestão)', () => {
    const venda2 = venda(2, 10, dia(1), '222');
    for (const rs of [undefined, mapa([chave, reserva({ destinoUid: ADE })]), mapa([chave, reserva({ reservaAte: dia(2), liberadoEm: dia(9) })]), mapa([chave, reserva({ estado: 'CONVERTIDA' })]), mapa([chave, reserva({ estado: 'EXPIRADA' })])]) {
      const d = R.decidirVendaB3({ venda: venda2, vendasCliente: [...vs0, venda2], carteira: cart(10, ADE), vend: v, reservas: rs, hoje: HOJE });
      expect(d).toMatchObject({ decisao: 'MANTER_SEM_OPORTUNIDADE', ownerDepoisUid: ADE, gestaoReview: true });
    }
  });
  test('extensão por follow-up real (data futura + motivo) mantém a reserva válida além de 7 dias; sem follow-up vence', () => {
    const venda2 = venda(2, 10, dia(0), '222'); const rs = reserva({ liberadoEm: dia(12), reservaAte: dia(5) });
    const d0 = R.decidirVendaB3({ venda: venda2, vendasCliente: [...vs0, venda2], carteira: cart(10, ADE), vend: v, reservas: mapa([chave, rs]), hoje: HOJE }); expect(d0.decisao).toBe('MANTER_SEM_OPORTUNIDADE');
    const d1 = R.decidirVendaB3({ venda: venda2, vendasCliente: [...vs0, venda2], carteira: cart(10, ADE), vend: v, reservas: mapa([chave, { ...rs, followUpAte: R.somarDias(HOJE, 2) }]), hoje: HOJE }); expect(d1.decisao).toBe('TRANSFERIR_REATIVACAO');
  });
  test('o próprio owner vendendo na reativação só renova (não perde a carteira)', () => {
    const venda2 = venda(2, 10, dia(1), '111'); expect(R.decidirVendaB3({ venda: venda2, vendasCliente: [...vs0, venda2], carteira: cart(10, ADE), vend: v, reservas: mapa([chave, reserva()]), hoje: HOJE })).toMatchObject({ decisao: 'RENOVAR_OWNER', ownerDepoisUid: ADE });
  });
  test('duas vendas concorrentes: em ordem comercial só a primeira transfere; a segunda vira renovação/cobertura', () => {
    const a = venda(2, 10, dia(1), '222'), b = venda(3, 10, dia(1), '111');                       // mesma data; id decide: 2 antes de 3
    const seq = R.sequenciaB3({ vendasCliente: [...vs0, b, a], carteiraInicial: cart(10, ADE), vend: v, reservas: mapa([chave, reserva()]), hoje: HOJE });
    expect(seq.map(x => x.d.decisao)).toEqual(['RENOVAR_OWNER', 'TRANSFERIR_REATIVACAO', 'COBERTURA_RENOVA_OWNER']);                         // venda 1 (dono) → 2 (transfere p/ FAB) → 3 (ADE agora é "outro" <120d: cobertura)
    expect(seq.filter(x => R.ALTERA_OWNER.includes(x.d.decisao))).toHaveLength(1);
  });
});

describe('B3 — clientes sem carteira', () => {
  const v = vend();
  test('comprador sem carteira >=120d: NÃO recebe owner no planejamento; só entra quando incluirSemCarteira=true e continua SEM_CARTEIRA', () => {
    const base = { hoje: HOJE, carteiras: new Map(), semCarteira: ['20'], vend: v, vendasPorCliente: mapa(['20', [venda(1, 20, dia(200), '111')]]) };
    expect(R.planejarLiberacao(base).liberar).toHaveLength(0);
    const p = R.planejarLiberacao({ ...base, incluirSemCarteira: true }); expect(p.liberar).toHaveLength(1); expect(p.liberar[0]).toMatchObject({ tipo: 'SEM_CARTEIRA', ownerUid: null });
  });
  test('primeira venda válida na reativação cria owner = QUEM vendeu (Ademir ou Fabiana), nunca o vendedor cadastral', () => {
    const vs = [venda(1, 20, dia(200), '999'), venda(2, 20, dia(1), '222')];                  // histórico antigo (vendedor qualquer); nova venda da Fabiana
    const ch = R.chaveReativacao('GC:20', dia(200)); const rs = mapa([ch, { estado: 'RESERVADA', destinoUid: FAB, liberadoEm: dia(3), reservaAte: R.somarDias(dia(3), 7) }]);
    expect(R.decidirVendaB3({ venda: vs[1], vendasCliente: vs, carteira: null, vend: v, reservas: rs, hoje: HOJE })).toMatchObject({ decisao: 'CRIAR_VIA_REATIVACAO', ownerDepoisUid: FAB });
    const rsA = mapa([ch, { estado: 'RESERVADA', destinoUid: ADE, liberadoEm: dia(3), reservaAte: R.somarDias(dia(3), 7) }]);
    expect(R.decidirVendaB3({ venda: vs[1], vendasCliente: vs, carteira: null, vend: v, reservas: rsA, hoje: HOJE }).decisao).toBe('MANTER_SEM_OPORTUNIDADE');   // reserva era do outro
  });
  test('sem carteira e <120 dias: aguarda; primeira venda de todas: cria carteira (regra aprovada)', () => {
    const vs = [venda(1, 21, dia(30), '999'), venda(2, 21, dia(1), '111')];
    expect(R.decidirVendaB3({ venda: vs[1], vendasCliente: vs, carteira: null, vend: v, hoje: HOJE }).decisao).toBe('MANTER_SEM_CARTEIRA');
    expect(R.decidirVendaB3({ venda: venda(5, 22, dia(1), '111'), vendasCliente: [venda(5, 22, dia(1), '111')], carteira: null, vend: v, hoje: HOJE }).decisao).toBe('CRIAR_PRIMEIRA_VENDA');
  });
});

describe('B3 — bloqueios', () => {
  const v = vend(); const vs = mapa(['10', [venda(1, 10, dia(150), '111')]]);
  const plano = ex => R.planejarLiberacao({ hoje: HOJE, carteiras: mapa(['GC:10', cart(10, ADE, ex.cart)]), vend: v, vendasPorCliente: vs, ...ex.p });
  test('conflito de identidade (EM_REVISAO, conflito ativo ou id no conjunto de conflitos) → bloqueado, sem merge, sem owner', () => {
    expect(plano({ cart: { status: 'EM_REVISAO', conflito: { revisao: 'PENDENTE' } } }).bloqueados.CONFLITO).toEqual(['10']);
    expect(plano({ p: { conflitosGc: new Set(['10']) } }).bloqueados.CONFLITO).toEqual(['10']);
    expect(plano({ cart: { status: 'ATIVA', conflito: { revisao: 'RESOLVIDO' } } }).liberar).toHaveLength(1);
  });
  test('NÃO CONTATAR → bloqueado', () => { expect(plano({ p: { naoContatar: new Set(['10']) } }).bloqueados.NAO_CONTATAR).toEqual(['10']); });
  test('sem interesse (cooldown 30 dias): <30d bloqueia; vencido libera', () => {
    expect(plano({ p: { cooldowns: new Map([['10', R.somarDias(HOJE, 5)]]) } }).bloqueados.COOLDOWN).toEqual(['10']);
    expect(plano({ p: { cooldowns: new Map([['10', R.somarDias(HOJE, -1)]]) } }).liberar).toHaveLength(1);
    expect(plano({ p: { cooldowns: new Map([['10', HOJE]]) } }).liberar).toHaveLength(1);                         // cooldown termina no dia → elegível
  });
  test('follow-up real futuro bloqueia; vencido libera', () => {
    expect(plano({ p: { followUps: new Map([['10', R.somarDias(HOJE, 3)]]) } }).bloqueados.FOLLOWUP).toEqual(['10']);
    expect(plano({ p: { followUps: new Map([['10', R.somarDias(HOJE, -1)]]) } }).liberar).toHaveLength(1);
  });
  test('decisão de venda em cliente com conflito: bloqueada, nada muda', () => {
    const venda2 = venda(2, 10, dia(1), '222'); const d = R.decidirVendaB3({ venda: venda2, vendasCliente: [venda(1, 10, dia(150), '111'), venda2], carteira: cart(10, ADE, { status: 'EM_REVISAO', conflito: { revisao: 'PENDENTE' } }), vend: v, hoje: HOJE });
    expect(d).toMatchObject({ decisao: 'BLOQUEADO_CONFLITO', ownerDepoisUid: ADE });
  });
});

describe('B3 — venda válida, cancelamento e devolução', () => {
  const v = vend();
  test('cancelada / não concretizada / zerada / futura não contam nem renovam', () => {
    for (const x of [{ nome_situacao: 'Cancelada' }, { nome_situacao: 'Em aberto' }, { nome_situacao: 'Reservado' }, { valor_total: '0' }, { data: R.somarDias(HOJE, 3) }]) {
      const vv = venda(2, 10, dia(1), '111', x); expect(R.decidirVendaB3({ venda: vv, vendasCliente: [vv], carteira: cart(10, ADE), vend: v, hoje: HOJE }).decisao).toBe('IGNORAR_INVALIDA');
    }
    const c = R.cicloDoCliente({ vendasCliente: [venda(1, 10, dia(150), '111'), venda(2, 10, dia(1), '111', { nome_situacao: 'Cancelada' })], carteira: cart(10, ADE), vend: v, hoje: HOJE }); expect(c.aberta).toBe(true);
  });
  test('devolução TOTAL (quando comprovada) invalida a renovação; PARCIAL mantém', () => {
    const vs = [venda(1, 10, dia(150), '111'), venda(2, 10, dia(5), '111')];
    expect(R.cicloDoCliente({ vendasCliente: vs, carteira: cart(10, ADE), vend: v, hoje: HOJE, devolucoes: new Map([['2', 'TOTAL']]) })).toMatchObject({ aberta: true, dias: 150 });
    expect(R.cicloDoCliente({ vendasCliente: vs, carteira: cart(10, ADE), vend: v, hoje: HOJE, devolucoes: new Map([['2', 'PARCIAL']]) })).toMatchObject({ aberta: false, dias: 5 });
    expect(R.decidirVendaB3({ venda: vs[1], vendasCliente: vs, carteira: cart(10, ADE), vend: v, hoje: HOJE, devolucoes: new Map([['2', 'TOTAL']]) })).toMatchObject({ decisao: 'IGNORAR_INVALIDA', motivo: 'DEVOLUCAO_TOTAL' });
  });
});

describe('B3 — limite diário, prioridade e idempotência', () => {
  const v = vend();
  const cenario = (n, ex = {}) => { const carteiras = new Map(), vpc = new Map(); for (let i = 1; i <= n; i++) { carteiras.set('GC:' + i, cart(i, i % 2 ? ADE : FAB)); vpc.set(String(i), [venda(i, i, dia(130 + i), i % 2 ? '111' : '222', { valor_total: String(i * 10) })]); } return { hoje: HOJE, carteiras, vend: v, vendasPorCliente: vpc, ...ex }; };
  test('máximo de 10 novas reativações por vendedor por dia; o resto vira backlog; dias estimados = ceil(n/10)', () => {
    const p = R.planejarLiberacao(cenario(60));                                                       // 30 de cada owner → 30 para o outro vendedor
    const porDest = u => p.liberar.filter(x => x.destinoUid === u).length; expect(porDest(ADE)).toBe(10); expect(porDest(FAB)).toBe(10);
    expect(p.backlog).toEqual({ [ADE]: 20, [FAB]: 20 }); expect(p.diasEstimados).toBe(3); expect(p.candidatosElegiveis).toBe(60);
  });
  test('reservas já criadas HOJE contam no limite; reexecução do dia não duplica (idempotente)', () => {
    const c = cenario(60); const p1 = R.planejarLiberacao(c);
    const reservas = new Map(p1.liberar.map(x => [x.chave, { chave: x.chave, destinoUid: x.destinoUid, liberadoEm: HOJE, estado: 'RESERVADA' }]));
    const p2 = R.planejarLiberacao({ ...c, reservasExistentes: reservas }); expect(p2.liberar).toHaveLength(0); expect(p2.bloqueados.RESERVA_JA_CRIADA).toHaveLength(20);
    expect(new Set(p1.liberar.map(x => x.chave)).size).toBe(p1.liberar.length);                         // chaves únicas
  });
  test('o mesmo ciclo nunca gera segunda reserva (mesmo em outro dia); novo ciclo (nova compra + 120d) gera nova chave', () => {
    const c = cenario(2); const p1 = R.planejarLiberacao(c); const r = new Map(p1.liberar.map(x => [x.chave, { chave: x.chave, destinoUid: x.destinoUid, liberadoEm: R.somarDias(HOJE, -20), estado: 'EXPIRADA' }]));
    expect(R.planejarLiberacao({ ...c, hoje: R.somarDias(HOJE, 1), reservasExistentes: r }).liberar).toHaveLength(0);
    expect(R.chaveReativacao('GC:1', '2026-01-01')).not.toBe(R.chaveReativacao('GC:1', '2026-06-01')); expect(R.chaveReativacao('GC:1', '2026-01-01')).toBe('REATIV:GC:1:2026-01-01');
  });
  test('prioridade RFM determinística: maior valor/frequência primeiro; empate resolvido por id', () => {
    const p = R.planejarLiberacao(cenario(8)); const doAde = p.liberar.filter(x => x.destinoUid === ADE).map(x => x.id);
    const p2 = R.planejarLiberacao(cenario(8)); expect(p2.liberar.map(x => x.chave)).toEqual(p.liberar.map(x => x.chave));
    expect(R.prioridadesRfm([{ id: 'a', monetario: 10, pedidos: 1, dias: 130 }, { id: 'b', monetario: 1000, pedidos: 9, dias: 130 }]).get('b')).toBeGreaterThan(R.prioridadesRfm([{ id: 'a', monetario: 10, pedidos: 1, dias: 130 }, { id: 'b', monetario: 1000, pedidos: 9, dias: 130 }]).get('a'));
    expect(doAde.length).toBeGreaterThan(0);
  });
  test('vendedor desligado/pausado/sem receber não é destino', () => {
    const vp = vend({ fab: { fc: { recebeNovasOportunidades: false } } });
    const p = R.planejarLiberacao({ ...cenario(4), vend: vp }); expect(p.liberar.filter(x => x.destinoUid === FAB)).toHaveLength(0);
  });
});
