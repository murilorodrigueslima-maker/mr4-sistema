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
  test('CONFIRMADO D04 (efeito): com dois créditos no mesmo dia, o resultado depende da ordem; Registros e mês podem divergir', () => {
    const d = '2026-09-15';
    const a = { id: 'a', funcId: 'fx', data: d, minutos: 480, motivo: 'Atestado médico' };
    const b = { id: 'b', funcId: 'fx', data: d, minutos: 0, motivo: 'Folga compensatória' };
    const saldo = creds => M.calcMes(F, [], creds, [], '2026-09', d).dias.find(x => x.data === d).saldoMin;
    expect([saldo([a, b]), saldo([b, a])]).toEqual([-480, 0]);
    const telaRegistros = M.calcDia(F, d, [], [a, b].find(c => c.data === d), []).saldoMin;      // ponto.html usa .find (o primeiro)
    expect(telaRegistros).not.toBe(saldo([a, b]));                                                // o mês usa o último
    expect(GESTOR).toContain('credTodos.find(c=>c.funcId===funcId&&c.data===data)');
  });
  test('CONFIRMADO D19: espelho com folga compensatória do banco nunca fica "equivalente" para o funcionário (não assina)', () => {
    const d = '2026-09-15', func = { ...F, inicioBancoHoras: d };
    const gerar = () => M.buildEspelhoSnapshot(func, [], [], [], '2026-09', d);
    const doGestor = gerar();
    expect(M.snapshotsEquivalentes(doGestor, gerar())).toBe(true);                                // controle
    const dia = doGestor.dias.find(x => x.data === d);
    dia.ocorrencia = 'Folga compensatória (banco de horas) dia inteiro';                          // anotação feita só em ponto.html
    expect(M.snapshotsEquivalentes(doGestor, gerar())).toBe(false);
    expect(GESTOR).toContain("dd.ocorrencia='Folga compensatória (banco de horas) '");
    expect(FUNC).not.toContain('Folga compensatória (banco de horas)');
  });
  test('CONFIRMADO D20: antes da primeira batida do dia, funcionário vê falta no saldo do mês e o gestor não', () => {
    const regs = cheio('2026-09-14'), func = { ...F, inicioBancoHoras: '2026-09-14' };
    const telaFunc = M.calcBancoMes(func, regs, [], '2026-09', '2026-09-15', []).saldo;           // ponto-func: sempre hoje
    const telaGestor = M.calcBancoMes(func, regs, [], '2026-09', '2026-09-14', []).saldo;         // ponto.html: ontem se hoje está aberto
    expect([telaFunc, telaGestor]).toEqual([-480, 0]);
    expect(FUNC).toContain('calcBancoMes(funcAtivo,regs,credF,mes,hoje(),justF)');
    expect(GESTOR).toContain('if(calcTotal(eH,saH,raH,sH)===null)hojeParaBanco=_ontemStr;');
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
  test('CONFIRMADO D22: painel "Hoje" não aplica as opções do motor (sábado com intervalo nulo aparece sem total)', () => {
    const d = M.K.SABADO_V2_DESDE;
    const regs = [reg(d, 'entrada', '08:30'), reg(d, 'saida_almoco', '12:00'), reg(d, 'retorno_almoco', '12:00'), reg(d, 'saida', '12:00')];
    expect(M.calcDia(F, d, regs, null, []).trabalhadoMin).toBe(210);
    expect(M.calcTotal('08:30', '12:00', '12:00', '12:00')).toBeNull();
    expect(GESTOR).toContain('const total=calcTotal(e,sa,ra,s);');
  });
});
