'use strict';
// N35.16.1 — Sanitização de CPF/CNPJ no nome de exibição. Fixtures SINTÉTICOS (nenhum documento real).
const { sanitizeCommercialDisplayName: san, contemDocumento } = require('../lib/nomeExibicao');
const { prepararDadosUI, prepararDadosUIProspect } = require('../lib/filaComercialUtils');
const { construirSnapshot, assertSnapshotSeguro } = require('../lib/filaComercialWriter');
const { criarLookupNomeGC, resolverNomesSelecionados } = require('../lib/filaNomes');
const { processarPerfilParaFila } = require('../lib/filaComercialPipeline');
const { buildOpportunityInstanceId, commercialEntityIdFromPerfil360 } = require('../lib/commercialIdentity');
const G = require('../lib/worklistGenerator');

const CPF_F = '123.456.789-00', CPF_R = '12345678900';
const CNPJ_F = '12.345.678/0001-90', CNPJ_R = '12345678000190', CNPJ_RAIZ = '12.345.678';

describe('CPF', () => {
  test.each([
    ['nome + CPF formatado', `DIEGO DA SILVA RODRIGUES ${CPF_F}`, 'DIEGO DA SILVA RODRIGUES'],
    ['CPF formatado + nome', `${CPF_F} DIEGO DA SILVA`, 'DIEGO DA SILVA'],
    ['nome + CPF sem máscara', `RENATO FELIX DE SOUZA ${CPF_R}`, 'RENATO FELIX DE SOUZA'],
    ['CPF sem máscara + nome', `${CPF_R} RENATO FELIX`, 'RENATO FELIX'],
    ['CPF entre parênteses', `JOÃO DA SILVA (${CPF_F})`, 'JOÃO DA SILVA'],
    ['CPF após hífen', `RENATO FELIX - ${CPF_R}`, 'RENATO FELIX'],
    ['CPF colado ao nome', `SILVA${CPF_R}`, 'SILVA'],
    ['CPF com rótulo', `MARIA SOUSA CPF: ${CPF_F}`, 'MARIA SOUSA'],
    ['CPF só com DV separado', `MARIA SOUSA 123456789-00`, 'MARIA SOUSA'],
    ['CPF no meio', `ANA ${CPF_R} MOTOS`, 'ANA MOTOS'],
  ])('%s', (_, entrada, esperado) => {
    expect(san(entrada)).toBe(esperado);
    expect(contemDocumento(san(entrada))).toBe(false);
  });
});

describe('CNPJ', () => {
  test.each([
    ['nome + CNPJ formatado', `AUTO PECAS LTDA ${CNPJ_F}`, 'AUTO PECAS LTDA'],
    ['CNPJ formatado + nome', `${CNPJ_F} JORGE LUIZ MUNIZ`, 'JORGE LUIZ MUNIZ'],
    ['nome + CNPJ sem máscara', `OFICINA BOA ${CNPJ_R}`, 'OFICINA BOA'],
    ['CNPJ sem máscara + nome', `${CNPJ_R} OFICINA BOA`, 'OFICINA BOA'],
    ['CNPJ entre parênteses', `SOM & CIA (${CNPJ_F})`, 'SOM & CIA'],
    ['CNPJ após hífen', `SOM & CIA - ${CNPJ_R}`, 'SOM & CIA'],
    ['raiz de CNPJ de MEI no início', `${CNPJ_RAIZ} JORGE LUIZ MUNIZ PEREIRA JUNIOR`, 'JORGE LUIZ MUNIZ PEREIRA JUNIOR'],
    ['CNPJ com rótulo', `LOJA X CNPJ nº ${CNPJ_F}`, 'LOJA X'],
  ])('%s', (_, entrada, esperado) => {
    expect(san(entrada)).toBe(esperado);
    expect(contemDocumento(san(entrada))).toBe(false);
  });
});

describe('Preservação (nada que não seja CPF/CNPJ é removido)', () => {
  test.each([
    'KY SOM COMERCIO DE ACESSORIOS LTDA',
    'LOJA 10 AUTO SOM',
    'K2 ACESSORIOS',
    'AUTO SOM 2026',
    'ELANNE D. N. SOUSA',
    'Leão Acessórios/ R A De Souza Mr4 ( Rafael)',
    'OFICINA CEP 60000-000',
    'LOJA 60.000-000',
    'AUTO CENTER RUA 123 Nº 45',
    'PECAS COD 4521-A',
    'SOM HONDA CIVIC 2019 G10',
    'JOÃO  DOUBLE  ESPAÇO',
    'CLIENTE 1234567',
  ])('"%s" permanece idêntico', nome => {
    expect(san(nome)).toBe(nome);
    expect(contemDocumento(nome)).toBe(false);
  });
});

describe('Fail closed', () => {
  test.each([[CPF_F], [CPF_R], [CNPJ_F], [CNPJ_R], [`(${CPF_F})`], [` - ${CNPJ_R} - `], ['CPF: ' + CPF_R]])('somente documento "%s" → null', e => {
    expect(san(e)).toBeNull();
  });
  test.each([[null], [undefined], [''], ['   '], [42], [{}]])('entrada inválida %p → null', e => {
    expect(san(e)).toBeNull();
  });
});

describe('Identidade não depende do nome', () => {
  const perfil = { clienteMr4Id: 'AbCdEfGhIjKlMnOpQrSt', ultimaCompraEm: '2025-08-07', diasSemComprar: 414, nuncaComprou: false, pedidosTotal: 5, faturamentoTotal: 900, diasEntreComprasMediana: 30 };
  test('ID-01 nome com CPF e nome limpo → mesmo commercialEntityId e opportunityInstanceId', async () => {
    const a = await processarPerfilParaFila(perfil, `${CPF_F} JOÃO DA SILVA`, { dataReferencia: '2026-09-25' });
    const b = await processarPerfilParaFila(perfil, 'JOÃO DA SILVA', { dataReferencia: '2026-09-25' });
    expect(a.commercialEntityId).toBe(b.commercialEntityId);
    expect(a.opportunityInstanceId).toBe(b.opportunityInstanceId);
    expect(a.prioridade).toBe(b.prioridade);
    expect(a.decisaoAcaoComercial).toBe(b.decisaoAcaoComercial);
  });
  test('ID-02 buildOpportunityInstanceId nem recebe nome', () => {
    const ent = commercialEntityIdFromPerfil360(perfil);
    expect(buildOpportunityInstanceId.length).toBe(3);
    expect(buildOpportunityInstanceId(ent, 'REATIVACAO_120D', '2025-08-07')).toMatch(/^[0-9a-f]{16}$/);
  });
});

describe('Snapshot', () => {
  const base = { opportunityInstanceId: 'a'.repeat(16), tipoOportunidade: 'REATIVACAO_120D', decisaoAcaoComercial: 'AGIR_AGORA', prioridade: 90, diasSemComprar: 200 };
  test('SN-01 prepararDadosUI remove documento, mantém o resto do item idêntico', () => {
    const com = prepararDadosUI({ ...base, nomeCliente: `DIEGO SILVA ${CPF_F}` });
    const sem = prepararDadosUI({ ...base, nomeCliente: 'DIEGO SILVA' });
    expect(com).toEqual(sem);
  });
  test('SN-02 prepararDadosUIProspect remove documento', () => {
    expect(prepararDadosUIProspect({ nomeCliente: `${CNPJ_F} LOJA` }).nomeCliente).toBe('LOJA');
  });
  test('SN-03 snapshot mantém quantidades, tipos e ordem; nomes sem documento', () => {
    const brutos = [
      { ...base, clienteMr4Id: 'x1', commercialEntityId: 'GC_NATIVE:1', nomeCliente: `A ${CPF_R}` },
      { ...base, clienteMr4Id: 'x2', commercialEntityId: 'GC_NATIVE:2', opportunityInstanceId: 'b'.repeat(16), nomeCliente: 'B LTDA', prioridade: 80 },
    ];
    const s = construirSnapshot(brutos, { dataReferencia: '2026-09-25' });
    expect(s.clientesHoje.map(c => [c.opportunityInstanceId, c.nomeCliente, c.tipoOportunidade])).toEqual([['a'.repeat(16), 'A', 'REATIVACAO_120D'], ['b'.repeat(16), 'B LTDA', 'REATIVACAO_120D']]);
    expect(() => assertSnapshotSeguro(s)).not.toThrow();
  });
  test('SN-04 assertSnapshotSeguro barra snapshot com documento residual', () => {
    const s = { clientesHoje: [{ nomeCliente: `X ${CPF_F}` }], clientesProximos: [], clientesProspeccao: [] };
    expect(() => assertSnapshotSeguro(s)).toThrow(/CPF\/CNPJ/);
  });
});

describe('Adaptador GestãoClick', () => {
  const resp = nome => async url => ({ ok: true, json: async () => ({ data: { id: url.split('/').pop(), nome } }) });
  test('GC-01 devolve nome sem documento e conta a sanitização (sem expor o número)', async () => {
    const lk = criarLookupNomeGC({ accessToken: 'a', secretToken: 'b', fetchImpl: resp(`DIEGO SILVA ${CPF_R}`) });
    expect(await lk('111')).toBe('DIEGO SILVA');
    expect(lk.stats).toEqual({ sanitized: 1, sanitizedEmpty: 0 });
  });
  test('GC-02 nome que é só documento → null e contado como vazio', async () => {
    const lk = criarLookupNomeGC({ accessToken: 'a', secretToken: 'b', fetchImpl: resp(CNPJ_F) });
    expect(await lk('222')).toBeNull();
    expect(lk.stats).toEqual({ sanitized: 1, sanitizedEmpty: 1 });
  });
  test('GC-03 resolverNomesSelecionados sanitiza nome já existente', async () => {
    const r = await resolverNomesSelecionados([{ commercialEntityId: 'GC_NATIVE:3', gestaoClickId: '3', nomeCliente: `ANA ${CPF_F}` }], { lookupNome: async () => 'X' });
    expect(r.itens[0].nomeCliente).toBe('ANA');
  });
});

describe('Worklist V2', () => {
  const FAB = 'UGXinD3KVXX0ouYEfamBWjizC5C2';
  function dados(n = 15) {
    const vendas = [];
    for (let i = 0; i < n; i++) {
      const gc = String(55500000 + i);
      for (let k = 0; k < 5; k++) {
        const d = new Date(Date.UTC(2026, 2, 10 + i) - k * 20 * 86400000).toISOString().slice(0, 10);
        vendas.push({ id: gc + 'v' + k, cliente_id: gc, data: d, nome_situacao: 'Concretizada', valor_total: '300', cadastrado_em: d + ' 10:00:00', vendedor_id: '1', produtos: [] });
      }
    }
    return { perfis: [], clientes: [], vendas, estados: new Map(), users: new Map([[FAB, { ativo: true, role: 'funcionario' }]]), sistema: new Map([[FAB, { modulos: ['fila-comercial-operar'], filaComercial: { ativo: true, recebeNovasOportunidades: true, limiteNovasPorDia: 10 } }]]) };
  }
  const gerar = lookupNome => G.executarGeracaoWorklist({ db: null, now: new Date('2026-09-25T09:00:00.000Z'), mode: 'DRY_RUN', logger: { log() {} }, lookupNome, dados: dados() });
  const mesmaSemNome = r => r.doc.vendedores[FAB].novas.map(x => x.opportunityInstanceId);

  test('WL-01 5 de 10 com documento → 10 nomes limpos, mesma seleção, contadores corretos', async () => {
    const r = await gerar(async gc => (Number(gc) % 2 ? `CLIENTE ${gc} ${CPF_F}` : `CLIENTE ${gc}`));
    const novas = r.doc.vendedores[FAB].novas;
    expect(novas).toHaveLength(10);
    expect(novas.filter(x => contemDocumento(x.nomeCliente))).toHaveLength(0);
    expect(Object.values(r.doc.atribuicoes).filter(a => contemDocumento(a.nomeCliente))).toHaveLength(0);
    const comDocumentoNaOrigem = novas.filter(x => Number(x.commercialEntityId.split(':')[1]) % 2).length;
    expect(comDocumentoNaOrigem).toBeGreaterThan(0);
    expect(r.doc.contagens.nameSanitized).toBe(comDocumentoNaOrigem);
    expect(r.doc.contagens.nameSanitizedEmpty).toBe(0);
    const limpo = await gerar(async gc => `CLIENTE ${gc}`);
    expect(mesmaSemNome(r)).toEqual(mesmaSemNome(limpo)); // sanitização não muda seleção nem ordem
  });
  test('WL-02 nome que vira vazio → candidato substituído pelo próximo elegível', async () => {
    const vazios = new Set();
    const r = await gerar(async gc => { if (Number(gc) % 3 === 0) { vazios.add(gc); return CPF_F; } return `CLIENTE ${gc}`; });
    const novas = r.doc.vendedores[FAB].novas;
    expect(novas).toHaveLength(10);
    expect(novas.every(x => /^CLIENTE \d+$/.test(x.nomeCliente))).toBe(true);
    expect(novas.some(x => vazios.has(x.commercialEntityId.split(':')[1]))).toBe(false);
    expect(r.doc.contagens.nameSanitizedEmpty).toBeGreaterThan(0);
  });
  test('WL-03 adaptador GC real (fetch simulado) + gerador → nada com documento no documento final', async () => {
    const lk = criarLookupNomeGC({ accessToken: 'a', secretToken: 'b', fetchImpl: async url => ({ ok: true, json: async () => ({ data: { id: url.split('/').pop(), razao_social: `${CNPJ_RAIZ} LOJA ${url.split('/').pop()}` } }) }) });
    const r = await gerar(lk);
    expect(JSON.stringify(r.doc)).not.toMatch(/\d{2}\.\d{3}\.\d{3}/);
    expect(r.doc.contagens.nameSanitized).toBe(10);
  });
  test('WL-04 defesa final: nome com documento que escapasse → nada é gravado (fail closed)', () => {
    const doc = { vendedores: { u: { novas: [{ nomeCliente: `X ${CPF_F}` }], followUps: [], emAtendimento: [] } }, atribuicoes: {} };
    const invalidos = Object.values(doc.vendedores).flatMap(v => [...v.novas]).filter(x => contemDocumento(x.nomeCliente)).length;
    expect(invalidos).toBe(1); // mesmo critério usado pela guarda antes do set()
  });
  test('WL-05 itemDoc aplica a sanitização mesmo recebendo nome bruto', () => {
    const it = G.itemDoc({ opportunityInstanceId: 'c'.repeat(16), commercialEntityId: 'GC_NATIVE:9', tipoOportunidade: 'REATIVACAO_120D', nomeCliente: `ZE ${CPF_R}`, diasSemComprar: 150 }, 1);
    expect(it.nomeCliente).toBe('ZE');
  });
});
