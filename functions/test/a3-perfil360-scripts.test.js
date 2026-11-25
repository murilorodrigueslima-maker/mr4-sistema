'use strict';
// Etapa A · A3 — os scripts do Perfil 360 usam a camada HTTP única (gcHttp) e não engolem erro de API.
const fs = require('fs'), path = require('path');
const ler = f => fs.readFileSync(path.join(__dirname, '..', '..', 'scripts', f), 'utf8');
describe.each(['incremental360.js', 'bootstrap360.js'])('A3 — %s', f => {
  const src = ler(f);
  test('usa gcHttp.criarCliente e não tem mais o cliente HTTP próprio (https.get / gcRequest)', () => {
    expect(src).toMatch(/require\('\.\.\/functions\/lib\/gcHttp'\)/); expect(src).toMatch(/gcHttp\.criarCliente\(/);
    expect(src).not.toMatch(/https\.get\(/); expect(src).not.toMatch(/function gcRequest/);
  });
  test('falha fatal: erro sanitizado, sem stack/corpo bruto, e sai com código ≠ 0', () => {
    expect(src).not.toMatch(/console\.error\(err\.stack\)/); expect(src).toMatch(/process\.exit\(1\)/);
  });
  test('o cliente exige estrutura de lista válida (nunca devolve lista vazia por resposta inválida)', () => { expect(src).toMatch(/tipo: 'lista'/); });
});
