'use strict';
// Escape das telas (revisão técnica de 27/11/2026, achado 16): dado externo ou persistido nunca vira marcação nem código.
// Cada tela é desenhada duas vezes pelo código REAL da página — com texto comum e com texto hostil — e se exige:
//   (1) mesma árvore de elementos e atributos (nada injetado);
//   (2) nenhum atributo on* executa o texto, e o argumento recebido pela ação é exatamente o valor original;
//   (3) o texto hostil aparece LITERAL na tela (a aparência não muda: o valor é mostrado, não interpretado).
const X = require('./helpers/xss-telas');

const comum = k => `${k}1234`;
const hostil = k => `${k}1234${X.ATAQUE}`;

/** `desenhar(v)` → { saidas: {nome: html}, args: [valores que alguma ação deve receber intactos] }. */
async function conferir(desenhar, { visiveis = [] } = {}) {
  const a = await desenhar(comum), b = await desenhar(hostil);
  expect(Object.keys(b.saidas).sort()).toEqual(Object.keys(a.saidas).sort());
  const chamadas = [];
  for (const [nome, html] of Object.entries(b.saidas)) {
    expect([nome, a.saidas[nome].length > 0]).toEqual([nome, true]);
    expect([nome, X.esqueleto(html)]).toEqual([nome, X.esqueleto(a.saidas[nome])]);
    chamadas.push(...X.chamadasDosAtributos(html));
  }
  expect(chamadas.filter(c => c.nome === 'PWN')).toEqual([]);
  const recebidos = new Set(chamadas.flatMap(c => c.args).filter(x => typeof x === 'string'));
  for (const k of b.args || []) expect(recebidos).toContain(hostil(k));
  const texto = Object.values(b.saidas).map(h => X.analisar(h).texto).join('\n');
  for (const k of visiveis) expect(texto).toContain(hostil(k));
}

describe('o próprio verificador', () => {
  test('acusa marcação injetada e código injetado em atributo', () => {
    expect(X.esqueleto(`<b>${X.ATAQUE}</b>`)).not.toEqual(X.esqueleto('<b>x</b>'));
    const html = `<button onclick="abrir('x');PWN();//')">a</button>`;
    expect(X.chamadasDosAtributos(html).map(c => c.nome)).toEqual(['abrir', 'PWN']);
  });
});

// ── Expedição ────────────────────────────────────────────────────────────────
describe('modulos/expedicao.html', () => {
  function tela() {
    const s = X.sandbox();
    const blocos = X.blocos('modulos/expedicao.html');
    const script = blocos.find(b => b.includes('── CONFIG'));
    s.rodar(X.ler('js/expedicao-core.js')); s.rodar(X.ler('js/expedicao-medicao-core.js'));
    s.rodar(script + '\n;globalThis.__S = S;');
    s.ctx._expUsuario = { uid: 'g', papel: 'gestor' };
    return s;
  }
  const pedido = (v, coluna, extra = {}) => ({ numero: v('num'), coluna, versao: 1, ingresadoEm: Date.now() - 60000, movidoEm: Date.now(), cliente: v('cli'), vendedor: v('vend'), itens: v('itens'), valor: 10,
    cidade: v('cid'), hora: v('hora'), data: '2020-01-0' + v('data'), envio: v('envio'), saidaEm: Date.now(), ...extra });

  test('cartões nas quatro colunas (com e sem medição, lote e seleção)', async () => {
    await conferir(v => {
      const s = tela(); const saidas = {};
      for (const col of ['ag', 'se', 'pr', 'de']) { const p = pedido(v, col); s.ctx.__S.pedidos = { [p.numero]: p }; saidas['card-' + col] = s.ctx.renderCard(p); }
      s.ctx.__S.medCfg = { ativa: true };
      for (const col of ['pr', 'de']) { const p = pedido(v, col, col === 'de' ? { envio: 'rota-manha' } : {}); s.ctx.__S.pedidos = { [p.numero]: p }; saidas['med-' + col] = s.ctx.renderCard(p); }
      const a = pedido(v, 'se'), b = pedido(v, 'se', { numero: v('num2') }); s.ctx.__S.pedidos = { [a.numero]: a, [b.numero]: b };
      s.ctx.__S.medRegs = [a, b].map(p => ({ pedido: p.numero, tipo: 'MARCA', etapa: 'INICIAR_SEPARACAO', versao: 1, lote: v('lote') }));
      saidas.selo = s.ctx.renderCard(a);
      s.ctx.__S.sel = { col: 'se', nums: new Set() }; saidas.selecao = s.ctx.renderCard(a);
      return { saidas, args: ['num', 'lote'] };
    }, { visiveis: ['cli', 'vend', 'cid', 'hora', 'envio'] });
  });

  test('janelas de despacho, cancelamento, reabertura, problema e lote', async () => {
    await conferir(v => {
      const s = tela(); const saidas = {};
      const p = pedido(v, 'pr'); s.ctx.__S.pedidos = { [p.numero]: p }; s.ctx.__S.medCfg = { ativa: true };
      const ler = (nome, id) => { saidas[nome] = s.elementos[id].innerHTML; };
      s.ctx.abrirDespacho(p.numero); ler('envio', 'modalInfo');
      s.ctx.abrirCancelModal(p.numero); ler('cancelar', 'cancelInfo');
      p.coluna = 'x' + v('coluna'); s.ctx.abrirCancelModal(p.numero); ler('cancelar-coluna', 'cancelInfo'); p.coluna = 'pr';
      s.ctx.abrirReabrirModal(p.numero); ler('reabrir', 'reabrirInfo');
      s.ctx.abrirProblemaModal(p.numero); ler('problema', 'problemaInfo');
      s.ctx.abrirModalLote('despachar', [p.numero]); ler('lote', 'modalInfo');
      return { saidas };
    }, { visiveis: ['cli', 'vend', 'num', 'envio', 'coluna'] });
  });

  test('aviso (toast) com nome de cliente e número hostis', async () => {
    await conferir(v => {
      const s = tela(); s.ctx.toast(`❌ Pedido #${v('num')} cancelado — ${v('cli')}`, 't-error');
      return { saidas: { toast: s.criados[s.criados.length - 1].innerHTML } };
    }, { visiveis: ['num', 'cli'] });
  });

  test('texto comum continua idêntico (sem entidade visível)', () => {
    const s = tela(); const p = { ...pedido(comum, 'ag'), numero: '1000001', cliente: '123 Oficina São João & Cia', envio: null };
    const t = X.analisar(s.ctx.renderCard(p)).texto;
    expect(t).toContain('Oficina São João & Cia'); expect(s.ctx.renderCard(p)).toContain('id="card-1000001"'); expect(s.ctx.renderCard(p)).toContain("iniciarSeparacao('1000001')");
  });
});

// ── Garantia ─────────────────────────────────────────────────────────────────
describe('modulos/garantia.html', () => {
  const registro = (v, etapa, id) => ({ id: v(id), etapa, cliNome: v('cli'), cliTel: v('tel'), prodNome: v('prod'), prodCod: v('cod'), fornec: v('forn'), prazo: v('prazo'), defeito: v('defeito'),
    substNome: v('snome'), substCod: v('scod'), obs: v('obs'), recebidoEm: '2020-01-01' + v('receb'), valor: 10, lancadoGC: false, criadoEm: 1 });
  function tela(fornecedores = []) {
    const s = X.sandbox({ _col: n => n, _getDocs: async () => ({ docs: fornecedores.map(nome => ({ data: () => ({ nome }) })) }) });
    const script = X.blocos('modulos/garantia.html').find(b => b.includes('── ETAPAS'));
    s.rodar(script + '\n;globalThis.__set = l => { garantias = l; };');
    return s;
  }
  test('visão geral, quadros, histórico, etapa, baixa, recibo e fornecedores', async () => {
    await conferir(async v => {
      const s = tela([v('fornlista')]); const saidas = {};
      s.ctx.__set([registro(v, 'ag_envio', 'ida'), registro(v, 'cli_ok', 'idb'), registro(v, 'recebido', 'idc')]);
      const ler = (nome, id) => { saidas[nome] = s.elementos[id].innerHTML; };
      s.ctx.renderVisaoGeral(); ler('alerta', 'alertaLista'); ler('recentes', 'lista-recentes');
      s.ctx.renderKanbanF1(); ler('f1', 'kanban-f1'); s.ctx.renderKanbanF2(); ler('f2', 'kanban-f2'); ler('prontas', 'prontas-f2-lista');
      s.ctx.renderHistorico(); ler('historico', 'hist-tbody');
      s.ctx.abrirModalEtapa(v('idc')); ler('etapa', 'etapaOpts');
      s.ctx.abrirModalGC(v('ida')); ler('baixa', 'gc-dados');
      s.ctx.abrirRecibo(v('ida')); ler('recibo', 'recibo-conteudo');
      await s.ctx.carregarFornecedores(); ler('datalist', 'fornec-datalist');
      expect(X.analisar(saidas.datalist).elems[0].attrs.value).toBe(v('fornlista'));
      return { saidas, args: ['ida', 'idb', 'idc'] };
    }, { visiveis: ['cli', 'tel', 'prod', 'cod', 'forn', 'prazo', 'defeito', 'snome', 'scod', 'obs'] });
  });
});

// ── Marketing ────────────────────────────────────────────────────────────────
describe('modulos/marketing.html', () => {
  test('quadro, ideias, legendas e calendário', async () => {
    await conferir(v => {
      const s = X.sandbox();
      s.rodar(X.blocos('modulos/marketing.html').find(b => b.includes('── ETAPAS')) + '\n;globalThis.__set = (c, i, l) => { conteudos = c; ideias = i; legendas = l; };');
      const hojeIso = new Date().toISOString().slice(0, 8) + '15';
      s.ctx.__set([{ id: v('cid'), etapa: 'gravar', tipo: v('tipo'), titulo: v('tit'), desc: v('desc'), data: hojeIso, criadoEm: 1 }],
        [{ id: v('iid'), texto: v('ideia'), tipo: v('itipo'), criadoEm: 1 }], [{ id: v('lid'), cat: v('cat'), nome: v('lnome'), texto: v('ltexto'), criadoEm: 1 }]);
      const saidas = {}; const ler = (nome, id) => { saidas[nome] = s.elementos[id].innerHTML; };
      s.ctx.renderKanban(); ler('quadro', 'kanban'); s.ctx.renderIdeias(); ler('ideias', 'lista-ideias');
      s.ctx.renderLegendas(); ler('filtros', 'filtros-legenda'); ler('legendas', 'grid-legendas');
      s.ctx.renderCalendario(); ler('calendario', 'cal-grid');
      return { saidas, args: ['cid', 'iid', 'lid', 'cat'] };
    }, { visiveis: ['tit', 'desc', 'tipo', 'ideia', 'itipo', 'cat', 'lnome', 'ltexto'] });
  });
});

// ── Demandas ─────────────────────────────────────────────────────────────────
describe('modulos/demandas.html', () => {
  test('responsáveis, lista, detalhe e comentários', async () => {
    await conferir(v => {
      const s = X.sandbox();
      const d = { id: v('did'), titulo: v('tit'), descricao: v('desc'), status: v('status'), prioridade: 'alta', responsavelNome: v('resp'), criadoEm: '2020-01-01', comentarios: [{ autorNome: v('autor'), texto: v('coment'), data: '2020-01-01' }] };
      Object.assign(s.ctx, { USUARIOS: [{ uid: v('uid'), nome: v('unome') }, { uid: 'u2', email: v('email') }], DEMANDAS: [d], filtroAtivo: 'todas', CURRENT_USER: { uid: 'a' }, demandaAtualId: null });
      s.rodar(X.extrair('modulos/demandas.html', ['PRIO_COLOR', 'PRIO_LABEL', 'renderSelectUsuarios', 'listaFiltrada', 'renderLista', 'renderDetalhe', 'renderStatusActions', 'renderComentarios', 'statusLabel', 'prazoTag', 'formatData', 'formatData2', 'escHtml', 'escH', 'escJs']));
      const saidas = {}; const ler = (nome, id) => { saidas[nome] = s.elementos[id].innerHTML; };
      s.ctx.renderSelectUsuarios(); ler('usuarios', 'fResponsavel'); s.ctx.renderLista(); ler('lista', 'listBody');
      s.ctx.renderDetalhe(d); ler('meta', 'detMeta'); ler('comentarios', 'commentsList');
      const opcao = X.analisar(saidas.usuarios).elems[0].attrs; expect([opcao.value, opcao['data-nome']]).toEqual([v('uid'), v('unome')]);
      return { saidas, args: ['did'] };
    }, { visiveis: ['unome', 'email', 'tit', 'desc', 'status', 'resp', 'autor', 'coment'] });
  });
});

// ── Equivalentes (tela própria e aba do Estoque) ─────────────────────────────
describe('grupos de produtos equivalentes', () => {
  const grupo = v => ({ id: v('gid'), nome: v('nome'), descricao: v('desc'), produtos: [{ codigo: v('cod'), nome: v('pnome'), fabricante: v('fab'), obs: v('obs') }] });
  test.each([['modulos/equivalentes.html', 'cardHtml', ['cardHtml', 'esc', 'fmtData', 'escH', 'escJs'], ['nome', 'desc', 'cod', 'pnome', 'fab', 'obs']],
    ['modulos/estoque.html', 'eqCardHtml', ['eqCardHtml', 'eqEsc', 'eqFmtData', 'escJs'], ['nome', 'desc', 'cod', 'pnome', 'fab']]])('%s', async (arq, fn, nomes, visiveis) => {
    await conferir(v => { const s = X.sandbox(); s.rodar(X.extrair(arq, nomes)); return { saidas: { cartao: s.ctx[fn](grupo(v)) }, args: ['gid'] }; }, { visiveis });
  });
});

// ── Administração ────────────────────────────────────────────────────────────
describe('modulos/admin.html', () => {
  test('usuários, contas do ponto e confirmações', async () => {
    await conferir(v => {
      const s = X.sandbox();
      Object.assign(s.ctx, {
        todosUsuarios: [{ uid: v('uid'), nome: v('nome'), email: v('email'), cargo: v('cargo'), modulos: [] }],
        todaFuncionarios: [{ id: v('f1'), nome: v('fnome'), email: v('femail') }, { id: v('f2'), nome: v('fnome') }, { id: v('f3'), nome: v('fnome') }],
        usersMapPonto: null, pontoAcaoPendente: null,
      });
      s.ctx.usersMapPonto = { [v('f2')]: { uid: v('u2'), ativo: true, email: v('femail') }, [v('f3')]: { uid: v('u3'), ativo: false } };
      s.rodar(X.extrair('modulos/admin.html', ['MODULOS_DEF', 'renderTabela', 'renderTabelaPonto', 'pedirConfirmacaoReset', 'pedirConfirmacaoCriar', 'escH', 'escJs']));
      const saidas = {}; const ler = (nome, id) => { saidas[nome] = s.elementos[id].innerHTML; };
      s.ctx.renderTabela(s.ctx.todosUsuarios); ler('usuarios', 'tbodyUsuarios');
      s.ctx.renderTabelaPonto(); ler('ponto', 'tbodyPonto');
      s.ctx.pedirConfirmacaoReset(v('f1')); ler('reset', 'pontoModalMsg');
      s.ctx.pedirConfirmacaoCriar(v('f1')); ler('criar', 'pontoModalMsg');
      return { saidas, args: ['uid', 'f1', 'f2'] };
    }, { visiveis: ['nome', 'email', 'cargo', 'fnome', 'femail'] });
  });
});

// ── CRM Clientes ─────────────────────────────────────────────────────────────
describe('modulos/clientes.html', () => {
  const NOMES = ['renderLista', 'abrirDetalhe', 'renderNotas', 'renderMsgs', 'renderInbox', 'renderPipeline', 'renderPainelCRM', 'renderVendas', 'renderCustomTagsModal', 'abrirChatInbox', 'atualizarContadores', 'setFollowUp',
    'PIPELINE_STAGES', 'normalizar', 'formatarData', 'escapeHtml', 'fmtPhone', 'formatarTelefone55', 'formatarHoraInbox', 'matchClientePorPhone', 'tempoEspera', 'temMsgNaoLida', 'isEsquecido', 'isSemContato3', 'diasSemContato', 'atualizarChatStatusBar', 'escH', 'escJs'];
  const hojeIso = () => new Date().toISOString();
  async function desenhar(v) {
    const s = X.sandbox({ showTab() {}, updateDoc: async () => {}, doc: () => ({}), db: {}, mostrarToast() {} });
    const uf = v('uf'), fone = '558599990000' + v('fone'), fone2 = '558588880000' + v('fone2');
    const cliente = { id: v('cid'), nome: v('nome'), telefone: fone, email: v('email'), cidade: v('cidade'), estado: uf, tags: [v('tag')], pipeline: 'lead', followUp: '2000-01-01' + v('follow'),
      segmento: v('seg'), cpf_cnpj: v('doc'), notas: [{ texto: v('nota'), data: hojeIso() }], vendas: [{ produto: v('vprod'), obs: v('vobs'), data: v('vdata'), valor: 1 }], ultimoContato: '2000-01-01' };
    const chats = [{ phone: fone, name: v('chatnome'), lastMessageBody: v('msg'), lastMessageTime: Date.now() - 3600000, lastFromMe: false },
      { phone: fone2, name: v('novonome'), lastMessageBody: v('msg2'), lastMessageTime: Date.now() - 3600000, lastFromMe: false }];
    Object.assign(s.ctx, { CLIENTES: [cliente], GARANTIAS: [{ clienteNome: v('nome'), produtoNome: v('gprod'), defeito: v('gdef'), status: v('gstatus') }], CHATS: chats, CHATS_UNREAD: {}, CHAT_PINS: new Set(), CHAT_STATUS: { [fone]: v('cstatus') },
      CUSTOM_TAGS: [v('ctag')], modoAtivo: 'clientes', inboxPhoneAtual: null, clienteAtualId: v('cid'), filtroAtivo: 'todos', inboxFiltro: 'todas', tabAtiva: 'info' });
    s.rodar(X.extrair('modulos/clientes.html', NOMES));
    const saidas = {}; const ler = (nome, id) => { saidas[nome] = s.elementos[id].innerHTML; };
    s.ctx.atualizarContadores(); ler('estados', 'sidebarEstados');
    s.ctx.renderLista([cliente]); ler('lista', 'listBody');
    s.ctx.abrirDetalhe(v('cid')); ler('contatos', 'detContacts'); ler('followup', 'iFollowUp'); ler('tags', 'iTags'); ler('garantias', 'garantiasList'); ler('notas', 'notasList');
    saidas.mensagens = s.ctx.renderMsgs([{ fromMe: false, message: v('whats'), momment: Date.now() }]);
    s.ctx.renderInbox(chats); ler('inbox', 'listBody');
    s.ctx.abrirChatInbox(fone); ler('chat-contatos', 'detContacts'); ler('chat-tags', 'iTags');
    s.ctx.renderPipeline(); ler('pipeline', 'listBody');
    s.ctx.renderPainelCRM(); ler('painel', 'listBody');
    s.ctx.renderVendas(cliente); ler('vendas', 'vendasList');
    s.ctx.renderCustomTagsModal(); ler('tags-proprias', 'customTagsGrid');
    s.ctx.clienteAtualId = v('cid'); await s.ctx.setFollowUp('2000-01-01'); ler('followup2', 'iFollowUp');
    return { saidas, args: ['cid', 'ctag'], fone };
  }
  test('lista, detalhe, notas, conversas, pipeline, painel, vendas e tags', async () => {
    await conferir(desenhar, { visiveis: ['nome', 'email', 'cidade', 'tag', 'gprod', 'gdef', 'gstatus', 'nota', 'whats', 'vprod', 'vobs', 'vdata', 'ctag', 'novonome'] });   // a prévia da conversa é cortada pela tela
    const inbox = X.analisar((await desenhar(hostil)).saidas.inbox).texto; expect(inbox).toContain(hostil('msg').slice(0, 50));
  });
  test('o telefone hostil chega intacto à ação de abrir conversa', async () => {
    const r = await desenhar(hostil);
    expect(X.chamadasDosAtributos(r.saidas.inbox).filter(c => c.nome === 'abrirChatInbox').map(c => c.args[0])).toContain(r.fone);
  });
});

// ── Vendas e painel de prévia ────────────────────────────────────────────────
describe('nomes de vendedor', () => {
  test('modulos/vendas.html — iniciais e nome', async () => {
    const desenhar = nome => { const s = X.sandbox(); s.rodar(X.extrair('modulos/vendas.html', ['renderTeam', 'escHtml', 'brl'])); s.ctx.renderTeam([{ nome, faturamento: 1, pedidos: 1 }]); return s.elementos.vendedoresBody.innerHTML; };
    expect(X.esqueleto(desenhar('<b x'))).toEqual(X.esqueleto(desenhar('ab cd')));
    expect(desenhar('<b x')).toContain('&lt;X');
  });
  test('painel-comercial-preview.html', async () => {
    await conferir(v => {
      const s = X.sandbox({ T: new Proxy({}, { get: (_t, k) => (k === 'ranking' ? l => l.map(x => ({ nome: x.nome, totalMes: x.totalMes })) : k === 'faltaEPorDia' ? () => ({ batida: false, falta: 0, porDia: 0 }) : k === 'avisoCalendario' ? () => [] : () => '0') }),
        IC: {}, animar() {}, anterior: null });
      s.rodar('var $ = id => document.getElementById(id);\n' + X.extrair('painel-comercial-preview.html', ['render', 'dm', 'num', 'escH']));
      s.ctx.render({ vendedores: [{ nome: v('vendedor'), totalMes: 1, meta: 1 }] });
      return { saidas: { vendedores: s.elementos.sellers.innerHTML } };
    }, { visiveis: ['vendedor'] });
  });
});

// ── Ponto ────────────────────────────────────────────────────────────────────
describe('ponto', () => {
  test('e-mail da conta aparece literal na lista de contas', async () => {
    await conferir(async v => {
      const s = X.sandbox({ fbGet: async c => (c === 'funcionarios' ? [{ id: 'f1', nome: 'Pessoa' }] : [{ funcionarioId: 'f1', email: v('email') }]), aplicarLazyFotos() {} });
      s.rodar(X.extrair('modulos/ponto.html', ['renderContas', 'ativos', 'iniciais', 'esc', 'sid', 'sjs', 'escJs']));
      await s.ctx.renderContas();
      return { saidas: { contas: s.elementos['lista-contas'].innerHTML } };
    }, { visiveis: ['email'] });
  });

  test('horários do espelho (motor 4.x e 3.x, com e sem rótulo de origem) não viram marcação', () => {
    const s = X.sandbox(); s.rodar(X.ler('modulos/ponto-regras.js'));
    const snap = (v, extra) => ({ ...extra, dias: [{ data: '2020-01-02', diaSemana: 4, entrada: v('e'), saidaAlmoco: v('sa'), retornoAlmoco: v('ra'), saida: v('s'), totalMin: 480, saldoDia: 0, status: 'ok', ocorrencia: '' }] });
    const origem = v => ({ dias: { '2020-01-02': { entrada: { hora: v('e'), origem: 'justificativa' }, saida: { hora: v('s'), encerramentoDireto: true } } } });
    const casos = v => ({ v4: s.ctx.renderEspelhoRowsHTML(snap(v, { engineVersion: '4.1.0' })), v4origem: s.ctx.renderEspelhoRowsHTML(snap(v, { engineVersion: '4.1.0' }), origem(v)), v3: s.ctx.renderEspelhoRowsHTML(snap(v, { engineVersion: '3.0.0' })) });
    const a = casos(comum), b = casos(hostil);
    for (const k of Object.keys(a)) {
      expect([k, X.esqueleto(`<table>${b[k]}</table>`)]).toEqual([k, X.esqueleto(`<table>${a[k]}</table>`)]);
      expect(X.analisar(`<table>${b[k]}</table>`).texto).toContain(hostil('sa'));
    }
    expect(s.ctx.renderEspelhoRowsHTML(snap(() => '08:00', { engineVersion: '4.1.0' }))).toContain('>08:00</td>');
  });
});

// ── Regra geral ──────────────────────────────────────────────────────────────
describe('regra geral dos atributos on*', () => {
  test('nenhuma tela usa escape de HTML dentro de código de atributo on* (a entidade é decodificada antes de o código rodar)', () => {
    const fs = require('fs'), path = require('path'), raiz = path.resolve(__dirname, '../..');
    const arquivos = [...fs.readdirSync(path.join(raiz, 'modulos')).filter(f => /\.(html|js)$/.test(f)).map(f => 'modulos/' + f), ...fs.readdirSync(raiz).filter(f => f.endsWith('.html'))];
    const ruins = [];
    for (const f of arquivos) X.ler(f).split('\n').forEach((l, i) => { if (/\son[a-z]+="[^"]*'(\$\{|'\+)\s*(esc|escH|escHtml|escapeHtml|eqEsc)\(/.test(l)) ruins.push(`${f}:${i + 1}`); });
    expect(ruins).toEqual([]);
  });
});
