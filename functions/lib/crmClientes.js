'use strict';
/**
 * S4 — acesso do vendedor ao CRM legado (`clientes`) SEM leitura direta ampla do Firestore.
 *   • clientesMeus  → clientes ligados (gestaoClickId) à carteira_comercial do próprio vendedor (dono oficial = carteira.ownerUid).
 *   • clienteBusca  → pesquisa EXATA e pontual por cpf_cnpj | telefone | email (normalizado, com tamanho mínimo, máx. 5 resultados,
 *                     limite por hora, auditada). Nunca devolve a base nem permite varredura.
 * Dono NÃO é inventado: cliente de carteira de outro vendedor volta só como "ocupado" (sem dados); cliente sem carteira volta com
 * dados mínimos e marcado SEM_CARTEIRA (a titularidade definitiva é Fase B). Notas internas só para o dono da carteira / gestão.
 */
const { HttpsError } = require('firebase-functions/v2/https');
const A = require('./auditoria');

const LIMITE_BUSCAS_HORA = 40;
const MAX_RESULTADOS = 5;
const CAMPOS_BUSCA = ['cpf_cnpj', 'telefone', 'email'];
const CAMPOS_MIN = ['nome', 'nome_fantasia', 'tipo', 'cidade', 'estado', 'pipeline', 'tags', 'followUp', 'segmento'];
const soDigitos = v => String(v == null ? '' : v).replace(/\D/g, '');

/** Formatos em que o dado aparece no cadastro legado (telefone majoritariamente mascarado) — só variantes de UM valor exato. */
function variantes(campo, valor) {
  const v = String(valor == null ? '' : valor).trim();
  if (campo === 'email') { if (!/^[^\s@]+@[^\s@]+\.[^\s@]{2,}$/.test(v) || v.length > 120) return null; const e = v.toLowerCase(); return [...new Set([v, e])]; }
  const d = soDigitos(v);
  if (campo === 'cpf_cnpj') {
    if (d.length === 11) return [d, `${d.slice(0, 3)}.${d.slice(3, 6)}.${d.slice(6, 9)}-${d.slice(9)}`];
    if (d.length === 14) return [d, `${d.slice(0, 2)}.${d.slice(2, 5)}.${d.slice(5, 8)}/${d.slice(8, 12)}-${d.slice(12)}`];
    return null;
  }
  if (campo === 'telefone') {
    const n = d.length >= 12 && d.startsWith('55') ? d.slice(2) : d;                 // aceita +55
    if (n.length === 10) return [n, `(${n.slice(0, 2)}) ${n.slice(2, 6)}-${n.slice(6)}`, `${n.slice(0, 2)} ${n.slice(2, 6)}-${n.slice(6)}`, '55' + n];
    if (n.length === 11) return [n, `(${n.slice(0, 2)}) ${n.slice(2, 7)}-${n.slice(7)}`, `${n.slice(0, 2)} ${n.slice(2, 7)}-${n.slice(7)}`, '55' + n];
    return null;
  }
  return null;
}

function validarPedido(data) {
  if (!data || typeof data !== 'object' || Array.isArray(data)) throw new HttpsError('invalid-argument', 'PAYLOAD_INVALIDO');
  const permitidos = data.acao === 'clienteBusca' ? ['acao', 'campo', 'valor'] : ['acao'];
  if (Object.keys(data).some(k => !permitidos.includes(k))) throw new HttpsError('invalid-argument', 'CAMPOS_NAO_PERMITIDOS');
  if (data.acao === 'clienteBusca') {
    if (!CAMPOS_BUSCA.includes(data.campo)) throw new HttpsError('invalid-argument', 'CAMPO_INVALIDO');
    if (typeof data.valor !== 'string' || data.valor.length > 120 || !variantes(data.campo, data.valor)) throw new HttpsError('invalid-argument', 'VALOR_INVALIDO');
  }
}

async function acessoClientes(store, uid) {
  const [u, s] = await Promise.all([store.collection('users').doc(uid).get(), store.collection('sistema_usuarios').doc(uid).get()]);
  if (!u.exists || !s.exists) throw new HttpsError('permission-denied', 'SEM_PERMISSAO');
  const user = u.data(), sys = s.data();
  if (!user.ativo || !['gestor', 'funcionario'].includes(user.role) || sys.bloqueado === true) throw new HttpsError('permission-denied', 'SEM_PERMISSAO');
  const gestor = user.role === 'gestor';
  if (!gestor && !(Array.isArray(sys.modulos) && sys.modulos.includes('clientes'))) throw new HttpsError('permission-denied', 'SEM_PERMISSAO');
  return { uid, gestor };
}

const iso = v => (v && typeof v.toDate === 'function' ? v.toDate().toISOString() : v == null ? null : v);
function cartao(id, d, { completo, vinculo }) {
  const o = { id, vinculo };
  for (const k of CAMPOS_MIN) o[k] = d[k] === undefined ? null : d[k];
  o.criado_em = iso(d.criado_em); o.ultimoContato = iso(d.ultimoContato);
  if (completo) {                                       // dono da carteira (ou gestão): contato completo + notas/vendas internas
    o.telefone = d.telefone || ''; o.email = d.email || ''; o.cpf_cnpj = d.cpf_cnpj || ''; o.notas = Array.isArray(d.notas) ? d.notas : []; o.vendas = Array.isArray(d.vendas) ? d.vendas : [];
  } else {                                              // sem carteira: dado mínimo p/ identificar e atender; sem notas internas
    o.telefone = d.telefone || ''; o.email = ''; o.cpf_cnpj = d.cpf_cnpj ? '***' + soDigitos(d.cpf_cnpj).slice(-3) : ''; o.notas = []; o.vendas = [];
  }
  return o;
}

async function donoDaCarteira(store, gcId) {
  if (gcId == null || gcId === '') return null;
  const s = await store.collection('carteira_comercial').doc('GC:' + String(gcId)).get();
  return s.exists ? (s.data().ownerUid || null) : null;
}

async function clientesMeus(store, acesso) {
  const out = [];
  if (acesso.gestor) return { escopo: 'GESTAO', clientes: out, aviso: 'Gestão usa a leitura direta.' };
  const cart = await store.collection('carteira_comercial').where('ownerUid', '==', acesso.uid).get();
  const ids = cart.docs.map(d => d.id.replace(/^GC:/, '')).filter(Boolean);
  const vistos = new Set();
  for (let i = 0; i < ids.length; i += 15) {
    const lote = ids.slice(i, i + 15), valores = [...lote, ...lote.filter(x => /^\d+$/.test(x)).map(Number)];
    const snap = await store.collection('clientes').where('gestaoClickId', 'in', valores).get();
    for (const d of snap.docs) if (!vistos.has(d.id) && d.data().arquivado !== true) { vistos.add(d.id); out.push(cartao(d.id, d.data(), { completo: true, vinculo: 'MINHA' })); }
  }
  return { escopo: 'VENDEDOR', clientes: out };
}

async function consumirLimite(store, uid, agoraMs) {
  const ref = store.collection('crm_busca_limite').doc(uid);
  await store.runTransaction(async tx => {
    const s = await tx.get(ref), d = s.exists ? s.data() : null;
    const novaJanela = !d || agoraMs - d.janelaInicioMs >= 3600000;
    const n = novaJanela ? 0 : d.n;
    if (n >= LIMITE_BUSCAS_HORA) throw new HttpsError('resource-exhausted', 'LIMITE_DE_BUSCAS');
    tx.set(ref, { janelaInicioMs: novaJanela ? agoraMs : d.janelaInicioMs, n: n + 1 });
  });
}

async function clienteBusca(store, FieldValue, acesso, { campo, valor }, agoraMs) {
  await consumirLimite(store, acesso.uid, agoraMs);
  const vs = variantes(campo, valor);
  const snap = await store.collection('clientes').where(campo, 'in', vs).limit(MAX_RESULTADOS + 1).get();
  const resultados = []; let ocupados = 0;
  for (const d of snap.docs.slice(0, MAX_RESULTADOS)) {
    const dados = d.data(); if (dados.arquivado === true) continue;
    if (acesso.gestor) { resultados.push(cartao(d.id, dados, { completo: true, vinculo: 'GESTAO' })); continue; }
    const dono = await donoDaCarteira(store, dados.gestaoClickId);
    if (!dono) resultados.push(cartao(d.id, dados, { completo: false, vinculo: 'SEM_CARTEIRA' }));
    else if (dono === acesso.uid) resultados.push(cartao(d.id, dados, { completo: true, vinculo: 'MINHA' }));
    else ocupados++;
  }
  try {                                                  // auditoria S7: quem buscou, por qual campo, hash do termo, quantos achados — nunca o termo
    await A.gravar(store, FieldValue, store.collection('audit_log').doc().id, A.evento({ ator: await A.enriquecerAtor(store, { uid: acesso.uid, type: 'USER', origin: 'CALLABLE_AUTH' }),
      action: 'CRM_CLIENT_SEARCH', category: A.CATEGORIAS.CRM, entityType: 'clientes', entityId: 'busca', source: 'CALLABLE:crmConsulta',
      metadata: { campo, termoHash: A.hashCurto(soDigitos(valor) || valor), resultados: resultados.length, ocupados } }));
  } catch (e) { /* auditoria não bloqueia a busca; falha fica no log da Function */ console.error('[crmClientes] auditoria da busca falhou', e && e.message); }
  return { campo, resultados, ocupadosPorOutroVendedor: ocupados, limitePorHora: LIMITE_BUSCAS_HORA };
}

module.exports = { variantes, validarPedido, acessoClientes, clientesMeus, clienteBusca, consumirLimite, cartao, LIMITE_BUSCAS_HORA, MAX_RESULTADOS };
