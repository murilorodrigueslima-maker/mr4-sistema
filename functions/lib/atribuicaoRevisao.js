'use strict';
// COM-03 — revisão humana da atribuição comercial: callable `crmAtribuicaoRevisao` { acao: 'listar' | 'decidir' }.
// A lista é gerada NA HORA a partir dos dados (interacoes_fila + vendas_gc), pela mesma regra de conversaoComercial.js.
// A única coisa gravada é a decisão do gestor: crm_atribuicao_revisoes/{vendaId} (+ versoes/{n}, append-only) e audit_log.
// NÃO altera comissão, meta, carteira, fila, venda ou atendimento.
//
// Segurança (servidor): login + gestão (carteiraOwnership.autorizarRevisor: role gestor ou módulo fila-comercial-gestao; nunca
// vendedor); quem fez o contato não decide o próprio caso; payload estrito; Rules negam qualquer acesso direto à coleção.

const { HttpsError } = require('firebase-functions/v2/https');
const C = require('./conversaoComercial');
const OWN = require('./carteiraOwnership');
const A = require('./auditoria');
const { diaComercial } = require('./crmTimeline');
const { normalizeGestaoClickId } = require('./commercialIdentity');
const { sanitizeCommercialDisplayName } = require('./nomeExibicao');

const COLL = 'crm_atribuicao_revisoes';
const SCHEMA = 'atribuicao-revisao-v1';
const DECISOES = Object.freeze(['COMPROVADA', 'PROVAVEL', 'NAO_ATRIBUIDA']);
const PERMITIDOS = Object.freeze({
  listar: ['acao', 'janelaDias'],
  decidir: ['acao', 'janelaDias', 'vendaId', 'opportunityInstanceId', 'decisao', 'observacao', 'revisaoVista', 'requestId'],
});
const OBS_MIN = 3, OBS_MAX = 500, MAX_ITENS = 8, MAX_IN = 30, LOJA = '262759';
const CAMPOS_VENDA = ['id', 'cliente_id', 'data', 'nome_situacao', 'valor_total', 'vendedor_id', 'nome_vendedor', 'cadastrado_em', 'produtos', 'loja_id'];
const REQUEST_ID_RE = /^[A-Za-z0-9_-]{8,64}$/;

const somarDias = (ymd, n) => { const d = new Date(ymd + 'T12:00:00Z'); d.setUTCDate(d.getUTCDate() + n); return d.toISOString().slice(0, 10); };
const daLoja = v => v.loja_id === undefined || v.loja_id === null || v.loja_id === '' || String(v.loja_id) === LOJA;
const emLotes = (l, n = MAX_IN) => { const out = []; for (let i = 0; i < l.length; i += n) out.push(l.slice(i, i + n)); return out; };
const exigir = (cond, codigo, msg) => { if (!cond) throw new HttpsError(codigo, msg); };
/** Último dia com vendas completas = ontem (fuso comercial). Mesmo padrão do script de medição. */
const corteDe = agoraIso => somarDias(diaComercial(agoraIso), -1);

// ── Leitura ─────────────────────────────────────────────────────────────────────────────────────────────────────
const dadosDe = snap => snap.docs.map(d => ({ id: d.id, ...d.data() }));

async function porIds(store, colecao, ids) {
  const out = new Map();
  for (const lote of emLotes([...new Set(ids)], 100)) {
    const snaps = await store.getAll(...lote.map(id => store.collection(colecao).doc(id)));
    snaps.forEach((s, i) => { if (s.exists) out.set(lote[i], s.data()); });
  }
  return out;
}

/** Cadastros MR4 → ID GC, para as entidades MR4_LINKED presentes nos atendimentos. */
async function vinculos(store, estados) {
  const ids = [...new Set(estados.map(e => String(e.commercialEntityId || '')).filter(e => e.startsWith('MR4_LINKED:')))].map(e => e.slice(11));
  const cadastros = await porIds(store, 'clientes', ids);
  const gcIdPorEntidade = {};
  for (const [id, d] of cadastros) if (d.gestaoClickId != null) gcIdPorEntidade['MR4_LINKED:' + id] = String(d.gestaoClickId);
  return { gcIdPorEntidade, cadastros };
}

async function usuariosDoSistema(store) {
  const snap = await store.collection('sistema_usuarios').get();
  const nomePorUid = {}, vendedorGcPorUid = {};
  for (const d of snap.docs) {
    const x = d.data();
    nomePorUid[d.id] = String(x.nome || '').trim() || 'Usuário sem nome';
    const gc = x.carteiraComercial && x.carteiraComercial.gestaoClickVendedorId;
    if (gc) vendedorGcPorUid[d.id] = String(gc);
  }
  return { nomePorUid, vendedorGcPorUid };
}

async function devolucoesDe(store) {
  const m = new Map();
  for (const d of (await store.collection('carteira_comercial_devolucoes').get()).docs) { const x = d.data(); if (m.get(String(x.vendaId)) !== 'TOTAL') m.set(String(x.vendaId), x.tipo); }
  return m;
}

function calcular({ estados, vendas, devolucoes, gcIdPorEntidade, vendedorGcPorUid, janelaDias, dataCorte }) {
  return C.calcularFunil({ estados, vendas: vendas.filter(daLoja), devolucoes, gcIdPorEntidade, vendedorGcPorUid, opcoes: { dataCorte, janelaDias } });
}

// ── Montagem do contexto de cada caso (somente exibição para a gestão) ──────────────────────────────────────────
const horaBR = iso => new Intl.DateTimeFormat('pt-BR', { timeZone: 'America/Fortaleza', hour: '2-digit', minute: '2-digit' }).format(new Date(iso));
const horaDoCadastro = v => (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}/.test(String(v || '')) ? String(v).slice(11, 16) : null);

function nomeDoCliente(estadosDoCliente, cadastros, gc) {
  for (const e of estadosDoCliente) { const n = e.nomeCliente && sanitizeCommercialDisplayName(e.nomeCliente); if (n && n !== 'Cliente') return n; }
  for (const e of estadosDoCliente) {
    const id = String(e.commercialEntityId || '');
    const cad = id.startsWith('MR4_LINKED:') ? cadastros.get(id.slice(11)) : null;
    const n = cad && sanitizeCommercialDisplayName(cad.nome || cad.razao_social || '');
    if (n && n !== 'Cliente') return n;
  }
  return 'Cliente GC ' + gc;
}

/** Notas privadas dos resultados exibidos (id determinístico opp__índice). A gestão já pode lê-las no Cliente 360. */
async function notasDe(store, estados) {
  const pedidos = [];
  for (const e of estados) (e.eventos || []).forEach((x, i) => { if (x && x.tipo === 'OUTCOME_REGISTERED' && x.meta && x.meta.temNota === true) pedidos.push(`${e.opportunityInstanceId}__${i}`); });
  const docs = pedidos.length ? await porIds(store, 'crm_notas_privadas', pedidos) : new Map();
  return new Map([...docs].filter(([, n]) => typeof n.texto === 'string').map(([k, n]) => [k, n.texto]));
}

function contatosParaExibir(estados, notas, nomePorUid) {
  const out = [];
  for (const e of estados) {
    const porEm = new Map(C.contatosDaOportunidade(e).map(c => [c.em, c]));
    (e.eventos || []).forEach((x, i) => {
      if (!x || x.tipo !== 'OUTCOME_REGISTERED') return;
      const c = porEm.get(x.timestamp); if (!c) return;
      const inicio = new Date(c.ancoraMs).toISOString();
      out.push({ opportunityInstanceId: e.opportunityInstanceId, dia: c.dia, horaInicio: inicio !== new Date(x.timestamp).toISOString() ? horaBR(inicio) : null,
        diaRegistro: diaComercial(x.timestamp), horaRegistro: horaBR(x.timestamp), resultado: x.outcome, por: nomePorUid[x.operadorId] || 'Vendedor não identificado',
        interesse: c.interesse, proposta: c.proposta, retornoEm: (x.meta && x.meta.scheduledFor) || null, observacao: notas.get(`${e.opportunityInstanceId}__${i}`) || null, em: x.timestamp });
    });
  }
  return out.sort((a, b) => (a.em < b.em ? -1 : 1)).map(({ em, ...resto }) => resto);
}

const itensDaVenda = v => (Array.isArray(v && v.produtos) ? v.produtos : []).map(p => ({ nome: String((p && p.nome_produto) || '').trim(), quantidade: Number(p && p.quantidade) || 0 })).filter(p => p.nome);

function decisaoParaExibir(d, nomePorUid) {
  return d ? { decisao: d.decisao, observacao: d.observacao, revisao: d.revisao, em: d.decididoEm, por: nomePorUid[d.decididoPorUid] || 'Gestão', opportunityInstanceId: d.opportunityInstanceId } : null;
}

async function listar(store, { janelaDias, agoraIso }) {
  const dataCorte = corteDe(agoraIso);
  const estados = (await store.collection('interacoes_fila').get()).docs.map(d => d.data());
  const primeiro = estados.flatMap(e => C.contatosDaOportunidade(e).map(c => c.dia)).sort()[0] || null;
  const [vendas, devolucoes, { gcIdPorEntidade, cadastros }, { nomePorUid, vendedorGcPorUid }, revisoesSnap] = await Promise.all([
    // só pedidos a partir do 1º contato registrado: anteriores nunca entram na janela
    primeiro ? store.collection('vendas_gc').where('data', '>=', primeiro).select(...CAMPOS_VENDA).get().then(dadosDe) : Promise.resolve([]),
    devolucoesDe(store), vinculos(store, estados), usuariosDoSistema(store), store.collection(COLL).get(),
  ]);
  const revisoes = new Map(revisoesSnap.docs.map(d => [d.id, d.data()]));
  const f = calcular({ estados, vendas, devolucoes, gcIdPorEntidade, vendedorGcPorUid, janelaDias, dataCorte });
  const casos = f.evidencia.casos;
  const ambiguos = new Map(C.casosAmbiguos(casos).map(k => [k.vendaId, k]));

  const gcDe = e => { const id = String(e.commercialEntityId || ''); return normalizeGestaoClickId(id.startsWith('GC_NATIVE:') ? id.slice(10) : gcIdPorEntidade[id]); };
  const porGc = new Map();
  for (const e of estados) { const gc = gcDe(e); if (!gc) continue; if (!porGc.has(gc)) porGc.set(gc, []); porGc.get(gc).push(e); }
  const envolvidos = [...new Set(casos.map(k => k.gc))];
  const notas = await notasDe(store, envolvidos.flatMap(gc => porGc.get(gc) || []));
  const vendaPorId = new Map(vendas.map(v => [String(v.id), v]));
  const nomeVendedorGc = {};
  for (const v of vendas) if (v.vendedor_id && v.nome_vendedor) nomeVendedorGc[String(v.vendedor_id)] = String(v.nome_vendedor);

  const itens = casos.map(k => {
    const v = vendaPorId.get(k.vendaId) || {}, amb = ambiguos.get(k.vendaId) || null, doCliente = porGc.get(k.gc) || [];
    const contatos = contatosParaExibir(doCliente, notas, nomePorUid);
    const desde = somarDias(k.contatoDia, -janelaDias), ate = somarDias(k.data, janelaDias);
    const produtos = itensDaVenda(v);
    return {
      vendaId: k.vendaId, opportunityInstanceId: k.opp, tipoOportunidade: k.tipo,
      cliente: nomeDoCliente(doCliente, cadastros, k.gc), clienteGcId: k.gc,
      pedido: { data: k.data, hora: horaDoCadastro(v.cadastrado_em), valor: k.valor, concluido: k.concluida, situacao: v.nome_situacao || null,
        motivoNaoConcluido: k.concluida ? null : k.situacao, vendedor: v.nome_vendedor || 'sem vendedor no pedido', itens: produtos.slice(0, MAX_ITENS), totalItens: produtos.length },
      contato: { dia: k.contatoDia, resultado: k.contatoOutcome, por: nomePorUid[k.operadorId] || 'Vendedor não identificado', diasAntesDoPedido: k.diasAposContato },
      sistema: { nivel: k.nivel, motivo: k.motivo, sinais: k.sinais },
      // fila de revisão: casos ambíguos + "com evidência declarada" (a declaração do próprio vendedor ainda não é comprovação)
      precisaRevisao: !!amb || k.nivel === C.NIVEIS.ATRIBUIDA,
      prioridade: amb ? amb.prioridade : k.nivel === C.NIVEIS.ATRIBUIDA ? 1 : null,
      pergunta: amb ? amb.pergunta : k.nivel === C.NIVEIS.ATRIBUIDA ? 'Há interesse ou proposta declarados: você confirma que este pedido veio do contato?' : null,
      contatos,
      outrosPedidos: vendas.filter(o => normalizeGestaoClickId(o.cliente_id) === k.gc && String(o.id) !== k.vendaId && o.data >= desde && o.data <= ate && daLoja(o))
        .sort((a, b) => (a.data < b.data ? -1 : 1)).map(o => ({ vendaId: String(o.id), data: o.data, valor: Number(o.valor_total) || 0, situacao: o.nome_situacao || null, vendedor: o.nome_vendedor || null })),
      revisao: decisaoParaExibir(revisoes.get(k.vendaId), nomePorUid),
    };
  });
  // mesma ordem da lista de ambíguos (prioridade, motivo, valor); os demais ao final
  const ordem = new Map([...ambiguos.keys()].map((id, i) => [id, i]));
  itens.sort((a, b) => ((a.prioridade || 9) - (b.prioridade || 9)) || ((ordem.has(a.vendaId) ? ordem.get(a.vendaId) : 1e9) - (ordem.has(b.vendaId) ? ordem.get(b.vendaId) : 1e9)) || (a.vendaId < b.vendaId ? -1 : 1));
  return {
    geradoEm: agoraIso, dataCorte, janelaDias, primeiroContato: primeiro,
    devolucaoRegistrada: devolucoes.size > 0,
    // denominador das taxas: oportunidades com vínculo GC, o cliente respondeu e a janela já se encerrou
    base: f.coorte.filter(x => x.base).map(x => x.opp),
    casos: itens,
  };
}

// ── Decisão ─────────────────────────────────────────────────────────────────────────────────────────────────────
/** Reclassifica SÓ o cliente do caso (nunca confia no navegador) e devolve o caso atual do pedido. */
async function casoAtual(store, { vendaId, opportunityInstanceId, janelaDias, agoraIso }) {
  const [sv, se] = await Promise.all([store.collection('vendas_gc').doc(vendaId).get(), store.collection('interacoes_fila').doc(opportunityInstanceId).get()]);
  exigir(sv.exists, 'not-found', 'PEDIDO_INEXISTENTE_NO_ESPELHO');
  exigir(se.exists, 'not-found', 'OPORTUNIDADE_INEXISTENTE');
  const gc = normalizeGestaoClickId(sv.data().cliente_id);
  exigir(gc, 'failed-precondition', 'PEDIDO_SEM_CLIENTE');
  const col = store.collection('clientes');
  const consultas = [col.where('gestaoClickId', '==', gc).get()];
  if (/^\d+$/.test(gc)) consultas.push(col.where('gestaoClickId', '==', Number(gc)).get());
  const entidades = new Set(['GC_NATIVE:' + gc]);
  for (const s of await Promise.all(consultas)) for (const d of s.docs) entidades.add('MR4_LINKED:' + d.id);
  const estados = [];
  for (const lote of emLotes([...entidades])) estados.push(...(await store.collection('interacoes_fila').where('commercialEntityId', 'in', lote).get()).docs.map(d => d.data()));
  const vendasCol = store.collection('vendas_gc');
  const qv = [vendasCol.where('cliente_id', '==', gc).select(...CAMPOS_VENDA).get()];
  if (/^\d+$/.test(gc)) qv.push(vendasCol.where('cliente_id', '==', Number(gc)).select(...CAMPOS_VENDA).get());
  const vendas = (await Promise.all(qv)).flatMap(dadosDe);
  const gcIdPorEntidade = Object.fromEntries([...entidades].filter(e => e.startsWith('MR4_LINKED:')).map(e => [e, gc]));
  const [devolucoes, { vendedorGcPorUid, nomePorUid }] = await Promise.all([devolucoesDe(store), usuariosDoSistema(store)]);
  const f = calcular({ estados, vendas, devolucoes, gcIdPorEntidade, vendedorGcPorUid, janelaDias, dataCorte: corteDe(agoraIso) });
  const caso = f.evidencia.casos.find(k => k.vendaId === vendaId);
  exigir(caso, 'failed-precondition', 'PEDIDO_SEM_CONTATO_RELACIONADO');
  exigir(caso.opp === opportunityInstanceId, 'aborted', 'CASO_MUDOU: atualize a lista antes de decidir.');
  return { caso, nomePorUid };
}

async function decidir(store, FieldValue, p) {
  const { uid, papel, janelaDias, agoraIso, vendaId, opportunityInstanceId, decisao, observacao, revisaoVista, requestId } = p;
  exigir(/^\d{1,20}$/.test(String(vendaId || '')), 'invalid-argument', 'vendaId inválido');
  exigir(/^[0-9a-f]{16}$/.test(String(opportunityInstanceId || '')), 'invalid-argument', 'opportunityInstanceId inválido');
  exigir(DECISOES.includes(decisao), 'invalid-argument', 'decisao deve ser COMPROVADA, PROVAVEL ou NAO_ATRIBUIDA');
  const texto = typeof observacao === 'string' ? observacao.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F]/g, '').trim() : '';
  const n = Array.from(texto).length;
  exigir(n >= OBS_MIN && n <= OBS_MAX, 'invalid-argument', `observacao obrigatória (${OBS_MIN} a ${OBS_MAX} caracteres)`);
  exigir(Number.isInteger(revisaoVista) && revisaoVista >= 0, 'invalid-argument', 'revisaoVista inválida');
  exigir(typeof requestId === 'string' && REQUEST_ID_RE.test(requestId), 'invalid-argument', 'requestId inválido (8–64 caracteres [A-Za-z0-9_-]).');

  const ref = store.collection(COLL).doc(String(vendaId));
  // repetição do mesmo pedido de gravação (rede instável): devolve o que já foi gravado, sem reclassificar
  const anteriorVersao = await ref.collection('versoes').where('requestId', '==', requestId).limit(1).get();
  if (!anteriorVersao.empty) {
    const v = anteriorVersao.docs[0].data();
    exigir(v.decididoPorUid === uid && v.decisao === decisao && v.observacao === texto, 'already-exists', 'requestId já usado em outra decisão');
    const nomes = (await usuariosDoSistema(store)).nomePorUid;
    return { repetido: true, revisao: decisaoParaExibir(v, nomes) };
  }

  const { caso, nomePorUid } = await casoAtual(store, { vendaId: String(vendaId), opportunityInstanceId, janelaDias, agoraIso });
  exigir(caso.operadorId !== uid, 'permission-denied', 'Quem fez o contato não pode decidir o próprio caso.');
  const ator = await A.enriquecerAtor(store, { uid, type: 'USER', origin: 'CALLABLE_AUTH' });

  let gravado, repetido;
  await store.runTransaction(async tx => {
    repetido = false;
    const atual = await tx.get(ref);
    const antes = atual.exists ? atual.data() : null;
    // o mesmo envio chegando duas vezes ao mesmo tempo: a segunda vê a primeira já gravada
    if (antes && antes.requestId === requestId && antes.decididoPorUid === uid && antes.decisao === decisao && antes.observacao === texto) { gravado = antes; repetido = true; return; }
    exigir((antes ? antes.revisao : 0) === revisaoVista, 'aborted', 'DECISAO_JA_ALTERADA: atualize a lista antes de decidir.');
    const revisao = revisaoVista + 1;
    gravado = {
      schemaVersion: SCHEMA, vendaId: String(vendaId), opportunityInstanceId, decisao, observacao: texto, revisao,
      decididoPorUid: uid, decididoPorPapel: papel, decididoEm: agoraIso, requestId,
      // classificação da regra no momento da decisão, recalculada no servidor (sem nomes)
      retrato: { nivelSistema: caso.nivel, motivoSistema: caso.motivo, janelaDias, dataPedido: caso.data, valor: caso.valor, pedidoConcluido: caso.concluida,
        contatoDia: caso.contatoDia, contatoResultado: caso.contatoOutcome, contatoOperadorUid: caso.operadorId },
    };
    tx.set(ref, gravado);
    tx.create(ref.collection('versoes').doc(String(revisao)), gravado);
    // auditoria NA MESMA transação (append-only; sem o texto da observação)
    tx.create(store.collection(A.COLECAO).doc(`atrib_${vendaId}_${revisao}`), {
      ...A.evento({ ator, action: antes ? 'ATTRIBUTION_REVIEW_CHANGED' : 'ATTRIBUTION_REVIEW_DECIDED', category: A.CATEGORIAS.COMMERCIAL, entityType: COLL, entityId: vendaId,
        source: 'CALLABLE:crmAtribuicaoRevisao', before: antes ? { decisao: antes.decisao, revisao: antes.revisao } : null, after: { decisao, revisao },
        metadata: { opportunityInstanceId, nivelSistema: caso.nivel, motivoSistema: caso.motivo, temObservacao: true, requestId } }),
      at: FieldValue.serverTimestamp(),
    });
  });
  return { repetido, revisao: decisaoParaExibir(gravado, nomePorUid) };
}

// ── Callable ────────────────────────────────────────────────────────────────────────────────────────────────────
async function atribuicaoRevisaoHandler(request, opts = {}) {
  if (!request || !request.auth || !request.auth.uid) throw new HttpsError('unauthenticated', 'Login necessário.');
  const d = request.data;
  if (!d || typeof d !== 'object' || Array.isArray(d) || !Object.prototype.hasOwnProperty.call(PERMITIDOS, d.acao)) throw new HttpsError('invalid-argument', 'ACAO_INVALIDA');
  const extras = Object.keys(d).filter(k => !PERMITIDOS[d.acao].includes(k));
  if (extras.length) throw new HttpsError('invalid-argument', 'CAMPOS_NAO_PERMITIDOS: ' + extras.join(', '));
  const janelaDias = d.janelaDias === undefined ? C.JANELA_PADRAO_DIAS : d.janelaDias;
  exigir(C.JANELAS_SENSIBILIDADE.includes(janelaDias), 'invalid-argument', 'janelaDias deve ser 7, 14 ou 30');
  const admin = require('firebase-admin');
  const store = opts.db || admin.firestore();
  const agoraIso = (opts.now ? opts.now() : new Date()).toISOString();
  const revisor = await OWN.autorizarRevisor(store, request.auth.uid);       // antes de qualquer outra leitura
  if (d.acao === 'listar') return listar(store, { janelaDias, agoraIso });
  // importação modular: no emulador de Functions `admin.firestore.FieldValue` chega indefinido
  return decidir(store, require('firebase-admin/firestore').FieldValue, { ...d, janelaDias, agoraIso, uid: revisor.uid, papel: revisor.papel });
}

module.exports = { atribuicaoRevisaoHandler, COLL, SCHEMA, DECISOES, PERMITIDOS, OBS_MIN, OBS_MAX, corteDe };
