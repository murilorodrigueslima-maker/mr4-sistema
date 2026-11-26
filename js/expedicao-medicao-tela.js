// MR4 — Expedição · painel de medição (carregado só quando o gestor abre; leituras SOMENTE ao clicar em "Calcular").
// Cálculo em js/expedicao-medicao-core.js (o mesmo do relatório semanal). Aqui: consultas ao Firestore e a janela.
import { collection, doc, query, where, limit, getDocs, runTransaction, serverTimestamp, Timestamp }
  from 'https://www.gstatic.com/firebasejs/10.12.0/firebase-firestore.js';

const M = window.ExpedicaoMedicao;
const COL = 'expedicao_pedidos';
const TETO_PEDIDOS = 1500;                 // trava de custo
const cacheTrilha = new Map();             // numero:versao → eventos (a trilha só muda quando a versão muda)

async function emParalelo(itens, n, fn) {
  const saida = new Array(itens.length); let i = 0;
  await Promise.all(Array.from({ length: Math.min(n, itens.length) }, async () => { while (i < itens.length) { const k = i++; saida[k] = await fn(itens[k]); } }));
  return saida;
}

/** Lê só o necessário para o período e calcula. Devolve { resultado, leituras }. */
export async function calcularPeriodo(db, nomePeriodo, ativos, agoraMs = Date.now()) {
  const p = M.periodo(nomePeriodo, agoraMs);
  let leituras = 0;
  const buscar = async q => { const s = await getDocs(q); leituras += Math.max(1, s.size); return s.docs.map(d => d.data()); };
  // todo pedido com algum clique (ou criado) desde o início do período tem movidoEm >= início
  const pedidos = await buscar(query(collection(db, COL), where('movidoEm', '>=', p.inicioMs), limit(TETO_PEDIDOS + 1)));
  if (pedidos.length > TETO_PEDIDOS) throw new Error('PERIODO_GRANDE');
  const eventos = (await emParalelo(pedidos.filter(x => Number(x.versao) >= 1), 20, async x => {
    const chave = x.numero + ':' + x.versao;
    if (!cacheTrilha.has(chave)) cacheTrilha.set(chave, await buscar(query(collection(db, COL, String(x.numero), 'eventos'), where('versao', '>=', 1))));
    return cacheTrilha.get(chave);
  })).flat();
  // registros opcionais: se as Rules novas ainda não estiverem publicadas, o painel segue sem eles
  let registros = [], semRegistros = false;
  try { registros = await buscar(query(collection(db, M.COL_REGISTROS), where('em', '>=', Timestamp.fromMillis(p.inicioMs)))); }
  catch (e) { if (e.code !== 'permission-denied') throw e; semRegistros = true; }
  const resultado = M.calcular({ pedidos, eventos, registros, ativos, inicioMs: p.inicioMs, fimMs: p.fimMs, agoraMs });
  return { resultado, leituras, semRegistros };
}

/** Liga/desliga a captura opcional (as Rules só aceitam gestor). */
export function definirCaptura(db, uid, ativa) {
  const ref = doc(db, M.CFG_DOC.colecao, M.CFG_DOC.id);
  return runTransaction(db, async t => { t.set(ref, { ativa: ativa === true, atualizadoEm: serverTimestamp(), atualizadoPor: uid }); });
}

/** Liga os controles da janela (o HTML fica em modulos/expedicao.html). Idempotente. */
export function montar({ db, uid, ativos, captura }) {
  const el = id => document.getElementById(id);
  let ultimo = null;
  let confirmar = false;                   // ligar/desligar vale para toda a expedição: exige um segundo clique
  const mostrarCaptura = () => {
    const on = captura(); confirmar = false;
    el('medCapturaEstado').textContent = on ? 'LIGADA' : 'DESLIGADA';
    el('medCapturaBotao').textContent = on ? 'Desligar' : 'Ligar';
  };
  mostrarCaptura();
  el('medCalcular').onclick = async () => {
    const b = el('medCalcular'); b.disabled = true; b.textContent = 'Calculando…';
    el('medCopiar').disabled = true; el('medSaida').textContent = ''; el('medCusto').textContent = '';
    try {
      const r = await calcularPeriodo(db, el('medPeriodo').value, ativos());
      ultimo = r.resultado;
      el('medSaida').innerHTML = M.paraHtml(ultimo);
      el('medCusto').textContent = r.leituras + ' leituras' + (r.semRegistros ? ' · registros opcionais indisponíveis' : '');
      el('medCopiar').disabled = false;
    } catch (e) {
      el('medSaida').textContent = e.message === 'PERIODO_GRANDE' ? 'Período grande demais para o painel. Use o relatório semanal.' : 'Não foi possível calcular agora. Nada foi alterado.';
    } finally { b.disabled = false; b.textContent = 'Calcular'; }
  };
  el('medCopiar').onclick = async () => {
    try { await navigator.clipboard.writeText(M.paraMarkdown(ultimo)); el('medCusto').textContent = 'Relatório copiado.'; }
    catch (e) { el('medCusto').textContent = 'O navegador não permitiu copiar.'; }
  };
  el('medCapturaBotao').onclick = async () => {
    const b = el('medCapturaBotao'), ligar = !captura();
    if (!confirmar) { confirmar = true; b.textContent = ligar ? 'Confirmar: ligar para toda a expedição' : 'Confirmar: desligar'; return; }
    confirmar = false; b.disabled = true;
    try { await definirCaptura(db, uid, ligar); }
    catch (e) { mostrarCaptura(); el('medCusto').textContent = 'Não foi possível mudar a configuração.'; }
    finally { b.disabled = false; }   // o estado na tela é atualizado pelo listener da configuração
  };
  return { mostrarCaptura };
}
