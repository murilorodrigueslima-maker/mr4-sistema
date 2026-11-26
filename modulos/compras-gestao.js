// MR4 Compras — telas de GESTÃO INTERNA: parâmetros por fornecedor, compras pendentes antigas e origem das compras.
// Só desenha o que as Cloud Functions devolvem e envia o que o gestor digitou; toda validação e permissão é do servidor.
// Nada aqui consulta ou altera o GestãoClick, nem muda as sugestões da política vigente.
(function () {
  'use strict';
  const esc = s => String(s ?? '').replace(/[&<>"']/g, c => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
  const num = n => (n === null || n === undefined) ? '—' : Number(n).toLocaleString('pt-BR', { maximumFractionDigits: 3 });
  const brl = c => (c === null || c === undefined) ? '—' : (c / 100).toLocaleString('pt-BR', { style: 'currency', currency: 'BRL' });
  const dia = d => d ? String(d).slice(0, 10).split('-').reverse().join('/') : '—';
  const quando = v => { const d = v ? new Date(v) : null; return d && !Number.isNaN(d.getTime()) ? d.toLocaleString('pt-BR', { dateStyle: 'short', timeStyle: 'short' }) : '—'; };
  const reaisParaCents = t => { const s = String(t).trim().replace(/^R\$\s*/, ''); if (!/^\d{1,3}(\.\d{3})*(,\d{1,2})?$|^\d+([.,]\d{1,2})?$/.test(s)) return NaN; const n = s.includes(',') ? Number(s.replace(/\./g, '').replace(',', '.')) : /^\d{1,3}(\.\d{3})+$/.test(s) ? Number(s.replace(/\./g, '')) : Number(s); return Math.round(n * 100); };
  const centsParaTexto = c => (c / 100).toLocaleString('pt-BR', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

  const CAMPOS = [
    ['prazoMedioDias', 'Prazo médio de entrega (dias)', 'int'], ['prazoMaxDias', 'Prazo máximo observado (dias)', 'int'], ['confiabilidadePrazo', 'Confiabilidade do prazo', [['ALTA', 'Alta'], ['MEDIA', 'Média'], ['BAIXA', 'Baixa']]],
    ['qtdMinima', 'Quantidade mínima por pedido (un)', 'int'], ['valorMinimoCents', 'Valor mínimo do pedido (R$)', 'reais'], ['multiploPadrao', 'Múltiplo de embalagem padrão (un)', 'int'],
    ['frequenciaReposicaoDias', 'Frequência de reposição (a cada N dias)', 'int'], ['condicoesPagamento', 'Condições de pagamento', 'texto'], ['origem', 'Nacional ou importado', [['NACIONAL', 'Nacional'], ['IMPORTADO', 'Importado']]]];
  const STATUS = { PENDENTE: 'Continua pendente', RECEBIDA: 'Recebida', DUPLICADA: 'Duplicada', CANCELADA: 'Cancelada', AGUARDANDO_CONFERENCIA: 'Aguardando conferência' };
  const VEREDITO = { DUPLICIDADE_PROVAVEL: 'Indício: duplicidade provável', ENTRADA_VISTA_NO_SALDO: 'Indício: entrada vista no saldo', SOBRA_COMPATIVEL_NAO_COMPROVA: 'Indício fraco: sobra de saldo compatível (não comprova)', SEM_INDICIO_DE_ENTRADA: 'Sem indício de entrada' };
  const NIVEL = { COMPROVADA_TITULO: 'Comprovada por título', CONFIRMADA_GESTOR: 'Confirmada pela gestão', CONFLITO: 'Conflito: referência divergente', SEM_PROVA: 'Sem comprovação', REJEITADA_GESTOR: 'Recusada pela gestão' };
  const DECISAO = { CONFIRMADA_LOJA: 'É da loja MR4 (liberar)', NAO_PERTENCE: 'Não é da loja MR4 (manter isolada)', VOLTAR_AUTOMATICO: 'Desfazer a decisão manual' };

  const CSS = `
  #painelGestao { font-size: .84rem; } #painelGestao h2 { font-size: 1.1rem; margin-bottom: .2rem; } #painelGestao h4 { font-size: .68rem; text-transform: uppercase; letter-spacing: .4px; color: var(--muted); margin: .8rem 0 .3rem; }
  .cg-sub { color: var(--muted); font-size: .78rem; line-height: 1.5; margin-bottom: .8rem; }
  .cg-card { background: var(--white); border: 1px solid var(--border); border-radius: 10px; padding: .9rem; margin-bottom: .8rem; overflow-wrap: anywhere; }
  .cg-nota { background: var(--white); border: 1px solid var(--border); border-left: 4px solid var(--blue); border-radius: 8px; padding: .6rem .9rem; font-size: .78rem; color: var(--muted); line-height: 1.55; margin-bottom: .8rem; } .cg-nota.warn { border-left-color: var(--yellow); }
  .cg-nota ol { margin: .3rem 0 0 1.1rem; }
  .cg-tit { display: flex; flex-wrap: wrap; gap: .4rem .6rem; align-items: center; } .cg-tit b { font-size: .95rem; }
  .cg-meta { color: var(--muted); font-size: .76rem; margin-top: .25rem; line-height: 1.5; }
  .cg-bd { font-size: .64rem; font-weight: 700; letter-spacing: .3px; padding: .15rem .45rem; border-radius: 4px; background: var(--bg); color: var(--muted); white-space: nowrap; }
  .cg-bd.ok { background: var(--green-bg); color: var(--green); } .cg-bd.at { background: var(--yellow-bg); color: var(--yellow); } .cg-bd.ruim { background: var(--red-bg); color: var(--red); } .cg-bd.man { background: var(--blue-bg); color: var(--blue); } .cg-bd.est { background: var(--purple-bg); color: var(--purple); }
  .cg-bar { display: flex; flex-wrap: wrap; gap: .5rem; margin-bottom: .8rem; align-items: center; }
  #painelGestao input, #painelGestao select, #painelGestao textarea { font: inherit; font-size: .84rem; padding: .45rem .6rem; border: 1px solid var(--border); border-radius: 8px; background: var(--white); color: var(--text); max-width: 100%; }
  #painelGestao textarea { width: 100%; min-height: 3.2rem; resize: vertical; }
  .cg-bar input { flex: 1 1 200px; } .cg-bar select { flex: 2 1 260px; }
  .cg-btn { border: 1px solid var(--blue); background: var(--blue); color: #fff; border-radius: 8px; padding: .5rem 1rem; font: inherit; font-size: .82rem; font-weight: 600; cursor: pointer; } .cg-btn[disabled] { opacity: .6; cursor: default; }
  .cg-mini { border: 1px solid var(--border); background: var(--white); color: var(--blue); border-radius: 6px; padding: .15rem .55rem; font: inherit; font-size: .74rem; font-weight: 600; cursor: pointer; }
  .cg-campo { display: grid; grid-template-columns: minmax(190px, 1.1fr) minmax(170px, 1fr) 86px minmax(220px, 2fr); gap: .35rem .8rem; align-items: center; padding: .55rem 0; border-top: 1px solid var(--border); }
  .cg-campo label { font-weight: 600; } .cg-sug { color: var(--muted); font-size: .73rem; line-height: 1.45; } .cg-sug b { color: var(--text); }
  .cg-rol { overflow-x: auto; } .cg-tab { width: 100%; border-collapse: collapse; font-size: .77rem; font-variant-numeric: tabular-nums; }
  .cg-tab th { font-size: .64rem; text-transform: uppercase; letter-spacing: .3px; color: var(--muted); text-align: right; padding: .3rem .45rem; border-bottom: 1px solid var(--border); }
  .cg-tab td { text-align: right; padding: .35rem .45rem; border-top: 1px solid var(--border); vertical-align: top; } .cg-tab th:first-child, .cg-tab td:first-child, .cg-tab .esq { text-align: left; }
  .cg-tab input { width: 90px; }
  .cg-tab th, .cg-tab td { overflow-wrap: normal; } .cg-tab td:not(:first-child):not(.esq) { white-space: nowrap; } .cg-tab td:first-child { min-width: 135px; } .cg-tab td.esq { min-width: 190px; }
  .cg-form { display: grid; grid-template-columns: minmax(200px, 260px) 1fr auto; gap: .5rem; align-items: start; }
  .cg-msg { font-size: .78rem; margin-top: .4rem; min-height: 1.1rem; } .cg-msg.erro { color: var(--red); } .cg-msg.ok { color: var(--green); }
  .cg-hist { list-style: none; padding: 0; font-size: .74rem; color: var(--muted); } .cg-hist li { border-top: 1px solid var(--border); padding: .3rem 0; }
  .cg-chips { display: grid; grid-template-columns: repeat(auto-fit, minmax(130px, 1fr)); gap: .6rem; margin-bottom: .8rem; }
  .cg-chips div { background: var(--white); border: 1px solid var(--border); border-radius: 10px; padding: .6rem .8rem; } .cg-chips span { display: block; font-size: .66rem; font-weight: 700; color: var(--muted); text-transform: uppercase; } .cg-chips b { font-size: 1.15rem; }
  @media (max-width: 900px) { .cg-campo { grid-template-columns: 1fr auto; } .cg-campo label, .cg-campo .cg-sug { grid-column: 1 / -1; } .cg-form { grid-template-columns: 1fr; } }
  `;

  function mensagemErro(e) {
    const m = String((e && e.message) || '');
    if (e && /permission-denied|unauthenticated/.test(String(e.code))) return 'Sem permissão para esta ação (somente a gestão de Compras).';
    if (/VERSAO_DESATUALIZADA/.test(m)) return 'Outra alteração foi gravada enquanto você editava. Clique em "Recarregar" e refaça.';
    if (e && /invalid-argument|failed-precondition|not-found/.test(String(e.code))) return m.replace(/^[A-Z_]{8,}:\s*/, '') || 'Dados recusados.';
    return 'Não foi possível concluir agora. Tente novamente em instantes.';
  }

  function montar(painel, api) {
    if (!document.getElementById('cg-css')) { const s = document.createElement('style'); s.id = 'cg-css'; s.textContent = CSS; document.head.appendChild(s); }
    const E = { secao: null, dados: {}, carregando: {}, fornecedor: null, filtro: '' };

    async function abrir(secao, { recarregar = false } = {}) {
      const trocou = E.secao !== secao;
      E.secao = secao;
      if (recarregar) delete E.dados[secao];
      if (E.dados[secao]) { if (trocou || recarregar) desenhar(); return; }
      painel.innerHTML = '<div class="vazio">Carregando…</div>';
      if (E.carregando[secao]) return;
      E.carregando[secao] = true;
      try { E.dados[secao] = await api.dados({ secao }); if (E.secao === secao) desenhar(); }
      catch (e) { if (E.secao === secao) { painel.innerHTML = `<div class="vazio">${esc(mensagemErro(e))} <button type="button" class="cg-mini" data-recarregar>Recarregar</button></div>`; ligarRecarregar(); } }
      finally { E.carregando[secao] = false; }
    }
    const ligarRecarregar = () => painel.querySelectorAll('[data-recarregar]').forEach(b => b.addEventListener('click', () => abrir(E.secao, { recarregar: true })));
    const desenhar = () => ({ FORNECEDORES: telaFornecedores, PENDENCIAS: telaPendencias, ORIGEM: telaOrigem }[E.secao])(E.dados[E.secao]);

    async function enviar(botao, msg, fn) {
      botao.disabled = true; msg.className = 'cg-msg'; msg.textContent = 'Gravando…';
      try { return await fn(); }
      catch (e) { msg.className = 'cg-msg erro'; msg.textContent = mensagemErro(e); return null; }
      finally { botao.disabled = false; }
    }

    // ── Parâmetros por fornecedor ───────────────────────────────────────────────────────────────────────────────
    function telaFornecedores(d) {
      if (!E.fornecedor || !d.fornecedores.some(f => f.id === E.fornecedor)) E.fornecedor = d.fornecedores.length ? d.fornecedores[0].id : null;
      painel.innerHTML = `<h2>Parâmetros de fornecedor</h2>
        <div class="cg-sub">Informação interna do MR4. <span class="cg-bd man">MANUAL</span> = você informou · <span class="cg-bd est">ESTIMADO</span> = sugestão calculada do histórico que você aceitou. Campo vazio = não informado. Estes parâmetros <b>não mudam</b> as sugestões da política vigente.</div>
        ${d.origem.disponivel ? '' : '<div class="cg-nota warn">A origem das compras ainda não foi classificada (acontece na sincronização financeira): as sugestões abaixo consideram todas as compras confirmadas.</div>'}
        <div class="cg-bar"><input type="search" id="cgBusca" placeholder="Buscar fornecedor…" aria-label="Buscar fornecedor" value="${esc(E.filtro)}"><select id="cgForn" aria-label="Fornecedor"></select><button type="button" class="cg-mini" data-recarregar>Recarregar</button></div>
        <div id="cgFicha"></div>`;
      const sel = painel.querySelector('#cgForn');
      const opcoes = () => {
        const q = E.filtro.trim().toLowerCase();
        const l = d.fornecedores.filter(f => !q || f.nome.toLowerCase().includes(q) || f.id.includes(q));
        sel.innerHTML = l.map(f => `<option value="${esc(f.id)}">${esc(f.nome)} · ${num(f.compras)} compra(s)${f.parametros ? ' · configurado' : ''}${f.interno ? ' · origem interna' : ''}</option>`).join('') || '<option value="">Nenhum fornecedor encontrado</option>';
        if (l.some(f => f.id === E.fornecedor)) sel.value = E.fornecedor; else if (l.length) { E.fornecedor = l[0].id; sel.value = E.fornecedor; ficha(d); }
      };
      painel.querySelector('#cgBusca').addEventListener('input', e => { E.filtro = e.target.value; opcoes(); });
      sel.addEventListener('change', () => { E.fornecedor = sel.value; ficha(d); });
      ligarRecarregar(); opcoes(); ficha(d);
    }
    function ficha(d, aviso = '') {
      const box = painel.querySelector('#cgFicha'); const f = d.fornecedores.find(x => x.id === E.fornecedor);
      if (!f) { box.innerHTML = '<div class="vazio">Nenhum fornecedor.</div>'; return; }
      const p = f.parametros || {}, est = f.estimativas, fontes = p.fontes || {}, porProd = p.fontesPorProduto || {};
      const mostrar = (tipo, v) => v === null || v === undefined ? '' : tipo === 'reais' ? centsParaTexto(v) : String(v);
      const rotuloValor = (tipo, v) => Array.isArray(tipo) ? (tipo.find(o => o[0] === v) || [v, v])[1] : tipo === 'reais' ? brl(v) : esc(v);
      const selo = fonte => fonte ? `<span class="cg-bd ${fonte === 'MANUAL' ? 'man' : 'est'}" data-selo>${fonte}</span>` : '<span class="cg-bd" data-selo>VAZIO</span>';
      const campo = ([k, rot, tipo]) => {
        const s = est.campos[k] || { valor: null, base: '' }, v = p[k], fonte = v === null || v === undefined ? '' : fontes[k];
        const input = Array.isArray(tipo) ? `<select data-campo="${k}" id="cg-${k}"><option value="">—</option>${tipo.map(([a, b]) => `<option value="${a}"${v === a ? ' selected' : ''}>${b}</option>`).join('')}</select>`
          : `<input data-campo="${k}" id="cg-${k}" ${tipo === 'int' ? 'inputmode="numeric"' : tipo === 'reais' ? 'inputmode="decimal"' : 'maxlength="200"'} value="${esc(mostrar(tipo, v))}" data-fonte="${esc(fonte || '')}" autocomplete="off">`;
        return `<div class="cg-campo"><label for="cg-${k}">${rot}</label>${input.replace('<select ', `<select data-fonte="${esc(fonte || '')}" `)}<div>${selo(fonte)}</div>
          <div class="cg-sug">${s.valor !== null && s.valor !== undefined ? `Sugestão: <b>${rotuloValor(tipo, s.valor)}</b> <button type="button" class="cg-mini" data-usar="${k}">Usar</button><br>Base: ${esc(s.base)}` : `Sem sugestão — ${esc(s.base)}`}</div></div>`;
      };
      const ids = [...new Set([...Object.keys(est.produtos), ...Object.keys(p.multiplosPorProduto || {}), ...Object.keys(p.qtdMinimaPorProduto || {})])]
        .sort((a, b) => ((est.produtos[b] || {}).compras || 0) - ((est.produtos[a] || {}).compras || 0) || a.localeCompare(b));
      const celula = (mapa, id) => {
        const v = (p[mapa] || {})[id], fonte = (porProd[mapa] || {})[id] || '', s = (est.produtos[id] || {})[mapa];
        return `<td><input data-mapa="${mapa}" data-pid="${esc(id)}" data-fonte="${esc(fonte)}" inputmode="numeric" value="${v === undefined ? '' : v}" aria-label="${mapa === 'multiplosPorProduto' ? 'Múltiplo' : 'Quantidade mínima'} do produto" autocomplete="off"><br>${selo(fonte)}${s ? `<div class="cg-sug" title="${esc(s.base)}">sugestão <b>${num(s.valor)}</b> (${num(s.amostra)} compras) <button type="button" class="cg-mini" data-usar-p="${mapa}" data-pid="${esc(id)}">Usar</button></div>` : '<div class="cg-sug">sem sugestão</div>'}</td>`;
      };
      const linhas = ids.map(id => { const n = d.produtos[id] || {}, x = est.produtos[id] || {};
        return `<tr data-linha="${esc(((n.codigo || '') + ' ' + (n.nome || '') + ' ' + id).toLowerCase())}"><td><b>${esc(n.nome || 'Produto ' + id)}</b><div class="cg-sug">${esc(n.codigo || id)}</div></td><td>${num(x.compras || 0)}${x.compras ? `<div class="cg-sug">${num(x.menor)} a ${num(x.maior)} un</div>` : ''}</td>${celula('multiplosPorProduto', id)}${celula('qtdMinimaPorProduto', id)}</tr>`; }).join('');
      const b = est.base;
      box.innerHTML = `<div class="cg-card"><div class="cg-tit"><b>${esc(f.nome)}</b><span class="cg-bd">código ${esc(f.id)}</span>${f.interno ? '<span class="cg-bd at">ORIGEM INTERNA</span>' : ''}</div>
          <div class="cg-meta">${num(f.compras)} compra(s) no histórico · última em ${dia(f.ultima_compra)} · sugestões calculadas com ${num(b.usadas)} compra(s) confirmada(s)${b.excluidas_sem_origem ? ` (<b>${num(b.excluidas_sem_origem)} fora por origem não comprovada</b>)` : ''}<br>
          ${f.parametros ? `Salvo por ${esc(p.atualizadoPor || '—')} em ${quando(p.atualizadoEm)} (versão ${num(p.versao)}).` : 'Nenhum parâmetro salvo para este fornecedor.'}</div>
          <div style="margin-top:.5rem">${CAMPOS.map(campo).join('')}</div>
          ${ids.length ? `<details id="cgProdutos" style="margin-top:.6rem"><summary><b>Múltiplos e mínimos por produto</b> (${num(ids.length)} produto(s))</summary>
            <div class="cg-bar" style="margin-top:.5rem"><input type="search" id="cgBuscaProd" placeholder="Filtrar produto ou código…" aria-label="Filtrar produto"></div>
            <div class="cg-rol"><table class="cg-tab"><thead><tr><th>Produto</th><th>Compras</th><th>Múltiplo de embalagem</th><th>Quantidade mínima</th></tr></thead><tbody>${linhas}</tbody></table></div></details>` : ''}
          <div style="margin-top:.8rem"><button type="button" class="cg-btn" id="cgSalvar">Salvar parâmetros</button><div class="cg-msg ${aviso ? 'ok' : ''}" id="cgMsg" role="status">${esc(aviso)}</div></div></div>`;
      const marcar = (el, fonte) => { el.dataset.fonte = fonte; const s = (el.closest('td') || el.closest('.cg-campo')).querySelector('[data-selo]'); s.textContent = fonte || 'VAZIO'; s.className = 'cg-bd ' + (fonte === 'MANUAL' ? 'man' : fonte === 'ESTIMADO' ? 'est' : ''); };
      box.querySelectorAll('[data-campo], [data-mapa]').forEach(el => el.addEventListener(el.tagName === 'SELECT' ? 'change' : 'input', () => marcar(el, el.value.trim() ? 'MANUAL' : '')));
      box.querySelectorAll('[data-usar]').forEach(bt => bt.addEventListener('click', () => { const k = bt.dataset.usar, el = box.querySelector(`[data-campo="${k}"]`), tipo = CAMPOS.find(c => c[0] === k)[2]; el.value = mostrar(tipo, est.campos[k].valor); marcar(el, 'ESTIMADO'); }));
      box.querySelectorAll('[data-usar-p]').forEach(bt => bt.addEventListener('click', () => { const m = bt.dataset.usarP, id = bt.dataset.pid, el = [...box.querySelectorAll(`[data-mapa="${m}"]`)].find(x => x.dataset.pid === id); el.value = est.produtos[id][m].valor; marcar(el, 'ESTIMADO'); }));
      const bp = box.querySelector('#cgBuscaProd');
      if (bp) bp.addEventListener('input', () => { const q = bp.value.trim().toLowerCase(); box.querySelectorAll('[data-linha]').forEach(tr => { tr.hidden = !!q && !tr.dataset.linha.includes(q); }); });
      box.querySelector('#cgSalvar').addEventListener('click', async ev => {
        const valores = {}, fts = {}, fpp = {}, msg = box.querySelector('#cgMsg'); let invalido = null;
        box.querySelectorAll('[data-campo]').forEach(el => { const k = el.dataset.campo, t = el.value.trim(), [, rot, tipo] = CAMPOS.find(c => c[0] === k); if (!t) return;
          const v = tipo === 'int' ? (/^\d+$/.test(t) ? Number(t) : NaN) : tipo === 'reais' ? reaisParaCents(t) : t;
          if (Number.isNaN(v)) invalido = rot; else { valores[k] = v; fts[k] = el.dataset.fonte || 'MANUAL'; } });
        box.querySelectorAll('[data-mapa]').forEach(el => { const t = el.value.trim(); if (!t) return; const m = el.dataset.mapa, id = el.dataset.pid; if (!/^\d+$/.test(t)) { invalido = 'valores por produto'; return; }
          (valores[m] || (valores[m] = {}))[id] = Number(t); (fpp[m] || (fpp[m] = {}))[id] = el.dataset.fonte || 'MANUAL'; });
        if (invalido) { msg.className = 'cg-msg erro'; msg.textContent = `Valor inválido em "${invalido}": use número inteiro (valores em R$ aceitam vírgula).`; return; }
        const r = await enviar(ev.currentTarget, msg, () => api.parametros({ fornecedorId: f.id, valores, fontes: fts, fontesPorProduto: fpp, versaoAnterior: p.versao || 0 }));
        if (!r) return;
        try { E.dados.FORNECEDORES = await api.dados({ secao: 'FORNECEDORES' }); if (E.secao === 'FORNECEDORES') ficha(E.dados.FORNECEDORES, `Salvo (versão ${r.versao}).`); }
        catch (_) { msg.className = 'cg-msg ok'; msg.textContent = 'Salvo. Recarregue para ver.'; }
      });
    }

    // ── Compras pendentes antigas ───────────────────────────────────────────────────────────────────────────────
    const historico = (l, rot) => l.length ? `<h4>Histórico (quem e quando)</h4><ul class="cg-hist">${l.map(h => `<li><b>${esc(rot(h))}</b> · ${esc(h.quem || '—')} · ${quando(h.quando)}${h.observacao ? `<br>${esc(h.observacao)}` : ''}</li>`).join('')}</ul>` : '';
    const sug = x => `${num(x.unidades)} un em ${num(x.produtos)} produto(s) · ${brl(x.capital_cents)}${x.sem_custo ? ` (${num(x.sem_custo)} sem custo)` : ''}`;
    function telaPendencias(d, aviso = null) {
      const card = c => {
        const ev = c.evidencias, conf = c.confirmacao, t = ev.titulos;
        const itens = c.itens.map(i => `<tr><td><b>${esc(i.nome || 'Produto ' + (i.produto_id || 'sem cadastro'))}</b><div class="cg-sug">${esc(i.codigo || i.produto_id || '—')}</div></td><td>${num(i.quantidade)}</td><td>${brl(i.custo_unit_cents)}</td><td>${num(i.saldo)}</td><td>${num(i.vendido_desde)}</td><td>${num(i.confirmado_desde)}</td><td>${num(i.sobra_saldo)}</td></tr>`).join('');
        const impacto = d.status_possiveis.map(s => { const x = c.impacto[s]; return `<tr><td><b>${esc(STATUS[s])}</b>${x.hipotese ? ' <span class="cg-bd at">HIPÓTESE</span>' : ''}</td><td class="esq">${x.hipotese ? `${sug(x.antes)} → <b>${sug(x.depois)}</b>` : `sem mudança: ${sug(x.antes)}`}</td><td class="esq">${esc(x.descricao)}${x.produtos_alterados.length ? `<div class="cg-sug">${x.produtos_alterados.map(a => `${esc(a.codigo || a.produto_id)}: ${num(a.antes)} → ${num(a.depois)}`).join(' · ')}</div>` : ''}</td></tr>`; }).join('');
        return `<div class="cg-card" data-compra="${esc(c.id)}"><div class="cg-tit"><b>Compra ${c.numero ? 'nº ' + esc(c.numero) : '(número ainda não sincronizado)'} · ${esc(c.fornecedor)}</b>
            <span class="cg-bd ${conf ? 'man' : 'at'}">${conf ? 'MR4: ' + esc(STATUS[conf.status].toUpperCase()) : 'SEM CONFIRMAÇÃO'}</span>
            ${c.origem ? `<span class="cg-bd ${c.origem.usar_em_decisao_automatica ? 'ok' : 'ruim'}">${esc(NIVEL[c.origem.nivel].toUpperCase())}</span>` : ''}</div>
          <div class="cg-meta">Emitida em ${dia(c.data_emissao)}${c.idade_dias === null ? '' : ` · há ${num(c.idade_dias)} dias`} · status no ERP “${esc(c.situacao_erp)}” (alterada em ${esc(dia(c.modificado_em))}) · ${num(c.unidades)} un · ${brl(c.valor_cents)} · registro ${esc(c.id)}</div>
          <h4>Evidências</h4><div class="cg-meta"><b>${esc(VEREDITO[ev.veredito] || ev.veredito)}</b>: ${esc(ev.explicacao)}.<br>
            ${t ? `Títulos a pagar vinculados: ${num(t.vinculados)} (${num(t.pagos)} pago(s), ${brl(t.soma_cents)}). Pagamento comprova obrigação financeira, não recebimento.` : 'Vínculo com títulos ainda não classificado.'}
            ${ev.compras_gemeas.length ? `<br>Compra confirmada com os mesmos itens: ${ev.compras_gemeas.map(g => esc(g.numero ? 'nº ' + g.numero : g.id)).join(', ')}.` : ''}<br>Produtos com sobra de saldo compatível: ${num(ev.itens_com_sobra)} de ${num(ev.itens_total)} (ajustes manuais também causam sobra).</div>
          <div class="cg-rol"><table class="cg-tab"><thead><tr><th>Produto</th><th>Pendente</th><th>Custo un.</th><th>Saldo</th><th>Vendido desde</th><th>Confirmado desde</th><th>Sobra</th></tr></thead><tbody>${itens}</tbody></table></div>
          <h4>Impacto simulado nas sugestões (produtos desta compra) — nada é aplicado</h4>
          <div class="cg-rol"><table class="cg-tab"><thead><tr><th>Se a situação for</th><th class="esq">Sugestão (hoje)</th><th class="esq">Efeito</th></tr></thead><tbody>${impacto}</tbody></table></div>
          <h4>Registrar situação (informação interna; não altera o GestãoClick)</h4>
          <div class="cg-form"><select data-status aria-label="Situação informada"><option value="">Escolha a situação…</option>${d.status_possiveis.map(s => `<option value="${s}">${esc(STATUS[s])}</option>`).join('')}</select>
            <textarea data-obs maxlength="500" placeholder="Observação: o que foi conferido (obrigatória para recebida, duplicada ou cancelada)" aria-label="Observação"></textarea>
            <button type="button" class="cg-btn" data-salvar>Registrar</button></div>
          <div class="cg-msg ${aviso && aviso.id === c.id ? 'ok' : ''}" data-msg role="status">${aviso && aviso.id === c.id ? esc(aviso.texto) : ''}</div>
          ${historico(c.historico, h => STATUS[h.status] || h.status)}</div>`;
      };
      painel.innerHTML = `<h2>Compras pendentes antigas</h2>
        <div class="cg-sub">Compras “A receber” ou “Em aberto” há mais de ${num(d.idade_max_dias)} dias. O ERP não informa recebimento e <b>nada é presumido</b>. O que você registrar fica só no MR4, com autor e data; o GestãoClick não é alterado (a correção lá é feita por você) e as sugestões não mudam. <button type="button" class="cg-mini" data-recarregar>Recarregar</button></div>
        ${d.compras.map(card).join('') || '<div class="vazio">Nenhuma compra pendente antiga.</div>'}
        ${d.fora_da_lista.length ? `<div class="cg-card"><b>Registros de compras que saíram da lista</b> (situação mudou no ERP)${d.fora_da_lista.map(x => `<div class="cg-meta">Compra ${x.numero ? 'nº ' + esc(x.numero) : esc(x.id)} · ERP: ${esc(x.situacao_erp)} · MR4: ${x.confirmacao ? esc(STATUS[x.confirmacao.status]) : '—'}</div>${historico(x.historico, h => STATUS[h.status] || h.status)}`).join('')}</div>` : ''}`;
      ligarRecarregar();
      painel.querySelectorAll('[data-compra]').forEach(el => el.querySelector('[data-salvar]').addEventListener('click', async ev => {
        const c = d.compras.find(x => x.id === el.dataset.compra), msg = el.querySelector('[data-msg]'), status = el.querySelector('[data-status]').value, observacao = el.querySelector('[data-obs]').value;
        if (!status) { msg.className = 'cg-msg erro'; msg.textContent = 'Escolha a situação.'; return; }
        const r = await enviar(ev.currentTarget, msg, () => api.pendencia({ compraId: c.id, status, observacao, versaoAnterior: c.confirmacao ? c.confirmacao.versao : 0 }));
        if (!r) return;
        try { E.dados.PENDENCIAS = await api.dados({ secao: 'PENDENCIAS' }); if (E.secao === 'PENDENCIAS') { telaPendencias(E.dados.PENDENCIAS, { id: c.id, texto: `Registrado (versão ${r.versao}).` }); const alvo = [...painel.querySelectorAll('[data-compra]')].find(x => x.dataset.compra === c.id); if (alvo) alvo.querySelector('[data-msg]').scrollIntoView({ block: 'center' }); } }
        catch (_) { msg.className = 'cg-msg ok'; msg.textContent = 'Registrado. Recarregue para ver.'; }
      }));
    }

    // ── Origem das compras ──────────────────────────────────────────────────────────────────────────────────────
    function telaOrigem(d, aviso = null) {
      if (!d.disponivel) { painel.innerHTML = '<h2>Origem das compras</h2><div class="vazio">A classificação ainda não foi gerada. Ela aparece após a próxima sincronização financeira (a cada 3 horas). <button type="button" class="cg-mini" data-recarregar>Recarregar</button></div>'; ligarRecarregar(); return; }
      const r = d.resumo, pv = d.politica_vigente, im = pv.impacto_se_ignorasse;
      const chip = (k, v) => `<div><span>${k}</span><b>${num(v)}</b></div>`;
      const card = c => `<div class="cg-card" data-compra="${esc(c.id)}"><div class="cg-tit"><b>Compra ${c.numero ? 'nº ' + esc(c.numero) : esc(c.id)} · ${esc(c.fornecedor)}</b><span class="cg-bd ${c.usar_em_decisao_automatica ? 'man' : 'ruim'}">${esc(NIVEL[c.nivel].toUpperCase())}</span><span class="cg-bd ${c.usar_em_decisao_automatica ? 'ok' : 'at'}">${c.usar_em_decisao_automatica ? 'LIBERADA' : 'ISOLADA DAS RECOMENDAÇÕES NOVAS'}</span></div>
          <div class="cg-meta">${c.presente_na_base ? `Emitida em ${dia(c.data_emissao)} · status no ERP “${esc(c.situacao_erp)}” · ${num(c.unidades)} un · ${brl(c.valor_cents)}` : 'Não está mais na base de compras.'} · registro ${esc(c.id)}<br>
          ${c.nivel_automatico === 'CONFLITO' ? `Há título citando este número, mas com fornecedor diferente ou número repetido em mais de uma compra (${num(c.titulos.conflitos)} caso(s)).` : c.nivel_automatico === 'SEM_PROVA' ? 'Nenhum título a pagar da loja cita esta compra.' : 'Há título da loja que comprova esta compra.'} Títulos vinculados: ${num(c.titulos.vinculados)} (${brl(c.titulos.soma_cents)}).</div>
          ${c.itens.length ? `<details><summary>Produtos (${num(c.itens.length)})</summary><div class="cg-rol"><table class="cg-tab"><thead><tr><th>Produto</th><th>Qtd</th><th>Custo un.</th></tr></thead><tbody>${c.itens.map(i => `<tr><td>${esc(i.nome || 'Produto ' + (i.produto_id || 'sem cadastro'))}<div class="cg-sug">${esc(i.codigo || i.produto_id || '—')}</div></td><td>${num(i.quantidade)}</td><td>${brl(i.custo_unit_cents)}</td></tr>`).join('')}</tbody></table></div></details>` : ''}
          <h4>Confirmar (fica registrado com autor e data; não altera o GestãoClick)</h4>
          <div class="cg-form"><select data-decisao aria-label="Decisão sobre a origem"><option value="">Escolha…</option>${Object.entries(DECISAO).filter(([k]) => k === 'VOLTAR_AUTOMATICO' ? c.nivel === 'CONFIRMADA_GESTOR' || c.nivel === 'REJEITADA_GESTOR' : c.nivel_automatico !== 'COMPROVADA_TITULO').map(([k, v]) => `<option value="${k}">${v}</option>`).join('')}</select>
            <textarea data-obs maxlength="500" placeholder="Como você confirmou? (nota fiscal, pedido, comprovante…)" aria-label="Observação"></textarea><button type="button" class="cg-btn" data-salvar>Registrar</button></div>
          <div class="cg-msg ${aviso && aviso.id === c.id ? 'ok' : ''}" data-msg role="status">${aviso && aviso.id === c.id ? esc(aviso.texto) : ''}</div>
          ${historico(c.historico, h => h.decisao ? DECISAO[h.decisao] : DECISAO.VOLTAR_AUTOMATICO)}</div>`;
      painel.innerHTML = `<h2>Origem das compras</h2>
        <div class="cg-sub">Comprovação: título a pagar da loja ${esc(d.loja)} que cita o número da compra, com o mesmo fornecedor. Classificação atualizada em ${quando(d.gerado_em)}. <button type="button" class="cg-mini" data-recarregar>Recarregar</button></div>
        <div class="cg-chips">${chip('Compras', r.total)}${chip('Liberadas', r.liberadas)}${chip('Isoladas', r.isoladas)}${chip('Conflito', r.por_nivel.CONFLITO)}${chip('Sem comprovação', r.por_nivel.SEM_PROVA)}${chip('Confirmadas pela gestão', r.por_nivel.CONFIRMADA_GESTOR)}</div>
        <div class="cg-nota"><b>Como confirmar</b><ol><li><b>Preferível — no GestãoClick:</b> vincule o pagamento à compra (título a pagar da loja MR4 com a descrição “Compra de nº …” e o mesmo fornecedor). A próxima sincronização financeira reconhece sozinha.</li>
          <li><b>Quando não houver título</b> (bonificação, pagamento sem vínculo): confira o documento e registre abaixo “É da loja MR4”, descrevendo a evidência. Pode ser desfeito.</li></ol></div>
        <div class="cg-nota warn"><b>Isolada</b> = fora das recomendações novas (sugestões de parâmetros e políticas em sombra). A política vigente (${esc(pv.versao)}) <b>não foi alterada</b> e ainda considera ${num(pv.confirmadas_isoladas)} compra(s) confirmada(s) desta lista para data da primeira evidência, último fornecedor e referência de custo. Simulação, se ela as ignorasse: quantidade sugerida mudaria em ${num(im.quantidade_sugerida)} produto(s); último fornecedor em ${num(im.ultimo_fornecedor)}; primeira evidência em ${num(im.primeira_evidencia)}; confiança do custo em ${num(im.confianca_do_custo)}.</div>
        ${d.compras.map(card).join('') || '<div class="vazio">Todas as compras estão comprovadas.</div>'}`;
      ligarRecarregar();
      painel.querySelectorAll('[data-compra]').forEach(el => el.querySelector('[data-salvar]').addEventListener('click', async ev => {
        const c = d.compras.find(x => x.id === el.dataset.compra), msg = el.querySelector('[data-msg]'), decisao = el.querySelector('[data-decisao]').value, observacao = el.querySelector('[data-obs]').value;
        if (!decisao) { msg.className = 'cg-msg erro'; msg.textContent = 'Escolha a decisão.'; return; }
        const res = await enviar(ev.currentTarget, msg, () => api.origem({ compraId: c.id, decisao, observacao, versaoAnterior: c.versao }));
        if (!res) return;
        try { E.dados.ORIGEM = await api.dados({ secao: 'ORIGEM' }); delete E.dados.FORNECEDORES; delete E.dados.PENDENCIAS; if (api.aoMudarOrigem) api.aoMudarOrigem(E.dados.ORIGEM.resumo); if (E.secao === 'ORIGEM') telaOrigem(E.dados.ORIGEM, { id: c.id, texto: `Registrado (versão ${res.versao}).` }); }
        catch (_) { msg.className = 'cg-msg ok'; msg.textContent = 'Registrado. Recarregue para ver.'; }
      }));
    }

    return { abrir };
  }
  window.ComprasGestao = { montar };
})();
