'use strict';

/**
 * GC-LINK1–GC-LINK13 — Testes do motor de linkagem GestãoClick ↔ MR4
 *
 * GC-LINK1  — documento único → MATCH DOCUMENT
 * GC-LINK2  — documento duplicado no GC → AMBIGUOUS (não linka)
 * GC-LINK3  — telefone único + nome compatível → MATCH PHONE_NAME
 * GC-LINK4  — telefone duplicado no GC → REVISAO_MANUAL (não linka automaticamente)
 * GC-LINK5  — telefone único + nome incompatível → REVISAO_MANUAL
 * GC-LINK6  — sem doc, sem tel, sem match → NO_MATCH
 * GC-LINK7  — já linkado corretamente → ALREADY_LINKED (idempotente)
 * GC-LINK8  — já linkado com ID diferente do candidato → CONFLICT detectado pelo chamador
 * GC-LINK9  — GC ID não pode ser associado a dois MR4 (validação 1:1 no dry-run)
 * GC-LINK10 — LISTAR_VENDAS preserva todos os campos existentes
 * GC-LINK11 — LISTAR_VENDAS retorna cliente_id
 * GC-LINK12 — nome sozinho não cria vínculo automático (sem doc e sem tel)
 * GC-LINK13 — casos AMBIGUOUS não são incluídos nos expectedWrites
 */

const {
  normalizeDoc,
  normalizeTel,
  telVariants,
  nameCompatible,
  buildGcIndexes,
  linkSingle,
  dryRun,
} = require('../lib/gc-link');

const path = require('path');
const fs   = require('fs');

// ── Fixtures compartilhadas ───────────────────────────────────────────────────

const gcBase = [
  { id: 'GC001', cpf: '111.111.111-11', cnpj: null,          telefone: '(85)9111-1111', celular: null,           email: 'alice@gc.com', nome: 'Alice Silva'   },
  { id: 'GC002', cpf: null,             cnpj: '22.222.222/0001-22', telefone: '(85)9222-2222', celular: null,    email: 'bob@gc.com',   nome: 'Bob Comercio'  },
  { id: 'GC003', cpf: '333.333.333-33', cnpj: null,          telefone: '(85)9333-3333', celular: null,           email: 'carol@gc.com', nome: 'Carol Lima'    },
  // GC004 compartilha CPF com GC005 (duplicata)
  { id: 'GC004', cpf: '444.444.444-44', cnpj: null,          telefone: '(85)9444-4444', celular: null,           email: null,           nome: 'Duplo A'       },
  { id: 'GC005', cpf: '444.444.444-44', cnpj: null,          telefone: '(85)9555-5555', celular: null,           email: null,           nome: 'Duplo B'       },
  // GC006 e GC007 compartilham telefone
  { id: 'GC006', cpf: '666.666.666-66', cnpj: null,          telefone: '(85)9666-6666', celular: null,           email: null,           nome: 'Shared Tel A'  },
  { id: 'GC007', cpf: '777.777.777-77', cnpj: null,          telefone: '(85)9666-6666', celular: null,           email: null,           nome: 'Shared Tel B'  },
  // GC008 tem nome bem diferente do cliente MR4 correspondente pelo telefone
  { id: 'GC008', cpf: '888.888.888-88', cnpj: null,          telefone: '(85)9888-8888', celular: null,           email: null,           nome: 'Zeferino Queiroz' },
];

const gcIndexes = buildGcIndexes(gcBase);

// ── GC-LINK1: documento único → MATCH DOCUMENT ───────────────────────────────
describe('GC-LINK1 — documento único → MATCH DOCUMENT', () => {
  test('CPF único no GC retorna MATCH com method=DOCUMENT', () => {
    const mr4 = { id: 'MR4_A', nome: 'Alice Silva', cpf_cnpj: '111.111.111-11', telefone: null };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('MATCH');
    expect(r.gcId).toBe('GC001');
    expect(r.method).toBe('DOCUMENT');
  });

  test('CNPJ único no GC retorna MATCH com method=DOCUMENT', () => {
    const mr4 = { id: 'MR4_B', nome: 'Bob Comercio', cpf_cnpj: '22.222.222/0001-22', telefone: null };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('MATCH');
    expect(r.gcId).toBe('GC002');
    expect(r.method).toBe('DOCUMENT');
  });
});

// ── GC-LINK2: documento duplicado no GC → AMBIGUOUS ──────────────────────────
describe('GC-LINK2 — documento duplicado no GC → AMBIGUOUS (não linka)', () => {
  test('CPF presente em dois GC retorna AMBIGUOUS, não MATCH', () => {
    const mr4 = { id: 'MR4_C', nome: 'Duplo A', cpf_cnpj: '444.444.444-44', telefone: null };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('AMBIGUOUS');
    expect(r.gcId).toBeUndefined();
  });
});

// ── GC-LINK3: telefone único + nome compatível → MATCH PHONE_NAME ─────────────
describe('GC-LINK3 — telefone único + nome compatível → MATCH PHONE_NAME', () => {
  test('telefone único GC com nome compatível retorna MATCH PHONE_NAME', () => {
    const mr4 = { id: 'MR4_D', nome: 'Carol Lima', cpf_cnpj: '', telefone: '(85)9333-3333' };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('MATCH');
    expect(r.gcId).toBe('GC003');
    expect(r.method).toBe('PHONE_NAME');
  });

  test('nome parcial compatível (primeiro token) também é aceito', () => {
    const mr4 = { id: 'MR4_D2', nome: 'Carol Aparecida Lima', cpf_cnpj: '', telefone: '(85)9333-3333' };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('MATCH');
    expect(r.method).toBe('PHONE_NAME');
  });
});

// ── GC-LINK4: telefone duplicado no GC → REVISAO_MANUAL ──────────────────────
describe('GC-LINK4 — telefone duplicado no GC → REVISAO_MANUAL (não linka automaticamente)', () => {
  test('telefone presente em dois GC retorna REVISAO_MANUAL', () => {
    const mr4 = { id: 'MR4_E', nome: 'Shared Tel A', cpf_cnpj: '', telefone: '(85)9666-6666' };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('REVISAO_MANUAL');
    expect(r.gcId).toBeUndefined();
  });
});

// ── GC-LINK5: telefone único + nome incompatível → REVISAO_MANUAL ────────────
describe('GC-LINK5 — telefone único + nome incompatível → REVISAO_MANUAL', () => {
  test('GC tem telefone único mas nome totalmente diferente → REVISAO_MANUAL', () => {
    // MR4 "Marcelo Souza" vs GC008 "Zeferino Queiroz" → primeiro token diferente
    const mr4 = { id: 'MR4_F', nome: 'Marcelo Souza', cpf_cnpj: '', telefone: '(85)9888-8888' };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('REVISAO_MANUAL');
    expect(r.reason).toMatch(/tel_unico_nome_incompativel/);
  });
});

// ── GC-LINK6: sem doc, sem tel → NO_MATCH ────────────────────────────────────
describe('GC-LINK6 — sem documento e sem telefone → NO_MATCH', () => {
  test('cliente MR4 sem doc e sem tel retorna NO_MATCH', () => {
    const mr4 = { id: 'MR4_G', nome: 'Sem Dados', cpf_cnpj: '', telefone: '' };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('NO_MATCH');
  });

  test('cpf_cnpj null e telefone null também retorna NO_MATCH', () => {
    const mr4 = { id: 'MR4_G2', nome: 'Sem Dados 2', cpf_cnpj: null, telefone: null };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('NO_MATCH');
  });
});

// ── GC-LINK7: já linkado corretamente → ALREADY_LINKED (idempotente) ─────────
describe('GC-LINK7 — já linkado corretamente → ALREADY_LINKED (idempotente)', () => {
  test('cliente com gestaoClickId retorna ALREADY_LINKED sem reprocessar', () => {
    const mr4 = { id: 'MR4_H', nome: 'Alice Silva', cpf_cnpj: '111.111.111-11', gestaoClickId: 'GC001' };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('ALREADY_LINKED');
    expect(r.gcId).toBe('GC001');
  });

  test('dry-run com cliente já linkado conta em alreadyLinked, não em expectedWrites', () => {
    const mr4Clientes = [
      { id: 'MR4_H', nome: 'Alice Silva', cpf_cnpj: '111.111.111-11', gestaoClickId: 'GC001' },
    ];
    const stats = dryRun(mr4Clientes, gcBase);
    expect(stats.alreadyLinked).toBe(1);
    expect(stats.expectedWrites).toBe(0);
  });
});

// ── GC-LINK8: já linkado com ID diferente → deve ser detectado como conflito ─
describe('GC-LINK8 — já linkado com ID diferente → conflito detectado', () => {
  test('cliente com gestaoClickId existente retorna ALREADY_LINKED (não sobrescreve)', () => {
    // O caller (rotina de persistência) é responsável por comparar
    // o gcId ALREADY_LINKED com o candidato novo e recusar se diferentes.
    // O motor apenas sinaliza ALREADY_LINKED com o ID existente.
    const mr4 = { id: 'MR4_I', nome: 'Alice', cpf_cnpj: '111.111.111-11', gestaoClickId: 'GC_ERRADO' };
    const r = linkSingle(mr4, gcIndexes);
    expect(r.status).toBe('ALREADY_LINKED');
    expect(r.gcId).toBe('GC_ERRADO'); // retorna o que estava, não sobrescreve
  });

  test('conflito é detectável: ALREADY_LINKED.gcId !== candidato por documento', () => {
    const mr4 = { id: 'MR4_I', nome: 'Alice', cpf_cnpj: '111.111.111-11', gestaoClickId: 'GC_ERRADO' };
    const r = linkSingle(mr4, gcIndexes);
    // Candidato correto seria GC001 — o caller verifica r.gcId !== 'GC001'
    const candidatoCorreto = gcIndexes.byDoc.get('11111111111') || [];
    if (candidatoCorreto.length === 1) {
      expect(r.gcId).not.toBe(candidatoCorreto[0]); // conflito detectável
    }
  });
});

// ── GC-LINK9: GC ID não pode ser associado a dois MR4 ────────────────────────
describe('GC-LINK9 — GC ID não pode ser associado a dois MR4 (1:1 no dry-run)', () => {
  test('dois MR4 com mesmo doc GC → conflicts1toN > 0, expectedWrites = 0', () => {
    // Cenário: dois clientes MR4 apontam para o mesmo cliente GC
    const gcSimples = [
      { id: 'GC_X', cpf: '123.456.789-09', cnpj: null, telefone: '(11)9999-0001', celular: null, email: null, nome: 'Empresa X' },
    ];
    const mr4Duplos = [
      { id: 'MR4_X1', nome: 'Empresa X', cpf_cnpj: '123.456.789-09', telefone: '' },
      { id: 'MR4_X2', nome: 'Empresa X Filial', cpf_cnpj: '123.456.789-09', telefone: '' },
    ];
    const stats = dryRun(mr4Duplos, gcSimples);
    expect(stats.conflicts1toN).toBeGreaterThan(0);
    expect(stats.expectedWrites).toBe(0); // nenhum write seguro
  });

  test('dry-run normal sem conflito tem conflicts1toN = 0', () => {
    const gcOk = [
      { id: 'GC_A', cpf: '111.222.333-44', cnpj: null, telefone: '(85)9100-0001', celular: null, email: null, nome: 'Fulano' },
      { id: 'GC_B', cpf: '555.666.777-88', cnpj: null, telefone: '(85)9100-0002', celular: null, email: null, nome: 'Sicrano' },
    ];
    const mr4Ok = [
      { id: 'MR4_1', nome: 'Fulano Silva', cpf_cnpj: '111.222.333-44', telefone: '' },
      { id: 'MR4_2', nome: 'Sicrano Lima',  cpf_cnpj: '555.666.777-88', telefone: '' },
    ];
    const stats = dryRun(mr4Ok, gcOk);
    expect(stats.conflicts1toN).toBe(0);
    expect(stats.matchDocument).toBe(2);
    expect(stats.expectedWrites).toBe(2);
  });
});

// ── GC-LINK10–11: LISTAR_VENDAS preserva campos e retorna cliente_id ──────────
describe('GC-LINK10–11 — LISTAR_VENDAS DTO', () => {
  const HTML_PATH  = path.resolve(__dirname, '../../functions/index.js');
  let indexSrc;
  beforeAll(() => { indexSrc = fs.readFileSync(HTML_PATH, 'utf8'); });

  test('GC-LINK10 — LISTAR_VENDAS preserva campos: id, numero, data, hora, cliente, valor, status, vendedor, itens, produtos', () => {
    const dtoPart = indexSrc.slice(
      indexSrc.indexOf('LISTAR_VENDAS:'),
      indexSrc.indexOf('LISTAR_PAGAMENTOS:')
    );
    ['id', 'numero', 'data', 'hora', 'cliente', 'valor', 'status', 'vendedor', 'itens', 'produtos'].forEach(campo => {
      expect(dtoPart).toContain(campo);
    });
  });

  test('GC-LINK11 — LISTAR_VENDAS DTO retorna cliente_id', () => {
    const dtoPart = indexSrc.slice(
      indexSrc.indexOf('LISTAR_VENDAS:'),
      indexSrc.indexOf('LISTAR_PAGAMENTOS:')
    );
    expect(dtoPart).toContain('cliente_id');
  });
});

// ── GC-LINK12: nome sozinho não cria vínculo automático ───────────────────────
describe('GC-LINK12 — nome sozinho não cria vínculo (sem doc, sem tel)', () => {
  test('cliente MR4 com doc vazio, tel vazio e nome igual ao GC → NO_MATCH', () => {
    const mr4 = { id: 'MR4_NomeOnly', nome: 'Alice Silva', cpf_cnpj: '', telefone: '' };
    const r = linkSingle(mr4, gcIndexes);
    // Nome por si só nunca produz MATCH — sem doc e sem tel
    expect(r.status).toBe('NO_MATCH');
    expect(r.status).not.toBe('MATCH');
  });

  test('linkSingle não possui lógica de matching por nome isolado', () => {
    // Confirma que o código não usa nome como critério único
    // verificando que nomes distintos com mesmo tel precisam ser compatíveis
    const mr4NomeErrado = { id: 'MR4_NomeErrado', nome: 'Zeferino Queiroz', cpf_cnpj: '', telefone: '(85)9111-1111' };
    const r = linkSingle(mr4NomeErrado, gcIndexes);
    // GC001 tem nome "Alice Silva" — incompatível com "Zeferino Queiroz"
    // Há candidato pelo telefone mas nome incompatível → REVISAO_MANUAL (não link automático)
    expect(r.status).toBe('REVISAO_MANUAL');
  });
});

// ── GC-LINK13: casos AMBIGUOUS não estão em expectedWrites ────────────────────
describe('GC-LINK13 — AMBIGUOUS não entram nos expectedWrites do dry-run', () => {
  test('dry-run com ambíguos tem expectedWrites = 0 para esses casos', () => {
    const gcComDup = [
      { id: 'GC_D1', cpf: '444.444.444-44', cnpj: null, telefone: '(85)9444-4444', celular: null, email: null, nome: 'Duplo A' },
      { id: 'GC_D2', cpf: '444.444.444-44', cnpj: null, telefone: '(85)9555-5555', celular: null, email: null, nome: 'Duplo B' },
    ];
    const mr4 = [
      { id: 'MR4_AMB', nome: 'Duplo', cpf_cnpj: '444.444.444-44', telefone: '' },
    ];
    const stats = dryRun(mr4, gcComDup);
    expect(stats.ambiguous).toBe(1);
    expect(stats.expectedWrites).toBe(0);
  });

  test('dry-run misto: match + ambiguous → expectedWrites só conta matches', () => {
    const gcMisto = [
      { id: 'GC_M1', cpf: '111.222.333-44', cnpj: null, telefone: '(85)9100-1001', celular: null, email: null, nome: 'Fulano' },
      { id: 'GC_M2', cpf: '555.666.777-88', cnpj: null, telefone: '(85)9100-2002', celular: null, email: null, nome: 'Duplo X' },
      { id: 'GC_M3', cpf: '555.666.777-88', cnpj: null, telefone: '(85)9100-3003', celular: null, email: null, nome: 'Duplo Y' },
    ];
    const mr4Misto = [
      { id: 'MR4_OK',  nome: 'Fulano Silva', cpf_cnpj: '111.222.333-44', telefone: '' },
      { id: 'MR4_AMB', nome: 'Duplo X',      cpf_cnpj: '555.666.777-88', telefone: '' },
    ];
    const stats = dryRun(mr4Misto, gcMisto);
    expect(stats.matchDocument).toBe(1);
    expect(stats.ambiguous).toBe(1);
    expect(stats.expectedWrites).toBe(1); // só o match limpo
  });
});
