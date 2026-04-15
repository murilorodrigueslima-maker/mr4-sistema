// sync-dados.js — Sincroniza vendas, estoque e financeiro do GestãoClick
// Roda via GitHub Actions a cada 30 min
const fs   = require('fs');
const path = require('path');
const https = require('https');

const ACCESS_TOKEN  = process.env.GC_ACCESS_TOKEN;
const SECRET_TOKEN  = process.env.GC_SECRET_ACCESS_TOKEN;
const API_BASE      = 'https://api.gestaoclick.com';
const DATA_DIR      = path.join(__dirname, '..', 'data');

if (!ACCESS_TOKEN || !SECRET_TOKEN) {
  console.error('❌ Tokens GestãoClick não configurados');
  process.exit(1);
}

function fetchGC(endpoint) {
  return new Promise((resolve, reject) => {
    const url = `${API_BASE}${endpoint}`;
    const opts = {
      headers: {
        'access-token':        ACCESS_TOKEN,
        'secret-access-token': SECRET_TOKEN,
        'Content-Type':        'application/json',
      }
    };
    https.get(url, opts, res => {
      let body = '';
      res.on('data', d => body += d);
      res.on('end', () => {
        try { resolve(JSON.parse(body)); }
        catch(e) { reject(new Error(`JSON inválido: ${body.slice(0,200)}`)); }
      });
    }).on('error', reject);
  });
}

function brl(v) {
  return Number(v || 0).toLocaleString('pt-BR', { style:'currency', currency:'BRL' });
}

function agora() {
  return new Date().toLocaleString('pt-BR', { timeZone: 'America/Fortaleza' });
}

function dataISO() {
  return new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' })).toISOString().slice(0,19);
}

// ── Datas úteis ──────────────────────────────────────────────────────────────
function hoje() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  return d.toISOString().slice(0,10);
}

function inicioSemana() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  const dia = d.getDay(); // 0=dom
  d.setDate(d.getDate() - (dia === 0 ? 6 : dia - 1));
  return d.toISOString().slice(0,10);
}

function inicioMes() {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  return `${d.getFullYear()}-${String(d.getMonth()+1).padStart(2,'0')}-01`;
}

function diasAtras(n) {
  const d = new Date(new Date().toLocaleString('en-US', { timeZone: 'America/Fortaleza' }));
  d.setDate(d.getDate() - n);
  return d.toISOString().slice(0,10);
}

// ── VENDAS ───────────────────────────────────────────────────────────────────
async function syncVendas() {
  console.log('📊 Sincronizando vendas...');
  const META_MES    = 200000;
  const META_DIA    = 8000;
  const META_SEMANA = 40000;

  let vendas = [];
  try {
    // Endpoint correto: /vendas com data_inicio e data_fim
    const inicio = diasAtras(30);
    let pagina = 1;
    while (true) {
      const r = await fetchGC(`/vendas?pagina=${pagina}&limite=100&data_inicio=${inicio}&data_fim=${hoje()}`);
      const data = r.data || [];
      vendas = vendas.concat(data);
      const meta = r.meta || {};
      if (pagina >= (Number(meta.total_paginas) || 1)) break;
      pagina++;
    }
    console.log(`  → ${vendas.length} vendas encontradas`);
  } catch(e) {
    console.log('⚠️ Erro ao buscar vendas:', e.message);
  }

  // Calcula faturamento
  const hojStr  = hoje();
  const semStr  = inicioSemana();
  const mesStr  = inicioMes();

  let fatHoje = 0, fatSemana = 0, fatMes = 0;
  const vendedorMap = {};
  const diaMap = {};

  vendas.forEach(p => {
    const data  = (p.data || p.data_venda || p.data_pedido || '').slice(0,10);
    const valor = Number(p.valor_total || p.total || p.valor || 0);
    const vend  = p.nome_vendedor || p.vendedor || p.nome_usuario || 'Outros';

    if (data === hojStr)   fatHoje   += valor;
    if (data >= semStr)    fatSemana += valor;
    if (data >= mesStr)    fatMes    += valor;

    if (!vendedorMap[vend]) vendedorMap[vend] = { nome: vend, faturamento: 0, pedidos: 0 };
    vendedorMap[vend].faturamento += valor;
    vendedorMap[vend].pedidos++;

    if (!diaMap[data]) diaMap[data] = 0;
    diaMap[data] += valor;
  });

  // Últimos 7 dias
  const ultimos7 = [];
  for (let i = 6; i >= 0; i--) {
    const d = diasAtras(i);
    const label = new Date(d + 'T12:00:00').toLocaleDateString('pt-BR', { weekday:'short', day:'2-digit', month:'2-digit' });
    ultimos7.push({ data: d, label, valor: diaMap[d] || 0 });
  }

  const vendedores = Object.values(vendedorMap)
    .sort((a,b) => b.faturamento - a.faturamento)
    .map(v => ({
      ...v,
      ticket_medio: v.pedidos > 0 ? v.faturamento / v.pedidos : 0
    }));

  const dadosVendas = {
    atualizado_em: dataISO(),
    hoje:     fatHoje,
    semana:   fatSemana,
    mes:      fatMes,
    meta_mes: META_MES,
    meta_dia: META_DIA,
    meta_semana: META_SEMANA,
    vendedores,
    ultimos_7_dias: ultimos7,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'vendas.json'), JSON.stringify(dadosVendas, null, 2));
  console.log(`✅ Vendas: hoje R$ ${fatHoje.toFixed(2)} | mês R$ ${fatMes.toFixed(2)}`);
}

// ── ESTOQUE ──────────────────────────────────────────────────────────────────
async function syncEstoque() {
  console.log('🗄️ Sincronizando estoque...');
  let produtos = [];

  try {
    let pagina = 1;
    while (true) {
      const r = await fetchGC(`/produtos?pagina=${pagina}&limite=100&ativo=1`);
      const data = r.data || [];
      produtos = produtos.concat(data);
      const meta = r.meta || {};
      if (pagina >= (Number(meta.total_paginas) || 1)) break;
      pagina++;
    }
  } catch(e) {
    console.log('⚠️ Erro ao buscar produtos:', e.message);
  }

  let valorTotal = 0;
  const abaixoMinimo = [];
  const semGiro      = [];
  const margemBaixa  = [];

  const hoje90 = diasAtras(90);

  produtos.forEach(p => {
    const estoque  = Number(p.estoque || 0);
    const custo    = Number(p.valor_custo || 0);
    const venda    = Number(p.valor_venda || 0);
    const minimo   = Number(p.estoque_minimo || p.qtd_minima || 0);
    const ref      = p.codigo_interno || p.codigo || '—';
    const nome     = p.nome || '—';
    const margem   = venda > 0 ? ((venda - custo) / venda * 100) : 0;
    const ultVenda = (p.ultima_venda || '').slice(0,10);

    valorTotal += estoque * custo;

    if (minimo > 0 && estoque < minimo) {
      abaixoMinimo.push({ ref, nome, estoque, minimo, falta: minimo - estoque });
    }

    if (estoque > 0 && ultVenda && ultVenda < hoje90) {
      const dias = Math.floor((Date.now() - new Date(ultVenda).getTime()) / 86400000);
      semGiro.push({ ref, nome, ultima_venda: ultVenda, dias, estoque });
    }

    if (venda > 0 && margem < 25) {
      margemBaixa.push({ ref, nome, margem: margem.toFixed(1), preco: venda, custo });
    }
  });

  const estoque = {
    atualizado_em:       dataISO(),
    total_produtos:      produtos.length,
    valor_total_estoque: valorTotal,
    abaixo_minimo:       abaixoMinimo.slice(0, 50),
    sem_giro:            semGiro.sort((a,b) => b.dias - a.dias).slice(0, 50),
    margem_baixa:        margemBaixa.sort((a,b) => a.margem - b.margem).slice(0, 50),
  };

  fs.writeFileSync(path.join(DATA_DIR, 'estoque.json'), JSON.stringify(estoque, null, 2));
  console.log(`✅ Estoque: ${produtos.length} produtos | ${abaixoMinimo.length} abaixo do mínimo`);
}

// ── FINANCEIRO ───────────────────────────────────────────────────────────────
async function syncFinanceiro() {
  console.log('💰 Sincronizando financeiro...');
  // Endpoint correto: /pagamentos filtrado por entidade (I=entrada, O=saída)
  let lancamentos = [];

  try {
    const inicio = diasAtras(60);
    const fim    = diasAtras(-30); // 30 dias à frente
    let pagina = 1;
    while (true) {
      const r = await fetchGC(`/pagamentos?pagina=${pagina}&limite=100&data_inicio=${inicio}&data_fim=${fim}`);
      const data = r.data || [];
      lancamentos = lancamentos.concat(data);
      const meta = r.meta || {};
      if (pagina >= (Number(meta.total_paginas) || 1)) break;
      pagina++;
    }
    console.log(`  → ${lancamentos.length} lançamentos encontrados`);
  } catch(e) {
    console.log('⚠️ Erro ao buscar pagamentos:', e.message);
  }

  const hojStr = hoje();
  const em7    = diasAtras(-7);

  let totalVencido = 0, totalPagar = 0, totalReceber = 0;
  const vencidas = [], vencendo = [];

  // entidade='I' = entrada (contas a receber), 'O' = saída (contas a pagar)
  lancamentos.forEach(c => {
    const venc      = (c.data_vencimento || '').slice(0,10);
    const valor     = Number(c.valor || 0);
    const nome      = c.nome_cliente || c.nome_fornecedor || c.descricao || c.observacao || '—';
    const liquidado = c.liquidado === '1' || c.liquidado === true;
    const entidade  = c.entidade || '';
    const tipo      = entidade === 'I' ? 'Receber' : 'Pagar';

    if (liquidado) return; // ignora já pagos

    if (entidade === 'O') totalPagar    += valor;
    if (entidade === 'I') totalReceber  += valor;

    if (venc < hojStr) {
      totalVencido += valor;
      const dias = Math.floor((Date.now() - new Date(venc).getTime()) / 86400000);
      vencidas.push({ nome, valor, vencimento: venc, dias_atraso: dias, tipo });
    } else if (venc <= em7) {
      vencendo.push({ nome, valor, vencimento: venc, tipo });
    }
  });

  const inadimplencia = totalReceber > 0
    ? ((vencidas.filter(v=>v.tipo==='Receber').reduce((s,v)=>s+v.valor,0) / totalReceber) * 100).toFixed(1)
    : 0;

  const financeiro = {
    atualizado_em:    dataISO(),
    contas_vencidas:  vencidas.sort((a,b) => b.dias_atraso - a.dias_atraso),
    contas_vencendo:  vencendo.sort((a,b) => a.vencimento.localeCompare(b.vencimento)),
    fluxo_caixa:      [],
    inadimplencia_pct: Number(inadimplencia),
    total_vencido:    totalVencido,
    total_a_receber:  totalReceber,
    total_a_pagar:    totalPagar,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'financeiro.json'), JSON.stringify(financeiro, null, 2));
  console.log(`✅ Financeiro: vencido R$ ${totalVencido.toFixed(2)} | a receber R$ ${totalReceber.toFixed(2)}`);
}

// ── PEDIDOS (Expedição) ───────────────────────────────────────────────────────
async function syncPedidos() {
  console.log('🚚 Sincronizando pedidos para expedição...');
  let vendas = [];

  try {
    const inicio = diasAtras(2); // hoje + ontem (expedição é operacional)
    let pagina = 1;
    while (true) {
      const r = await fetchGC(`/vendas?pagina=${pagina}&limite=100&data_inicio=${inicio}&data_fim=${hoje()}`);
      const data = r.data || [];
      vendas = vendas.concat(data);
      const meta = r.meta || {};
      if (pagina >= (Number(meta.total_paginas) || 1)) break;
      pagina++;
    }
    console.log(`  → ${vendas.length} pedidos encontrados`);
  } catch(e) {
    console.log('⚠️ Erro ao buscar pedidos:', e.message);
  }

  const pedidos = vendas.map(p => {
    // Tenta extrair hora exata do pedido (vários nomes de campo possíveis)
    const dataHora = p.data_hora || p.data_criacao || p.created_at || p.data_pedido || '';
    const dataBase = (p.data || p.data_venda || p.data_pedido || '').slice(0, 10);
    // Extrai HH:MM se disponível no campo datetime
    const horaMatch = dataHora.match(/(\d{2}:\d{2})/);
    const hora = horaMatch ? horaMatch[1] : '';

    return {
      id:        String(p.id || p.codigo || ''),
      numero:    String(p.numero || p.codigo_venda || p.id || ''),
      data:      dataBase,
      hora:      hora,
      cliente:   p.nome_cliente || p.cliente || p.razao_social || '—',
      vendedor:  p.nome_vendedor || p.vendedor || p.nome_usuario || '—',
      valor:     Number(p.valor_total || p.total || p.valor || 0),
      itens:     Number(p.quantidade_produtos || (p.produtos || []).length || 0),
      status_gc: p.status || p.situacao || '',
      cidade:    p.cidade_cliente || p.cidade || '',
    };
  });

  pedidos.sort((a, b) => b.data.localeCompare(a.data) || b.numero.localeCompare(a.numero));

  const out = {
    atualizado_em: dataISO(),
    total: pedidos.length,
    pedidos,
  };

  fs.writeFileSync(path.join(DATA_DIR, 'pedidos.json'), JSON.stringify(out, null, 2));
  console.log(`✅ Pedidos: ${pedidos.length} registros salvos`);
}

// ── MAIN ──────────────────────────────────────────────────────────────────────
(async () => {
  console.log(`🔄 Iniciando sync — ${agora()}`);
  await Promise.allSettled([
    syncVendas(),
    syncEstoque(),
    syncFinanceiro(),
    syncPedidos(),
  ]);
  console.log('🏁 Sync concluído!');
})();
