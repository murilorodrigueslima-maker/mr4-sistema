// Cópia EXATA do <script> clássico de modulos/expedicao.html em ff8981a (= produção antes do P0). Só para teste:
// prova que uma aba ANTIGA aberta não consegue regredir pedidos depois das Rules novas. NÃO carregar no navegador.

// ── CONFIG ────────────────────────────────────────────────────────────────────
const CFG={
  api_url:'../data/pedidos.json',  // fallback final legado
  intervalo:15,          // 15 segundos entre syncs
  alerta_horas:2,
};

// ── ENVIOS ────────────────────────────────────────────────────────────────────
const ENVIO={
  'uber-mr4':     {label:'Uber MR4',              icon:'🚗',cls:'e-uber-mr4'},
  'uber-cliente': {label:'Uber Cliente',           icon:'🚕',cls:'e-uber-cliente'},
  'retirada':     {label:'Retirada',               icon:'🏪',cls:'e-retirada'},
  'retirada-terc':{label:'Retirada por Terceiros', icon:'👤',cls:'e-retirada-terc'},
  'rota-manha':   {label:'Rota Manhã',             icon:'🌅',cls:'e-rota-manha'},
  'rota-tarde':   {label:'Rota Tarde',             icon:'🌆',cls:'e-rota-tarde'},
};

// ── ESTADO (carregado do Firestore, não localStorage) ─────────────────────────
const S={
  pedidos:{},     // { [numero]: pedido }
  cd:CFG.intervalo,
  cdAtual:null,
  envioSel:null,
  modalMode:null,
  cancelNum:null,
  audioUnlocked:false,
};

// ── UTILS ─────────────────────────────────────────────────────────────────────
function brl(v){return Number(v||0).toLocaleString('pt-BR',{style:'currency',currency:'BRL'});}
function horaFmt(ts){return new Date(ts).toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});}
function hoje(){return new Date().toLocaleDateString('sv-SE',{timeZone:'America/Fortaleza'});}

function dataCurtaFmt(dataStr){
  // '2026-04-15' → '15/04'
  if(!dataStr)return'';
  const [,m,d]=dataStr.split('-');
  return `${d}/${m}`;
}

function numCurto(n){return String(n||'');}
function limparNome(s){return (s||'').replace(/^\d{2,3}[\.\d]*\s+/,'').trim()||s;}
function elapsedFmt(ts){
  const s=Math.floor((Date.now()-ts)/1000);
  if(s<60)return s+'s';
  if(s<3600)return Math.floor(s/60)+'min';
  const h=Math.floor(s/3600),m=Math.floor((s%3600)/60);
  return m?`${h}h ${m}min`:`${h}h`;
}
function isAlerta(p){return p.coluna!=='de'&&(Date.now()-p.ingresadoEm)/3600000>=CFG.alerta_horas;}
function getColuna(col){
  return Object.values(S.pedidos)
    .filter(p=>p.coluna===col)
    .sort((a,b)=>b.ingresadoEm-a.ingresadoEm);
}

// ── BEEP ─────────────────────────────────────────────────────────────────────
// Desbloqueia AudioContext no primeiro clique (requisito do Chrome)
document.addEventListener('click',()=>{S.audioUnlocked=true;},{once:true});

function beep(qtd=1){
  if(!S.audioUnlocked)return;
  try{
    const ctx=new(window.AudioContext||window.webkitAudioContext)();
    const tocar=(t)=>{
      const osc=ctx.createOscillator();
      const gain=ctx.createGain();
      osc.connect(gain);gain.connect(ctx.destination);
      osc.type='sine';osc.frequency.value=880;
      gain.gain.setValueAtTime(0.35,t);
      gain.gain.exponentialRampToValueAtTime(0.001,t+0.18);
      osc.start(t);osc.stop(t+0.18);
    };
    for(let i=0;i<Math.min(qtd,3);i++) tocar(ctx.currentTime+i*0.28);
  }catch(e){}
}

// ── FIRESTORE ─────────────────────────────────────────────────────────────────
async function fsSalvar(p){
  await window._fsSet('expedicao_pedidos', p.numero, p);
}
async function fsAtualizar(numero,campos){
  await window._fsSet('expedicao_pedidos', String(numero), campos, {merge:true});
}

// ── INIT ──────────────────────────────────────────────────────────────────────
window.iniciarPainel = async function(){
  toast('⏳ Carregando pedidos...','t-info',2000);

  try{
    const todos = await window._fsGetAll('expedicao_pedidos');
    const hojeStr = hoje();

    todos.forEach(p=>{
      // Cancelados nunca aparecem no board (mas ficam no Firestore como histórico)
      if(p.coluna==='cancelado')return;
      // Todos os demais (ag, se, pr, de) entram em S.pedidos para que
      // fetchPedidos() saiba que eles já existem e não os re-adicione como 'ag'.
      // O render() já filtra 'de' para exibir somente os despachados hoje.
      S.pedidos[String(p.numero)]=p;
    });
  }catch(e){
    toast('⚠️ Erro ao carregar Firestore: '+e.message,'t-error');
  }

  atualizarHeader();
  render();
  setInterval(tickElapsed,8000);
  setInterval(atualizarHeader,30000);
  iniciarContagem();
  fetchPedidos(); // busca imediato ao abrir
};

// ── FETCH ─────────────────────────────────────────────────────────────────────
// Busca pedidos: gcQuery (primário) → pedidos_cache Firestore (fallback S1)
async function fetchPedidos(){
  try{
    let pedidosRaw = [];

    try{
      // ── Modo primário: gcQuery autenticado ──
      pedidosRaw = await fetchViaGcQuery();
    } catch(gcErr){
      console.warn('gcQuery indisponível, tentando pedidos_cache:', gcErr.message);
      // ── Fallback: pedidos_cache/latest do Firestore (S1) ──
      try {
        const snap = await window._fsGetOne('pedidos_cache', 'latest');
        if (snap && Array.isArray(snap.pedidos)) {
          pedidosRaw = snap.pedidos;
        } else {
          throw new Error('pedidos_cache/latest não encontrado ou vazio');
        }
      } catch(fsErr) {
        console.warn('pedidos_cache indisponível:', fsErr.message);
        pedidosRaw = [];
      }
    }

    const nums = new Set(Object.keys(S.pedidos));
    let n = 0;

    for(const p of pedidosRaw){
      const num = String(p.numero||p.id||'');
      if(!num || nums.has(num)) continue;

      // Verifica no Firestore — se já existe com QUALQUER status, não recria
      let jaExiste=null;
      try{jaExiste=await window._fsGetOne('expedicao_pedidos',num);}
      catch(fe){console.warn('fetchPedidos #'+num+':',fe.message);continue;}
      if(jaExiste){S.pedidos[num]=jaExiste;continue;}

      const now = Date.now();
      const novo = {
        numero:      num,
        data:        p.data   || hoje(),
        hora:        p.hora   || '',
        ingresadoEm: now,
        movidoEm:    now,
        coluna:      'ag',
        cliente:     p.cliente  || '—',
        vendedor:    p.vendedor || '—',
        itens:       Number(p.itens  || 1),
        valor:       Number(p.valor  || 0),
        cidade:      p.cidade  || '',
        envio:       null,
        saidaEm:     null,
      };
      S.pedidos[num] = novo;
      await fsSalvar(novo);
      n++;
    }

    if(n){
      toast(`📬 ${n} novo${n>1?'s':''} pedido${n>1?'s':''} chegou!`, 't-info');
      beep(n);
      render();
    }
  }catch(e){
    console.warn('fetchPedidos:', e.message);
  }
}

// Busca os últimos 2 dias de vendas via gcQuery autenticado
async function fetchViaGcQuery(){
  function diasAtras(n){
    const d=new Date(); d.setDate(d.getDate()-n);
    return d.toLocaleDateString('sv-SE',{timeZone:'America/Fortaleza'});
  }
  const inicio = diasAtras(2);
  const fim    = hoje();

  let todos=[], pagina=1;
  while(true){
    const r    = await window._gcQuery({ operacao:'LISTAR_VENDAS', dados:{ data_inicio:inicio, data_fim:fim, pagina, limite:100 } });
    const batch = Array.isArray(r.data?.data) ? r.data.data : [];
    todos = todos.concat(batch);
    const meta = r.data?.meta || {};
    if(pagina >= (Number(meta.total_paginas)||1)) break;
    pagina++;
  }

  // DTO já normalizado pelo servidor
  return todos.map(v=>({
    numero:  v.numero || String(v.id || ''),
    data:    v.data   || hoje(),
    hora:    v.hora   || '',
    cliente: v.cliente  || '—',
    vendedor:v.vendedor || '—',
    valor:   Number(v.valor || 0),
    itens:   Number(v.itens || 0),
    cidade:  v.cidade || '',
  }));
}

// ── AÇÕES ─────────────────────────────────────────────────────────────────────
window.marcarSeparado=async function(numero){
  await mover(numero,'se','pr');
  toast(`✅ Pedido #${numero} pronto para despacho`,'t-success');
};

function abrirModal(numero,modo){
  S.cdAtual=numero;S.envioSel=null;S.modalMode=modo;
  const p=S.pedidos[numero];
  document.querySelectorAll('.envio-opt').forEach(o=>o.classList.remove('sel'));
  document.getElementById('btnConfirm').disabled=true;
  if(p.envio){
    const opt=document.querySelector(`.envio-opt[data-envio="${p.envio}"]`);
    if(opt){opt.classList.add('sel');S.envioSel=p.envio;document.getElementById('btnConfirm').disabled=false;}
  }
  if(modo==='separacao'){
    document.getElementById('modalTitle').textContent='📦 Iniciar Separação';
    document.getElementById('btnConfirm').textContent='Iniciar Separação';
  }else{
    document.getElementById('modalTitle').textContent='🚀 Confirmar Despacho';
    document.getElementById('btnConfirm').textContent='Confirmar Despacho';
  }
  document.getElementById('modalInfo').innerHTML=
    `<strong>#${numCurto(p.numero)}</strong> — ${limparNome(p.cliente)}<br>
     <span style="opacity:.7;font-size:.72rem">${p.itens} item${p.itens>1?'s':''} · ${brl(p.valor)} · Vendedor: ${p.vendedor}</span>`;
  document.getElementById('modalOverlay').classList.add('open');
}

window.iniciarSeparacao=function(num){abrirModal(num,'separacao');};
window.abrirDespacho   =function(num){abrirModal(num,'despacho');};

window.selEnvio=function(el){
  document.querySelectorAll('.envio-opt').forEach(o=>o.classList.remove('sel'));
  el.classList.add('sel');S.envioSel=el.dataset.envio;
  document.getElementById('btnConfirm').disabled=false;
};

window.fecharModal=function(){
  document.getElementById('modalOverlay').classList.remove('open');
  S.cdAtual=S.envioSel=S.modalMode=null;
};

window.confirmarModal=async function(){
  if(!S.envioSel||!S.cdAtual)return;
  const p=S.pedidos[S.cdAtual];
  p.envio=S.envioSel;
  if(S.modalMode==='separacao'){
    await mover(p.numero,'ag','se');
    fecharModal();
    toast(`📦 Separação iniciada — #${p.numero} · ${ENVIO[p.envio]?.label}`,'t-success');
  }else{
    p.saidaEm=Date.now();
    await mover(p.numero,'pr','de');
    fecharModal();
    toast(`🚀 Pedido #${p.numero} despachado — ${ENVIO[p.envio]?.label||p.envio}`,'t-success');
  }
};

// ── CANCELAR PEDIDO ───────────────────────────────────────────────────────────
window.abrirCancelModal=function(numero){
  S.cancelNum=numero;
  const p=S.pedidos[numero];
  document.getElementById('cancelInfo').innerHTML=
    `<strong>#${numCurto(p.numero)}</strong> — ${limparNome(p.cliente)}<br>
     <span style="opacity:.7;font-size:.72rem">Coluna atual: ${({ag:'Aguardando',se:'Separando',pr:'Pronto p/ Despacho'}[p.coluna]||p.coluna)}</span>`;
  document.getElementById('cancelOverlay').classList.add('open');
};
window.fecharCancelModal=function(){
  document.getElementById('cancelOverlay').classList.remove('open');
  S.cancelNum=null;
};
window.confirmarCancel=async function(){
  if(!S.cancelNum)return;
  const p=S.pedidos[S.cancelNum];
  // Salva como cancelado no Firestore
  await fsAtualizar(p.numero,{coluna:'cancelado',canceladoEm:Date.now()});
  // Remove do board
  delete S.pedidos[S.cancelNum];
  fecharCancelModal();
  toast(`❌ Pedido #${p.numero} cancelado — ${limparNome(p.cliente)}`,'t-error');
  render();
};

document.getElementById('modalOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('modalOverlay'))fecharModal();});
document.getElementById('cancelOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('cancelOverlay'))fecharCancelModal();});
document.getElementById('reabrirOverlay').addEventListener('click',e=>{if(e.target===document.getElementById('reabrirOverlay'))fecharReabrirModal();});

// ── REABRIR PEDIDO ────────────────────────────────────────────────────────────
window.abrirReabrirModal=function(numero){
  S.cancelNum=numero; // reutiliza o campo de referência
  const p=S.pedidos[numero];
  document.getElementById('reabrirInfo').innerHTML=
    `<strong>#${numCurto(p.numero)}</strong> — ${limparNome(p.cliente)}<br>
     <span style="opacity:.7;font-size:.72rem">Despachado em: ${p.saidaEm?new Date(p.saidaEm).toLocaleString('pt-BR'):'—'} · Envio: ${ENVIO[p.envio]?.label||p.envio||'—'}</span>`;
  document.getElementById('reabrirOverlay').classList.add('open');
};
window.fecharReabrirModal=function(){
  document.getElementById('reabrirOverlay').classList.remove('open');
  S.cancelNum=null;
};
window.confirmarReabrir=async function(){
  if(!S.cancelNum)return;
  const p=S.pedidos[S.cancelNum];
  const now=Date.now();
  // Reseta para aguardando separação
  p.coluna='ag'; p.saidaEm=null; p.envio=null; p.ingresadoEm=now; p.movidoEm=now;
  await fsAtualizar(p.numero,{coluna:'ag',saidaEm:null,envio:null,ingresadoEm:now,movidoEm:now});
  fecharReabrirModal();
  toast(`↩ Pedido #${p.numero} reaberto — ${limparNome(p.cliente)}`,'t-warn');
  render();
};

// ── MOVER ─────────────────────────────────────────────────────────────────────
async function mover(numero,de,para){
  const p=S.pedidos[numero];
  if(!p)return;
  p.coluna=para;
  p.movidoEm=Date.now();
  await fsAtualizar(numero,{coluna:para,movidoEm:p.movidoEm,envio:p.envio||null,saidaEm:p.saidaEm||null});
  render();
}

// ── RENDER ────────────────────────────────────────────────────────────────────
function render(){
  const hojeStr=hoje();
  const ag=getColuna('ag');
  const se=getColuna('se');
  const pr=getColuna('pr');
  // Despachados: só mostra de hoje
  const de=getColuna('de').filter(p=>p.data===hojeStr||p.saidaEm&&new Date(p.saidaEm).toLocaleDateString('sv-SE',{timeZone:'America/Fortaleza'})===hojeStr);

  const total=ag.length+se.length+pr.length;
  document.getElementById('sumTotal').textContent=total;
  document.getElementById('sumAg').textContent=ag.length;
  document.getElementById('sumSe').textContent=se.length;
  document.getElementById('sumPr').textContent=pr.length;
  document.getElementById('sumDe').textContent=de.length;

  [['ag',ag],['se',se],['pr',pr],['de',de]].forEach(([col,lista])=>{
    document.getElementById('cnt-'+col).textContent=lista.length;
    const body=document.getElementById('col-'+col);
    body.innerHTML=lista.length?lista.map(p=>renderCard(p)).join(''):'<div class="col-empty">Nenhum pedido</div>';
  });
}

function elapsedCls(ts,coluna){
  if(coluna==='de')return'el-ok';
  const min=(Date.now()-ts)/60000;
  if(min<60)return'el-ok';
  if(min<120)return'el-warn';
  return'el-crit';
}

function renderCard(p){
  if(!p)return'';
  const al=isAlerta(p);
  const ev=p.envio?(ENVIO[p.envio]||{label:p.envio,icon:'📦',cls:'e-nd'}):{label:'A definir',icon:'❓',cls:'e-nd'};
  const ec=elapsedCls(p.ingresadoEm,p.coluna);
  const hojeStr=hoje();
  const ehDiaAnterior=p.data&&p.data!==hojeStr;

  // Linha de data/hora do pedido
  let dataHoraHtml='';
  if(ehDiaAnterior){
    dataHoraHtml=`<span class="card-data-badge">${dataCurtaFmt(p.data)}</span>`;
  }
  if(p.hora){
    dataHoraHtml+=`<span class="card-hora">${p.hora}</span>`;
  }else if(!ehDiaAnterior){
    // Sem hora do GC e pedido de hoje — mostra hora em que chegou ao board
    dataHoraHtml+=`<span class="card-hora">${horaFmt(p.ingresadoEm)}</span>`;
  }

  let botao='';
  let cancelBtn='';
  if(p.coluna==='ag'){
    botao=`<button class="btn-act b-iniciar" onclick="iniciarSeparacao('${p.numero}')">▶ Iniciar Separação</button>`;
    cancelBtn=`<button class="btn-cancel-card" onclick="abrirCancelModal('${p.numero}')">✕</button>`;
  }else if(p.coluna==='se'){
    botao=`<button class="btn-act b-separado" onclick="marcarSeparado('${p.numero}')">✓ Marcar Separado</button>`;
    cancelBtn=`<button class="btn-cancel-card" onclick="abrirCancelModal('${p.numero}')">✕</button>`;
  }else if(p.coluna==='pr'){
    botao=`<button class="btn-act b-despachar" onclick="abrirDespacho('${p.numero}')">🚀 Despachar</button>`;
    cancelBtn=`<button class="btn-cancel-card" onclick="abrirCancelModal('${p.numero}')">✕</button>`;
  }else if(p.coluna==='de'){
    botao=`<span class="dispatch-time">🕐 Saiu ${horaFmt(p.saidaEm)}</span>`;
    cancelBtn=`<button class="btn-reabrir-card" onclick="abrirReabrirModal('${p.numero}')">↩ Reabrir</button>`;
  }

  return`<div class="card${al?' alerta':''}" id="card-${p.numero}">
  <div class="card-top">
    <span class="card-num">#${numCurto(p.numero)}</span>
    ${dataHoraHtml}
    <span class="card-elapsed ${ec}" id="el-${p.numero}">${elapsedFmt(p.ingresadoEm)}</span>
  </div>
  <div class="card-cliente">${limparNome(p.cliente)}${p.cidade?`<span class="card-cidade">${p.cidade}</span>`:''}</div>
  <div class="card-envio"><span class="badge-envio ${ev.cls}">${ev.icon} ${ev.label}</span></div>
  <div class="card-vendedor"><span class="card-vendedor-icon">👤</span>${p.vendedor||'—'}</div>
  <div class="card-meta">
    <span class="card-items">${p.itens} item${p.itens>1?'s':''}</span>
    <span class="card-val">${brl(p.valor)}</span>
  </div>
  <div class="card-foot">${botao}${cancelBtn}</div>
</div>`;
}

// ── TICK ELAPSED ──────────────────────────────────────────────────────────────
function tickElapsed(){
  Object.values(S.pedidos).forEach(p=>{
    const el=document.getElementById('el-'+p.numero);
    const card=document.getElementById('card-'+p.numero);
    if(el){el.textContent=elapsedFmt(p.ingresadoEm);el.className='card-elapsed '+elapsedCls(p.ingresadoEm,p.coluna);}
    if(card)card.classList.toggle('alerta',isAlerta(p));
  });
}

// ── COUNTDOWN ────────────────────────────────────────────────────────────────
function iniciarContagem(){
  S.cd=CFG.intervalo;
  setInterval(async()=>{
    S.cd--;
    const el=document.getElementById('countdown');if(!el)return;
    if(S.cd<=0){
      el.classList.add('syncing');el.textContent='↻ Sincronizando...';
      await fetchPedidos();
      S.cd=CFG.intervalo;el.classList.remove('syncing');
    }
    if(!el.classList.contains('syncing'))el.textContent=`↻ ${S.cd}s`;
  },1000);
}

// ── HEADER ────────────────────────────────────────────────────────────────────
function atualizarHeader(){
  const n=new Date();
  const el=document.getElementById('hdDate');
  if(el)el.textContent=n.toLocaleDateString('pt-BR',{weekday:'long',day:'2-digit',month:'long'})
    +' · '+n.toLocaleTimeString('pt-BR',{hour:'2-digit',minute:'2-digit'});
}

// ── TOASTS ────────────────────────────────────────────────────────────────────
function toast(msg,tipo='t-info',dur=3500){
  const wrap=document.getElementById('toastWrap');
  const el=document.createElement('div');
  const icons={'t-success':'✅','t-info':'📬','t-warn':'⚠️','t-error':'❌'};
  el.className=`toast ${tipo}`;
  el.innerHTML=`<span class="toast-icon">${icons[tipo]||'💬'}</span><span class="toast-msg">${msg}</span>`;
  wrap.appendChild(el);
  setTimeout(()=>{el.classList.add('out');setTimeout(()=>el.remove(),300);},dur);
}
