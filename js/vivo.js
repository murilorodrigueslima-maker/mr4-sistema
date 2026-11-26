// Atualização automática das telas por LISTENER em UM documento agregado (barato: 1 leitura por mudança).
// - observa só o marcador de atualização; quando muda, chama o carregador JÁ EXISTENTE da tela (filtros e permissões preservados);
// - 1 listener por documento (sem duplicar), cancelado ao sair (pagehide) e pausado com a aba oculta;
// - falha de conexão: reconecta com espera crescente e informa o estado; nunca escreve nada; sem laço (o recarregamento não toca o documento).
const ativos = new Map();
export function observarAtualizacao({ db, fns, colecao, id, marcador, aoMudar, aoStatus = () => {}, aoPrimeira }) {   // aoPrimeira (opcional): marcador da 1ª leitura
  const chave = colecao + '/' + id;
  if (ativos.has(chave)) ativos.get(chave)();                      // sem listeners duplicados
  let unsub = null, parado = false, tent = 0, timer = null, ultimo, recarregando = false, pendente = false;
  const rodar = async () => {
    if (recarregando) { pendente = true; return; }
    recarregando = true;
    try { await aoMudar(); } catch (_) { /* o carregador trata e exibe o próprio erro */ }
    recarregando = false;
    if (pendente) { pendente = false; rodar(); }
  };
  const iniciar = () => {
    if (parado || unsub) return;
    aoStatus('conectando');
    unsub = fns.onSnapshot(fns.doc(db, colecao, id), snap => {
      tent = 0; aoStatus('ao_vivo');
      if (!snap.exists()) { if (aoPrimeira && ultimo === undefined) { ultimo = ''; aoPrimeira(''); } return; }   // com aoPrimeira, a criação do documento conta como mudança
      const m = String(marcador(snap.data()) ?? '');
      if (ultimo === undefined) { ultimo = m; if (aoPrimeira) aoPrimeira(m); return; }             // 1ª leitura = a que a tela já mostra
      if (m !== ultimo) { ultimo = m; rodar(); }
    }, err => {
      unsub = null; aoStatus('reconectando');
      if (err && err.code === 'permission-denied') { aoStatus('sem_permissao'); return; }
      timer = setTimeout(() => { if (!document.hidden) iniciar(); }, [5000, 15000, 60000][Math.min(tent++, 2)]);   // oculta: reassina ao voltar
    });
  };
  const pausarSeOculta = () => { if (parado) return; if (document.hidden) { if (unsub) { unsub(); unsub = null; aoStatus('pausado'); } } else iniciar(); };
  const parar = () => { parado = true; clearTimeout(timer); if (unsub) { unsub(); unsub = null; } document.removeEventListener('visibilitychange', pausarSeOculta); window.removeEventListener('pagehide', parar); ativos.delete(chave); };
  document.addEventListener('visibilitychange', pausarSeOculta); window.addEventListener('pagehide', parar);
  ativos.set(chave, parar); iniciar();
  return parar;
}
export const rotuloStatus = { conectando: '… conectando', ao_vivo: '● ao vivo', reconectando: '⚠ reconectando…', pausado: '⏸ pausado (aba oculta)', sem_permissao: '' };

/** Selo discreto de estado (canto inferior esquerdo) para telas sem lugar próprio. Reaproveita #vivoStatus se existir. */
export function statusPadrao() {
  return st => {
    let el = document.getElementById('vivoStatus');
    if (!el) { el = document.createElement('div'); el.id = 'vivoStatus'; el.setAttribute('aria-live', 'polite'); el.style.cssText = 'position:fixed;left:10px;bottom:8px;z-index:50;font:12px system-ui,sans-serif;color:#64748b;background:rgba(255,255,255,.85);padding:2px 8px;border-radius:10px;pointer-events:none'; document.body.appendChild(el); }
    el.textContent = rotuloStatus[st] || '';
  };
}
