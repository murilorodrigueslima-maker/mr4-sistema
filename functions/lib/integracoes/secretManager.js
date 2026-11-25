'use strict';
/**
 * Acesso RESTRITO ao Secret Manager: só os 3 segredos autorizados (lista fixa — não existe operação genérica por nome).
 * Operações: adicionar versão, listar versões (metadados), desabilitar/habilitar versão (rollback), ler a versão mais recente (somente uso interno
 * em memória para testar conexão/assinar teste — o valor nunca é devolvido ao navegador).
 */
const PROJETO = 'mr4-ponto';
const SEGREDOS = Object.freeze({ GC_ACCESS: 'GC_ACCESS_TOKEN', GC_SECRET: 'GC_SECRET_ACCESS_TOKEN', WEBHOOK: 'GC_WEBHOOK_SECRET' });
const PERMITIDOS = Object.values(SEGREDOS);

async function requisitarGcp({ url, method = 'GET', data }) {
  const { GoogleAuth } = require('google-auth-library');
  const c = await new GoogleAuth({ scopes: ['https://www.googleapis.com/auth/cloud-platform'] }).getClient();
  return c.request({ url, method, data, timeout: 15000 });
}

function criar({ requisitar = requisitarGcp } = {}) {
  const base = nome => { if (!PERMITIDOS.includes(nome)) throw new Error('SEGREDO_NAO_AUTORIZADO'); return `https://secretmanager.googleapis.com/v1/projects/${PROJETO}/secrets/${nome}`; };
  const numero = n => { if (!Number.isInteger(n) || n < 1 || n > 100000) throw new Error('VERSAO_INVALIDA'); return n; };
  return {
    async adicionar(nome, valor) {
      const r = await requisitar({ url: base(nome) + ':addVersion', method: 'POST', data: { payload: { data: Buffer.from(String(valor), 'utf8').toString('base64') } } });
      return Number(String(r.data.name).split('/').pop());
    },
    async versoes(nome) {
      const r = await requisitar({ url: base(nome) + '/versions?pageSize=100', method: 'GET' });
      return ((r.data && r.data.versions) || []).map(v => ({ n: Number(String(v.name).split('/').pop()), estado: v.state, criadaEm: v.createTime })).sort((a, b) => b.n - a.n);
    },
    async desabilitar(nome, n) { await requisitar({ url: base(nome) + `/versions/${numero(n)}:disable`, method: 'POST', data: {} }); },
    async habilitar(nome, n) { await requisitar({ url: base(nome) + `/versions/${numero(n)}:enable`, method: 'POST', data: {} }); },
    async lerUltima(nome) { const r = await requisitar({ url: base(nome) + '/versions/latest:access', method: 'GET' }); return Buffer.from(r.data.payload.data, 'base64').toString('utf8'); },
  };
}
module.exports = { criar, SEGREDOS, PERMITIDOS, requisitarGcp, PROJETO };
