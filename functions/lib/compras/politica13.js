'use strict';
// AGENTE COMPRAS & ESTOQUE MR4 — Política 1.3 em MODO SOMBRA: parâmetros (fonte única) e validação.
// NÃO é a política vigente: não entra em POLITICAS/POLITICA_VIGENTE e não altera sugestão, tela nem documentos de produção.
// Todo valor marcado como PREMISSA é uma escolha declarada (não medida) e aparece na justificativa quando é usado.
// Nada aqui é "aumento percentual fixo": cada parcela da quantidade vem de dado do próprio produto, do prazo ou de decisão configurada.

function congelar(o) { Object.values(o).forEach(v => { if (v && typeof v === 'object') congelar(v); }); return Object.freeze(o); }

const POLITICA_1_3_SOMBRA = congelar({
  policy_version: '1.3-SOMBRA',
  status: 'SHADOW_NOT_APPROVED',
  baseline_version: '1.2',

  // ── Classificação ───────────────────────────────────────────────────────────
  // Três curvas (faturamento, margem bruta, volume). A classe usada é a MELHOR entre faturamento e margem; volume é informativo.
  abc: { janela_dias: 365, corte_a: 0.80, corte_b: 0.95, curvas_que_definem_classe: ['receita', 'margem'] },
  // Variabilidade pelo coeficiente de variação semanal (26 semanas válidas). Cortes são PREMISSA ajustada à distribuição da loja
  // (mediana do CV semanal ≈ 1,4 na classe A): os cortes clássicos 0,5/1,0 colocariam quase tudo em Z.
  xyz: { semanas: 26, cv_x: 1.0, cv_y: 2.0, min_semanas_validas: 8, dias_sem_estoque_invalida_semana: 4 },

  // ── Demanda ─────────────────────────────────────────────────────────────────
  demanda: {
    janela_dias: 90,                 // mesma janela da 1.2
    janela_longa_dias: 365,          // só para ruptura longa (poucos dias com estoque na janela curta)
    censura: {                       // correção de demanda reprimida — COM CAUTELA
      aplicar: true,
      min_dias_disponiveis: 14,      // abaixo disso a janela curta não corrige sozinha
      min_dias_disponiveis_longa: 60,
      min_dias_com_venda: 5,         // poucos pedidos grandes isolados nunca são extrapolados
      teto_multiplicador: 2,         // a velocidade corrigida nunca passa de 2× a observada
      peso: 1,                       // 0 = desliga o efeito; 1 = usa toda a correção (já limitada pelo teto)
    },
  },
  // Ruptura longa sem venda recente: não vira compra automática; vai para REVISÃO (pode ser item descontinuado).
  ruptura_cronica: { fracao_dias_sem_estoque: 0.5, min_unidades_longa: 3 },

  // ── Prazo de reposição ──────────────────────────────────────────────────────
  // Hierarquia: produto (config) → fornecedor (config) → histórico do fornecedor (proxy) → histórico geral (proxy) → premissa.
  // PROXY = dias entre emissão e última modificação de compra confirmada (não há data de pedido × recebimento).
  prazo: {
    janela_compras_dias: 540,
    ignorar_mesmo_dia: true,         // lançamento no mesmo dia = entrada registrada na chegada; não mede prazo
    min_amostras_fornecedor: 5,
    min_amostras_geral: 20,
    max_dias_validos: 90,            // acima disso é provável edição tardia
    desvio_max_fracao: 0.5,          // PREMISSA: a cauda do proxy mistura edições posteriores; a incerteza do prazo medido é limitada a 50 % do prazo
    sem_dado: { dias: 14, desvio_dias: 7 },          // PREMISSA
    importado: { dias: 60, desvio_dias: 20 },        // PREMISSA (a API não identifica importação)
    fornecedores: {},                // { id: { dias, desvio_dias, importado, confiabilidade (0..1) } }
  },
  revisao_dias: 7,                   // PREMISSA: sugestão analisada ao menos 1× por semana

  // ── Nível de serviço (chance de não faltar em um ciclo de reposição) por classe ABC × XYZ — PREMISSA a decidir pelo dono ──
  nivel_servico: { AX: 0.97, AY: 0.95, AZ: 0.95, BX: 0.95, BY: 0.92, BZ: 0.90, CX: 0.90, CY: 0.85, CZ: 0.80 },
  seguranca: {
    semanas_sigma: 26,
    winsor_percentil: 0.95,          // semanas atípicas (pedido B2B grande) são limitadas ao percentil 95
    teto_dias: { A: 45, B: 30, C: 15 },     // estoque de segurança nunca passa de N dias de venda
    min_semanas_com_venda: 4,        // venda esporádica: sem estoque de segurança automático
  },
  ciclo_dias: { A: 30, B: 21, C: 15 },       // cobertura desejada por compra (mesmos dias-alvo da 1.2)

  // ── Sazonalidade / tendência: sem 24 meses de saldo diário não há como separar de crescimento → fator manual, neutro ──
  fator_demanda: { global: 1, por_mes: {}, por_produto: {} },     // por_mes: { '11': 1.0 } aplica-se ao mês da chegada

  // ── Embalagem / mínimos (a API não informa) ─────────────────────────────────
  embalagem: { sem_cadastro: { minimo_un: 1, multiplo_un: 1 }, fornecedores: {} },     // PREMISSA quando vazio
  // Exceções por produto: { id: { minimo_un, multiplo_un, prazo_dias, prazo_desvio_dias, importado, nao_comprar } }
  produtos: {},

  transito: { idade_max_dias: 90 },  // compra "A receber/Em aberto" mais antiga que isso é ignorada (resíduo) e sinalizada
  capital: { teto_compra_cents: null, peso_classe: { A: 3, B: 2, C: 1 } },     // null = sem teto
  excesso_dias: 180,
});

const CLASSES = ['A', 'B', 'C'];

/** Mescla uma configuração do dono sobre a política base (objetos são mesclados; listas e valores substituem). */
function comConfig(base, extra) {
  const mesclar = (a, b) => {
    if (b === undefined) return a;
    if (!b || typeof b !== 'object' || Array.isArray(b) || !a || typeof a !== 'object' || Array.isArray(a)) return b;
    const out = { ...a };
    for (const k of Object.keys(b)) out[k] = mesclar(a[k], b[k]);
    return out;
  };
  const p = mesclar(JSON.parse(JSON.stringify(base)), extra || {});
  const erros = validarPolitica13(p);
  if (erros.length) { const e = new Error('POLITICA_13_INVALIDA: ' + erros.join('; ')); e.codigo = 'POLITICA_13_INVALIDA'; throw e; }
  return congelar(p);
}

function validarPolitica13(p) {
  const e = [];
  const pos = (v, n) => { if (!(typeof v === 'number' && v > 0)) e.push(n + ' deve ser número > 0'); };
  const naoNeg = (v, n) => { if (!(typeof v === 'number' && v >= 0)) e.push(n + ' deve ser número ≥ 0'); };
  if (!p || p.status !== 'SHADOW_NOT_APPROVED') e.push('status deve permanecer SHADOW_NOT_APPROVED');
  if (!p || !/SOMBRA/.test(p.policy_version || '')) e.push('policy_version deve identificar SOMBRA');
  if (e.length) return e;
  if (!(p.abc.corte_a > 0 && p.abc.corte_a < p.abc.corte_b && p.abc.corte_b <= 1)) e.push('abc: cortes fora de ordem');
  if (!(p.xyz.cv_x < p.xyz.cv_y)) e.push('xyz: cortes fora de ordem');
  pos(p.demanda.janela_dias, 'demanda.janela_dias');
  const c = p.demanda.censura;
  if (!(c.teto_multiplicador >= 1)) e.push('censura.teto_multiplicador deve ser ≥ 1');
  if (!(c.peso >= 0 && c.peso <= 1)) e.push('censura.peso deve estar entre 0 e 1');
  pos(c.min_dias_disponiveis, 'censura.min_dias_disponiveis');
  for (const k of ['sem_dado', 'importado']) { pos(p.prazo[k].dias, 'prazo.' + k + '.dias'); naoNeg(p.prazo[k].desvio_dias, 'prazo.' + k + '.desvio_dias'); }
  naoNeg(p.revisao_dias, 'revisao_dias');
  for (const a of CLASSES) for (const x of ['X', 'Y', 'Z']) { const v = p.nivel_servico[a + x]; if (!(v >= 0.5 && v < 1)) e.push('nivel_servico.' + a + x + ' deve estar em [0,5; 1)'); }
  for (const a of CLASSES) { pos(p.ciclo_dias[a], 'ciclo_dias.' + a); naoNeg(p.seguranca.teto_dias[a], 'seguranca.teto_dias.' + a); }
  pos(p.fator_demanda.global, 'fator_demanda.global');
  for (const [k, v] of [...Object.entries(p.fator_demanda.por_mes), ...Object.entries(p.fator_demanda.por_produto)]) pos(v, 'fator_demanda ' + k);
  for (const [id, x] of [...Object.entries(p.produtos), ...Object.entries(p.embalagem.fornecedores)]) {
    for (const k of ['minimo_un', 'multiplo_un']) if (x[k] !== undefined && !(Number.isInteger(x[k]) && x[k] >= 1)) e.push(`${id}.${k} deve ser inteiro ≥ 1`);
    if (x.prazo_dias !== undefined) pos(x.prazo_dias, id + '.prazo_dias');
  }
  for (const [id, x] of Object.entries(p.prazo.fornecedores)) {
    if (x.dias !== undefined) pos(x.dias, 'prazo.fornecedores.' + id + '.dias');
    if (x.confiabilidade !== undefined && x.confiabilidade !== null && !(x.confiabilidade >= 0 && x.confiabilidade <= 1)) e.push('confiabilidade deve estar entre 0 e 1: ' + id);
  }
  const t = p.capital.teto_compra_cents;
  if (t !== null && !(typeof t === 'number' && t >= 0)) e.push('capital.teto_compra_cents deve ser null ou ≥ 0');
  return e;
}

module.exports = { POLITICA_1_3_SOMBRA, comConfig, validarPolitica13 };
