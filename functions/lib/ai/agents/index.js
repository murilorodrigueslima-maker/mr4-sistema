'use strict';
// Registro de agentes ESPECIALIZADOS (fluxo genérico). Cada agente vive em lib/ai/agents/<nome>/index.js e exporta a definição (ver gateway/generic.js).
// Carregamento tolerante: um agente ausente neste branch simplesmente não existe (nenhuma edição compartilhada ao adicionar um agente).
const NOMES = ['inventory', 'purchasing', 'finance'];
const AGENTES = {};
for (const n of NOMES) { let m; try { m = require('./' + n); } catch (e) { if (e && e.code === 'MODULE_NOT_FOUND' && String(e.message).includes('/' + n)) continue; throw e; } const d = m.agente || m; if (d && d.agentType) AGENTES[d.agentType] = d; }
module.exports = { AGENTES, NOMES };
