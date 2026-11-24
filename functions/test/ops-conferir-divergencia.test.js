'use strict';
/** O script de conferência Git × produção é SOMENTE LEITURA e a regra de comparação detecta desvios (caso real de 24/10/2026). */
const fs = require('fs'), path = require('path'), { spawnSync } = require('child_process');
const ROOT = path.resolve(__dirname, '../..'); const SRC = fs.readFileSync(path.join(ROOT, 'scripts/ops/conferir-divergencia.py'), 'utf8');
const py = code => spawnSync('python3', ['-c', `import importlib.util,json;s=importlib.util.spec_from_file_location('c','${path.join(ROOT, 'scripts/ops/conferir-divergencia.py')}');m=importlib.util.module_from_spec(s);s.loader.exec_module(m);${code}`], { encoding: 'utf8' });
test('sintaxe Python válida', () => { expect(py('print(1)').status).toBe(0); });
test('SOMENTE LEITURA: nenhum verbo de escrita/implantação', () => {
  for (const proibido of [/\bdeploy\b/, /\bdelete\b/i, /-X\s*(POST|PUT|PATCH|DELETE)/, /\bset-iam-policy\b/, /update-traffic/, /\bcreate\b/, /secrets versions add/, /gh\s+(workflow|run)\s+(run|disable|enable)/, /--method\s+(POST|PUT|PATCH|DELETE)/])
    expect({ proibido: String(proibido), achou: proibido.test(SRC.replace(/#.*$/gm, '').replace(/"""[\s\S]*?"""/g, '')) }).toEqual({ proibido: String(proibido), achou: false });
});
test('comparar_texto: igual ⇒ (true,0); 9 linhas a mais (caso Compras 24/10) ⇒ (false,9)', () => {
  const r = py(`a="x\\n"*10; b=a+"y\\n"*9; print(json.dumps([m.comparar_texto(a,a), m.comparar_texto(a,b)]))`); expect(r.status).toBe(0);
  const [i, d] = JSON.parse(r.stdout.trim()); expect(i).toEqual([true, 0]); expect(d).toEqual([false, 9]);
});
test('o procedimento obrigatório existe e cita as 5 áreas', () => { const d = fs.readFileSync(path.join(ROOT, 'docs/ops/PROCEDIMENTO-PUBLICACAO-OBRIGATORIO.md'), 'utf8'); for (const t of ['Firestore Rules', 'Functions', 'Hosting', 'workflows', 'Configurações', 'interrompa a publicação']) expect(d).toContain(t); });
