'use strict';
// Varredura de privacidade: termos SINTÉTICOS; a saída nunca mostra o trecho encontrado.
const fs = require('fs'), path = require('path'), os = require('os'), cp = require('child_process');
const V = require('../../scripts/ops/privacidade/varredura.js');

const SCRIPT = path.resolve(__dirname, '../../scripts/ops/privacidade/varredura.js');
// valores montados em tempo de execução para o próprio teste não ser apontado pela varredura
const UID = ['aB3dE5gH7', 'jK9mN1pQ3', 'sT5vW7yZ2x'].join('');
const CPF = ['390', '533', '447'].join('.') + '-' + '05';
const LISTA = { permitidos: ['zulmira-publica\\.github\\.io'], termos: [
  { cat: 'P1', valor: 'zulmira', modo: 'trecho', novo: 'vend1' },
  { cat: 'P3', valor: 'ota', modo: 'palavra', novo: 'colab3' },
  { cat: 'P1_ABREV', valor: 'zul', modo: 'identificador', novo: 'vd1' },
  { cat: 'ID', valor: '4444111', modo: 'numero', novo: '900001' },
] };

function repo(arquivos, excecoes = []) {
  const raiz = fs.mkdtempSync(path.join(os.tmpdir(), 'var-'));
  for (const [n, t] of Object.entries(arquivos)) { fs.mkdirSync(path.dirname(path.join(raiz, n)), { recursive: true }); fs.writeFileSync(path.join(raiz, n), t); }
  cp.execFileSync('git', ['-C', raiz, 'init', '-q']);
  return { raiz, arquivos: Object.keys(arquivos), excecoes };
}
const rodar = (r, extra = {}) => V.analisar({ raiz: r.raiz, arquivos: r.arquivos, excecoes: r.excecoes, lista: LISTA, ...extra });

describe('varredura de privacidade', () => {
  test('acha por trecho (acento/caixa/camelCase), palavra, abreviação e número; respeita contexto público', () => {
    const r = repo({ 'a.js': "const gcZúlmira = 1; // Ota\nconst nota = 'bota';\nif (x['zul']) fOta(); const zulu = 2;\nid='4444111'; h='a4444111b';\nurl='zulmira-publica.github.io'\n" });
    const a = rodar(r).achados.map(x => `${x.linha}:${x.cat}:${x.nivel}`).sort();
    expect(a).toEqual(['1:P1:erro', '1:P3:erro', '3:P1_ABREV:aviso', '3:P3:erro', '4:ID:erro']);
  });
  test('aplicar troca só erros, preserva a caixa e respeita exceções; abreviação exige opção explícita', () => {
    const r = repo({ 'a.js': "Zulmira ZULMIRA zulmira x['zul']\n", 'b.js': 'zulmira\n' }, [{ arquivo: 'b.js', categorias: ['P1'] }]);
    rodar(r, { aplicar: true });
    expect(fs.readFileSync(path.join(r.raiz, 'a.js'), 'utf8')).toBe("Vend1 VEND1 vend1 x['zul']\n");
    expect(fs.readFileSync(path.join(r.raiz, 'b.js'), 'utf8')).toBe('zulmira\n');
    rodar(r, { aplicar: true, incluirAvisos: true });
    expect(fs.readFileSync(path.join(r.raiz, 'a.js'), 'utf8')).toBe("Vend1 VEND1 vend1 x['vd1']\n");
  });
  test('checagens estruturais funcionam sem lista e ignoram valores sintéticos', () => {
    const r = repo({ 'a.js': `u='${UID}';\nc='${CPF}';\ns='UidSinteticoA000000000000000'; f='111.111.111-11'; m='x@exemplo.test'\n` });
    const a = V.analisar({ raiz: r.raiz, arquivos: r.arquivos, excecoes: [], lista: null }).achados.map(x => `${x.linha}:${x.cat}`);
    expect(a.sort()).toEqual(['1:UID_APARENTE', '2:CPF_VALIDO']);
  });
  test('linha de comando: nunca imprime o trecho; código 1 com erro; recusa lista dentro do repositório', () => {
    const r = repo({ 'a.js': 'zulmira 4444111\n' });
    const fora = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'lst-')), 'termos.json'); fs.writeFileSync(fora, JSON.stringify(LISTA));
    const x = cp.spawnSync('node', [SCRIPT, '--raiz', r.raiz, '--termos', fora], { encoding: 'utf8' });
    expect(x.status).toBe(1); expect(x.stdout).toMatch(/a\.js\s+P1\s+linhas 1/); expect(x.stdout + x.stderr).not.toMatch(/zulmira|4444111/i);
    const dentro = path.join(r.raiz, 'termos.json'); fs.writeFileSync(dentro, JSON.stringify(LISTA));
    expect(cp.spawnSync('node', [SCRIPT, '--raiz', r.raiz, '--termos', dentro], { encoding: 'utf8' }).status).toBe(2);
  });
  test('antes do push: aponta commit com termo em mensagem ou linha adicionada, mesmo já removido', () => {
    const r = repo({ 'a.js': 'ok\n' });
    const g = (...a) => cp.execFileSync('git', ['-C', r.raiz, '-c', 'user.name=t', '-c', 'user.email=t@x.test', ...a]);
    const grava = (texto, msg) => { fs.writeFileSync(path.join(r.raiz, 'a.js'), texto); g('add', 'a.js'); g('commit', '-q', '-m', msg); };
    grava('ok\n', 'base'); grava('zulmira\n', 'inclui'); grava('ok\n', 'remove de Zulmira');
    const a = V.analisarCommits({ raiz: r.raiz, faixa: 'HEAD~2..HEAD', lista: LISTA });
    expect(a.map(x => x.onde).sort()).toEqual(['linhas adicionadas', 'mensagem']);
    expect(JSON.stringify(a)).not.toMatch(/zulmira/i);
  });
  test('o repositório passa nas checagens estruturais e não tem segredos', () => {
    const x = cp.spawnSync('node', [SCRIPT, '--json', '--termos', path.join(os.tmpdir(), 'inexistente-' + process.pid + '.json')], { encoding: 'utf8' });
    expect(x.status).toBe(2);                                                       // lista pedida e ausente: erro explícito
    const s = cp.spawnSync('node', [SCRIPT, '--json'], { encoding: 'utf8', env: { ...process.env, HOME: os.tmpdir(), MR4_TERMOS_PRIVADOS: '' } });
    expect(JSON.parse(s.stdout).erros).toEqual([]); expect(s.status).toBe(0);
  });
});

describe('pré-condição do mapeamento do painel (dados sintéticos)', () => {
  const C = require('../../scripts/ops/privacidade/conferir-config.js');
  const { validar } = require('../scripts/painel_mapeamento');
  const mapa = { '900001': { chave: 'vend1', nomeConfig: 'Vend1' }, '900002': { chave: 'vend2', nomeConfig: 'Vend2' } };
  test('só libera quando o documento existe e preserva ids, chaves e ordem anteriores', () => {
    expect(C.avaliar(mapa, { vendedores: mapa }).podePublicar).toBe(true);
    expect(C.avaliar(null, { vendedores: mapa }).podePublicar).toBe(false);
    expect(C.avaliar({ '900001': mapa['900001'] }, { vendedores: mapa }).podePublicar).toBe(false);
    expect(C.simples({ mapValue: { fields: { a: { stringValue: 'x' }, n: { integerValue: '2' } } } })).toEqual({ a: 'x', n: 2 });
  });
  test('carga do mapeamento vem de arquivo privado e é validada', () => {
    expect(validar({ vendedores: mapa })).toEqual([]);
    expect(validar({})).toContain('SEM_VENDEDORES');
    expect(validar({ vendedores: { abc: { chave: 'vend1' } } })).toEqual(['VENDEDOR_ID_INVALIDO', 'ENTRADA_INCOMPLETA']);
  });
});

describe('classificarM5: candidatos por configuração', () => {
  const V1 = require('../lib/carteiraV1');
  test('devolve CANDIDATE_<CHAVE> só quando última venda e predominante são o mesmo candidato', () => {
    const base = { ultimaData: '2026-10-01', lastSaleSeller: '900002', predominantSeller: '900002', legacySeller: '900009' };
    const opt = { candidatos: { vend1: '900001', vend2: '900002' }, referenceDate: '2026-10-10' };
    expect(V1.classificarM5(base, opt)).toBe('CANDIDATE_VEND2');
    expect(V1.classificarM5({ ...base, lastSaleSeller: '900001' }, opt)).toBe('MANUAL_REVIEW');
    expect(V1.classificarM5(base, { referenceDate: '2026-10-10' })).toBe('MANUAL_REVIEW');
    expect(V1.classificarM5({ ...base, lastSaleSeller: '900009', predominantSeller: '900009' }, opt)).toBe('KEEP');
  });
});
