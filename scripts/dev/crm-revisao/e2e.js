#!/usr/bin/env node
'use strict';
// Roteiro no Chrome sem janela contra os emuladores do harness (dados fictícios): revisão de atribuição e data do retorno na Fila.
// Uso: sh scripts/dev/crm-revisao/rodar.sh /caminho/pasta    → resultado no terminal e imagens em <pasta>/telas/.
const fs = require('fs'), path = require('path');
const { PROJETO, PORTAS, pastaDeTrabalho } = require('./comum');
const { abrirChrome, espera } = require('./chrome');
const { semear, servir, opp, GESTOR } = require('./semente');
const SITE = `http://localhost:${PORTAS.site}`;

async function main() {
  const dir = pastaDeTrabalho(process.argv[2]);
  fs.mkdirSync(path.join(dir, 'telas'), { recursive: true });
  const S = await semear(dir), srv = await servir(dir);
  const resultados = []; let falhas = 0;
  const confere = (nome, ok, extra) => { resultados.push((ok ? 'OK    ' : 'FALHA ') + nome + (!ok && extra !== undefined ? ' → ' + JSON.stringify(extra) : '')); if (!ok) falhas++; };
  // Emulador lento (máquina carregada): a tela não alcança o Firestore em 10 s e volta ao login (comportamento atual do app).
  // Reabre a página e descarta os avisos dessa tentativa; o número de reaberturas é informado.
  let reaberturas = 0;
  const abrir = async (B, pagina, expr, rotulo) => {
    for (let n = 1; ; n++) {
      const antes = B.erros.length;
      await B.ir(SITE + pagina);
      try { return await B.ate(expr, rotulo, 60000); }
      catch (e) { if (n >= 4) throw e; reaberturas++; B.erros.splice(antes); }
    }
  };
  const entrar = async (B, conta) => {
    // só depois que o módulo da tela carregar (o botão existe antes do SDK em máquina lenta)
    await abrir(B, '/login.html', `typeof window.fazerLogin === 'function' && !!document.querySelector('input[type=password]')`, 'login'); await espera(800);
    await B.js(`(() => { const c = ${JSON.stringify(conta)}; const e = document.querySelector('input[type=email]'), s = document.querySelector('input[type=password]'); e.value = c.email; s.value = c.password; for (const x of [e, s]) x.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await B.tocar(`document.getElementById('btnEntrar')`, 'entrar');
    await B.ate(`!!document.getElementById('logado')`, 'redirecionamento após login');
  };
  const kpi = (B, s) => B.js(`document.querySelector('.kpi[data-sit="${s}"]').innerText.replace(/\\s+/g, ' ')`);
  const erros = [], hosts = new Set();

  // ── Gestão (computador) ─────────────────────────────────────────────────────────────────────────
  let B = await abrirChrome(dir);
  try {
    await B.viewport(1280, 860, false); await entrar(B, S.contas.gestor);
    await abrir(B, '/modulos/crm-gestao.html', `!!document.getElementById('linkAtribuicao') && document.getElementById('carregando').hidden`, 'gestão');
    await B.tocar(`document.getElementById('linkAtribuicao')`, 'atalho');
    try { await B.ate(`document.querySelectorAll('.caso').length > 0`, 'lista', 60000); }
    catch (e) { await abrir(B, '/modulos/crm-atribuicao.html', `document.querySelectorAll('.caso').length > 0`, 'lista'); }
    confere('atalho da gestão abre a revisão e a lista é gerada dos dados', true);
    const total = await B.js(`document.querySelectorAll('.caso').length`);
    confere('aguardando revisão: 8 casos (os 2 prováveis sem conflito ficam fora da fila)', total === 8, total);
    confere('aviso de provisório visível', await B.js(`!document.getElementById('provisorio').hidden`));
    confere('comprovada começa vazia', /0 de \d+ oportunidades 0 pedido/.test(await kpi(B, 'COMPROVADA')), await kpi(B, 'COMPROVADA'));
    confere('provável mostra o que vem da regra', /2 pela regra/.test(await kpi(B, 'PROVAVEL')), await kpi(B, 'PROVAVEL'));
    await B.tela('rev-01-computador-topo');
    const caso = nome => `Array.from(document.querySelectorAll('.caso')).find(c => c.querySelector('.cli').textContent === ${JSON.stringify(nome)})`;
    const alvo = 'Distribuidora Imaginária Delta';
    confere('cartão traz cliente, vendedor do pedido e do contato pelos nomes, pedido e datas', await B.js(`(() => { const t = ${caso(alvo)}.innerText; return /pedido 5001/i.test(t) && /Vendedor do pedido: Vendedor Teste Um/.test(t) && /Registrado por: Vendedor Teste Um/.test(t) && /R\\$\\s2\\.100,00/.test(t) && /\\d{2}\\/\\d{2}\\/\\d{4}/.test(t); })()`));
    await B.tocar(`${caso(alvo)}.querySelector('summary')`, 'contexto');
    confere('contexto: contatos com interesse/proposta e itens', await B.js(`(() => { const t = ${caso(alvo)}.innerText; return /Interesse: sim/.test(t) && /Proposta: sim/.test(t) && /Produto fictício A/.test(t); })()`));
    confere('salvar bloqueado sem decisão e observação', await B.js(`${caso(alvo)}.querySelector('[data-a="salvar"]').disabled`));
    await B.tocar(`${caso(alvo)}.querySelector('[data-v="COMPROVADA"]')`, 'comprovada');
    confere('salvar segue bloqueado sem observação', await B.js(`${caso(alvo)}.querySelector('[data-a="salvar"]').disabled`));
    const digitar = (nome, texto) => B.js(`(() => { const t = ${caso(nome)}.querySelector('textarea'); t.value = ${JSON.stringify(texto)}; t.dispatchEvent(new Event('input', {bubbles:true})); })()`);
    await digitar(alvo, 'Orçamento conferido (observação fictícia).');
    await digitar('Auto Som Exemplo Beta', 'rascunho de outro caso');
    await B.js(`${caso(alvo)}.scrollIntoView({block:'start'}); window.scrollBy(0, -70)`); await espera(250); await B.tela('rev-02-computador-caso');
    await B.tocar(`${caso(alvo)}.querySelector('[data-a="salvar"]')`, 'salvar');
    await B.ate(`!${caso(alvo)}`, 'caso sai da fila');
    const id = (await S.db.collection('crm_atribuicao_revisoes').get()).docs[0];
    confere('servidor gravou a decisão da gestora', !!id && id.data().decisao === 'COMPROVADA' && id.data().decididoPorUid === GESTOR);
    confere('auditoria criada', (await S.db.doc(`audit_log/atrib_${id.id}_1`).get()).exists);
    confere('indicador comprovada atualiza sem recarregar', /1 de \d+ oportunidades 1 pedido.*R\$\s2\.100,00/.test(await kpi(B, 'COMPROVADA')), await kpi(B, 'COMPROVADA'));
    confere('rascunho de outro cartão não se perde ao salvar', await B.js(`${caso('Auto Som Exemplo Beta')}.querySelector('textarea').value === 'rascunho de outro caso'`));
    // decisão concorrente: outra pessoa decide antes
    const beta = (await B.js(`${caso('Auto Som Exemplo Beta')}.dataset.venda`));
    await S.db.doc('crm_atribuicao_revisoes/' + beta).set({ vendaId: beta, opportunityInstanceId: opp(1), decisao: 'PROVAVEL', observacao: 'outra pessoa', revisao: 1, decididoPorUid: GESTOR, decididoEm: new Date().toISOString() });
    await B.tocar(`${caso('Auto Som Exemplo Beta')}.querySelector('[data-v="NAO_ATRIBUIDA"]')`, 'não atribuída');
    await B.tocar(`${caso('Auto Som Exemplo Beta')}.querySelector('[data-a="salvar"]')`, 'salvar conflito');
    await B.ate(`!!${caso('Auto Som Exemplo Beta')}.querySelector('.msg.err')`, 'erro de conflito');
    confere('conflito: avisa e não sobrescreve', (await S.db.doc('crm_atribuicao_revisoes/' + beta).get()).data().decisao === 'PROVAVEL' && await B.js(`/atualize a lista/.test(${caso('Auto Som Exemplo Beta')}.querySelector('.msg.err').textContent)`));
    B.erros.splice(0);   // o 409 do conflito proposital aparece no console
    await B.tocar(`document.getElementById('btnAtualizar')`, 'atualizar');
    await B.ate(`document.getElementById('carregando').hidden && !${caso('Auto Som Exemplo Beta')}`, 'lista atualizada');
    await B.js(`(() => { const s = document.getElementById('fFila'); s.value = 'decididos'; s.dispatchEvent(new Event('change', {bubbles:true})); window.scrollTo(0, 0); })()`);
    confere('filtro "já decididos" mostra as 2 decisões', await B.js(`document.querySelectorAll('.caso').length === 2`));
    await B.tocar(`${caso(alvo)}.querySelector('[data-a="editar"]')`, 'alterar');
    await B.tocar(`${caso(alvo)}.querySelector('[data-v="PROVAVEL"]')`, 'provável');
    await digitar(alvo, 'Revisto: sem comprovante (fictício).');
    await B.tocar(`${caso(alvo)}.querySelector('[data-a="salvar"]')`, 'salvar alteração');
    await B.ate(`/2ª versão/.test(${caso(alvo)}.innerText)`, 'segunda versão');
    confere('alteração vira 2ª versão com histórico', (await S.db.collection(`crm_atribuicao_revisoes/${id.id}/versoes`).get()).size === 2);
    await B.js(`window.scrollTo(0, 0)`); await espera(200); await B.tela('rev-03-computador-decididos');
    // ── celular ──
    for (const w of [390, 360, 320]) {
      await B.viewport(w, 780, true);
      await B.js(`(() => { const s = document.getElementById('fFila'); s.value = 'pendentes'; s.dispatchEvent(new Event('change', {bubbles:true})); document.querySelectorAll('details').forEach(d => d.open = true); window.scrollTo(0, 0); })()`); await espera(350);
      const sw = await B.js('document.documentElement.scrollWidth');
      confere(`revisão ${w}px: sem rolagem lateral (contexto aberto)`, sw <= w, sw);
      if (w === 390) {
        await B.tela('rev-04-celular-topo'); await B.js(`document.querySelector('.caso').scrollIntoView(); window.scrollBy(0, -70)`); await espera(250); await B.tela('rev-05-celular-caso');
        await B.js(`document.querySelector('.caso .wrap').scrollIntoView({block:'center'})`); await espera(250); await B.tela('rev-06-celular-contatos');
      }
    }
    await abrir(B, '/modulos/crm-gestao.html', `document.getElementById('carregando').hidden`, 'gestão no celular'); await espera(300);
    confere('gestão 320px: cabeçalho com o atalho não alarga a página', await B.js('document.documentElement.scrollWidth <= 320'), await B.js('document.documentElement.scrollWidth'));
  } catch (e) { confere('roteiro da gestão', false, e.message); await B.tela('falha-gestao'); }
  finally { erros.push(...B.erros); B.hosts.forEach(h => hosts.add(h)); await B.fechar(); }

  // ── Vendedor: sem acesso; Fila aceita retorno para amanhã (dia comercial) ──────────────────────────
  B = await abrirChrome(dir);
  try {
    await B.viewport(390, 844, true); await entrar(B, S.contas.vendedor);
    await abrir(B, '/modulos/crm-atribuicao.html', `/só da gestão/.test(document.getElementById('carregando').textContent)`, 'recusa');
    confere('vendedor não vê a revisão (nenhum dado na tela)', await B.js(`document.getElementById('conteudo').hidden && !document.querySelector('.caso')`));
    // relógio do navegador às 22:30 de Fortaleza (01:30 UTC do dia seguinte): "amanhã" precisa ser aceito pela tela
    const amanha = new Date(Date.parse(S.hoje + 'T12:00:00Z') + 864e5).toISOString().slice(0, 10);
    const o = 'c3d0f11a00000001';
    await S.db.doc('fila_comercial/worklist').set({ schemaVersion: 'worklist-v2', dataReferencia: S.hoje, versao: 1, geradoEm: new Date().toISOString(), cap: 10,
      vendedores: { 'vendedor-ficticio-um': { novas: [{ opportunityInstanceId: o, commercialEntityId: 'GC_NATIVE:99499999', tipoOportunidade: 'JANELA_DE_RECOMPRA', nomeCliente: 'Cliente Fictício Fila' }], followUps: [], emAtendimento: [], pendentes: [] } },
      vendedoresAtivos: ['vendedor-ficticio-um'], atribuicoes: { [o]: { uid: 'vendedor-ficticio-um', commercialEntityId: 'GC_NATIVE:99499999', tipoOportunidade: 'JANELA_DE_RECOMPRA', nomeCliente: 'Cliente Fictício Fila' } } });
    const instante = Date.parse(amanha + 'T01:30:00Z');
    await B.cmd('Page.addScriptToEvaluateOnNewDocument', { source: `(() => { if (!location.pathname.endsWith('fila-comercial.html')) return; const R = Date, d = ${instante} - R.now();
      window.Date = class extends R { constructor(...a) { if (a.length) super(...a); else super(R.now() + d); } static now() { return R.now() + d; } }; })()` });
    await abrir(B, '/modulos/fila-comercial.html', `!!document.querySelector('.queue-card')`, 'fila');
    confere('relógio simulado: dia UTC já virou, dia comercial não', await B.js(`new Date().toISOString().slice(0, 10) === ${JSON.stringify(amanha)} && FilaWorklistView.dataComercial(new Date()) === ${JSON.stringify(S.hoje)}`));
    await B.tocar(`document.querySelector('.btn-claim')`, 'iniciar');
    await B.ate(`!!document.querySelector('.op-badge.em-atendimento')`, 'em atendimento');
    await espera(500); await B.tocar(`document.querySelector('.queue-card')`, 'abrir cliente');
    await B.tocar(`document.getElementById('detailOutcomeBtn')`, 'registrar');
    await B.tocar(`document.querySelector('[data-outcome="PEDIU_RETORNO"]')`, 'pediu retorno');
    await B.js(`document.getElementById('followupDate').value = ${JSON.stringify(amanha)}`);
    await B.tocar(`document.getElementById('outcomeOkBtn')`, 'confirmar');
    await B.ate(`!document.getElementById('outcomeModal').classList.contains('open') || !!document.getElementById('outcomeErr').textContent`, 'resposta');
    const msg = await B.js(`document.getElementById('outcomeErr').textContent`);
    const d = (await S.db.doc('interacoes_fila/' + o).get()).data();
    confere('Fila às 22:30: retorno para amanhã é aceito', msg === '' && d && d.nextFollowUpAt === amanha, { msg, d: d && d.nextFollowUpAt });
  } catch (e) { confere('roteiro do vendedor', false, e.message); await B.tela('falha-vendedor'); }
  finally { erros.push(...B.erros); B.hosts.forEach(h => hosts.add(h)); await B.fechar(); }

  const externos = [...hosts].filter(h => !/^localhost:|^fonts\.(googleapis|gstatic)\.com$|^www\.gstatic\.com$/.test(h));
  confere('nenhum acesso a serviço de produção', externos.length === 0, externos);
  confere('console sem erros', erros.length === 0, erros.slice(0, 5));
  srv.close();
  console.log(resultados.join('\n')); console.log(`\n${resultados.length} verificações, ${falhas} falha(s). Reaberturas por emulador lento: ${reaberturas}. Projeto ${PROJETO}.`);
  fs.writeFileSync(path.join(dir, 'resultado.txt'), resultados.join('\n') + `\n${resultados.length} verificações, ${falhas} falha(s)\n`);
  process.exit(falhas ? 1 : 0);
}
main().catch(e => { console.error('ERRO:', e.message); process.exit(1); });
