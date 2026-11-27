'use strict';
/**
 * DIAGNÓSTICO TÉCNICO DO PONTO — consistência do cálculo, cópias do motor e fusos (puro: sem Firebase, sem rede).
 * "CONFIRMADO Dxx" = comportamento atual considerado defeito (inverter ao corrigir). "CONTROLE" = consistência que existe.
 * Os testes não julgam a regra trabalhista: só comparam caminhos do próprio sistema entre si.
 * Quando um defeito mora na tela (HTML), o teste também confere que o trecho de código reproduzido continua lá.
 */
const fs = require('fs'), path = require('path'), vm = require('vm'), cp = require('child_process');
const raiz = path.resolve(__dirname, '../..');
const ler = p => fs.readFileSync(path.join(raiz, p), 'utf8');
const SRC = ler('modulos/ponto-regras.js');
const M = {}; vm.createContext(M);
vm.runInContext(SRC + ';this.K={SABADO_V2_DESDE,JORNADA_SABADO_MIN,TIPOS_SEM_CREDITO};', M);
const GESTOR = ler('modulos/ponto.html'), FUNC = ler('modulos/ponto-func.html'), INDEX = ler('functions/index.js');

const F = { id: 'fx', nome: 'Fixture', cargo: 'Teste', jornada: 8 };
let n = 0;
const reg = (data, tipo, hora) => ({ id: 'm' + (++n), funcId: 'fx', data, tipo, hora: hora + ':00' });
const cheio = d => [reg(d, 'entrada', '08:00'), reg(d, 'saida_almoco', '12:00'), reg(d, 'retorno_almoco', '13:00'), reg(d, 'saida', '17:00')];

describe('CONTROLE — cópias e constantes', () => {
  test('motor do front e cópia das Functions são idênticos byte a byte', () => {
    expect(ler('functions/lib/ponto-regras.copy.js')).toBe(SRC);
  });
  test('lista "motivos sem crédito" igual no motor, no servidor e na tela do gestor', () => {
    const lista = (t, re) => JSON.parse(t.match(re)[1].replace(/'/g, '"'));
    const motor = [...M.K.TIPOS_SEM_CREDITO];
    expect(lista(ler('functions/lib/pontoJustificativa.js'), /SEM_CREDITO = (\[[^\]]+\])/)).toEqual(motor);
    expect(lista(GESTOR, /tiposSemCredito=(\[[^\]]+\])/)).toEqual(motor);
  });
  test('raio, coordenadas e limite sem almoço iguais entre tela e servidor', () => {
    const num = (t, re) => Number(t.match(re)[1]);
    expect(num(FUNC, /RAIO=(\d+)/)).toBe(num(INDEX, /RAIO_M\s*=\s*(\d+)/));
    expect(num(FUNC, /EMP_LAT=(-?[\d.]+)/)).toBe(num(INDEX, /EMP_LAT\s*=\s*(-?[\d.]+)/));
    expect(num(FUNC, /EMP_LNG=(-?[\d.]+)/)).toBe(num(INDEX, /EMP_LNG\s*=\s*(-?[\d.]+)/));
    expect(num(FUNC, /MAX_MIN_SEM_ALMOCO_UI=(\d+)/)).toBe(require('../lib/pontoBatida').MAX_MIN_SEM_ALMOCO);
  });
});

describe('CONTROLE — fusos', () => {
  test('o motor dá o mesmo resultado em qualquer fuso do aparelho/servidor', () => {
    const script = `
      const fs=require('fs'),vm=require('vm');const c={};vm.createContext(c);vm.runInContext(fs.readFileSync(process.argv[1],'utf8'),c);
      const F={id:'fx',jornada:8,inicioBancoHoras:'2026-01-01'};const regs=[];
      for(const d of ['2026-02-28','2026-03-07','2026-03-08','2026-10-31','2026-11-01','2026-12-31'])for(const [t,h] of [['entrada','08:00'],['saida','12:00']])regs.push({id:d+t,funcId:'fx',data:d,tipo:t,hora:h+':00'});
      const out=['2026-02','2026-03','2026-10','2026-11','2026-12'].map(m=>c.calcMes(F,regs,[],[],m,'2026-12-31'));
      process.stdout.write(JSON.stringify([out,c.ciclosCct('2026-01-01',120,30,'2026-12-31'),c.mesesDoBanco('2026-01-31','2026-12'),c.dataIsoDe({seconds:Date.UTC(2026,10,1,2,59,59)/1000})]));`;
    const rodar = TZ => cp.execFileSync(process.execPath, ['-e', script, path.join(raiz, 'modulos/ponto-regras.js')], { env: { ...process.env, TZ }, encoding: 'utf8', maxBuffer: 1e8 });
    const base = rodar('America/Fortaleza');
    for (const tz of ['UTC', 'America/Los_Angeles', 'America/Sao_Paulo', 'Europe/Lisbon', 'Asia/Tokyo', 'Pacific/Auckland']) expect(rodar(tz)).toBe(base);
    expect(JSON.parse(base)[3]).toBe('2026-10-31');
  });
  test('data/hora oficial na virada do dia em Fortaleza (inclui "00", nunca "24")', () => {
    const { fortalezaAgora } = require('../utils');
    jest.useFakeTimers();
    try {
      const em = iso => { jest.setSystemTime(new Date(iso)); return fortalezaAgora(); };
      expect(em('2027-01-01T02:59:59Z')).toEqual({ data: '2026-12-31', hora: '23:59:59' });
      expect(em('2027-01-01T03:00:00Z')).toEqual({ data: '2027-01-01', hora: '00:00:00' });
    } finally { jest.useRealTimers(); }
  });
});

describe('Consistência entre telas e caminhos', () => {
  test('CORRIGIDO D04 (E3): com dois créditos legados no mesmo dia, Registros e mês escolhem o mesmo', () => {
    const d = '2026-09-15';
    const a = { id: 'a', funcId: 'fx', data: d, minutos: 480, motivo: 'Atestado médico' };
    const b = { id: 'b', funcId: 'fx', data: d, minutos: 0, motivo: 'Folga compensatória' };
    const saldo = creds => M.calcMes(F, [], creds, [], '2026-09', d).dias.find(x => x.data === d).saldoMin;
    expect(M.calcDia(F, d, [], M.creditoDoDia([a, b], 'fx', d), []).saldoMin).toBe(saldo([a, b]));
    expect(GESTOR).toContain('creditoDoDia(credTodos,funcId,data)');
  });
  test('CORRIGIDO D19 (E3): a folga do banco é anotada só na exibição, nas duas telas', () => {
    expect(GESTOR).not.toContain("dd.ocorrencia='Folga compensatória (banco de horas) '");
    for (const t of [GESTOR, FUNC]) expect(t).toContain('anotarFolgasExibicao(');
  });
  test('CORRIGIDO D20 (E3): as duas telas usam o mesmo corte do saldo do mês', () => {
    const regs = cheio('2026-09-14'), func = { ...F, inicioBancoHoras: '2026-09-14' };
    const corte = M.corteBancoMes([], '2026-09-15', '2026-09-14');
    expect(M.calcBancoMes(func, regs, [], '2026-09', corte, []).saldo).toBe(0);
    for (const t of [GESTOR, FUNC]) expect(t).toContain('corteBancoMes(');
    expect(FUNC).not.toContain('calcBancoMes(funcAtivo,regs,credF,mes,hoje(),justF)');
  });
  test('CONFIRMADO D21: crédito lançado pela tela ignora a escala individual; o do servidor respeita', () => {
    const d = '2026-09-14';                                                                       // segunda
    const func = { ...F, escalas: [{ vigenteDesde: '2026-09-01', rev: 1, dias: { 1: 540 } }] };
    const saldo = minutos => M.calcDia(func, d, [], { data: d, minutos, motivo: 'Atestado médico' }, []).saldoMin;
    const minutosTela = M.jornadaParaData(d, 8 * 60);
    const minutosServidor = M.escalaDoDia(func, d, 1);
    expect([minutosTela, minutosServidor]).toEqual([480, 540]);
    expect([saldo(minutosTela), saldo(minutosServidor)]).toEqual([-60, 0]);
    expect(GESTOR).toContain('creditarJornada(funcId,func.nome,dataIni,jornadaParaData(dataIni,jornMin),tipo)');
    expect(ler('functions/lib/pontoJustificativa.js')).toContain('M.escalaDoDia(D.func, data, dow)');
  });
  test('CORRIGIDO D22 (E3): painel "Hoje" usa o motor do dia', () => {
    const d = M.K.SABADO_V2_DESDE;
    const regs = [reg(d, 'entrada', '08:30'), reg(d, 'saida_almoco', '12:00'), reg(d, 'retorno_almoco', '12:00'), reg(d, 'saida', '12:00')];
    expect(M.calcDia(F, d, regs, null, []).trabalhadoMin).toBe(210);
    expect(GESTOR).toContain('const dh=calcDia(f,hoje(),rf,null,[]);');
    expect(GESTOR).not.toContain('const total=calcTotal(e,sa,ra,s);');
  });
});
