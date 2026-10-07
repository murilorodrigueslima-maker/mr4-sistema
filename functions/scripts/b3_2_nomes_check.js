#!/usr/bin/env node
'use strict';
// B3.2 — verifica (SOMENTE LEITURA) a consulta de nome no GestãoClick para uma amostra da primeira onda. Imprime APENAS contagens (nunca nomes).
const admin = require('firebase-admin'); const cp = require('child_process');
const R = require('../lib/reativacao120'); const { carregarContexto } = require('../lib/reativacaoContexto'); const { criarLookupNomeGC, resolverNomesSelecionados } = require('../lib/filaNomes');
admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
const seg = n => cp.execFileSync('gcloud', ['secrets', 'versions', 'access', 'latest', `--secret=${n}`, '--project=mr4-ponto'], { stdio: ['ignore', 'pipe', 'ignore'] }).toString().trim();
(async () => {
  const hoje = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Fortaleza' }).format(new Date()); const ctx = await carregarContexto(db, { hoje });
  const plano = R.planejarLiberacao({ hoje, carteiras: ctx.carteiras, semCarteira: ctx.semCarteira, vendasPorCliente: ctx.vendasPorCliente, vend: ctx.vend, conflitosGc: ctx.conflitosGc, naoContatar: ctx.naoContatar, cooldowns: ctx.cooldowns, followUps: ctx.followUps, reservasExistentes: ctx.reservasExistentes, devolucoes: ctx.devolucoes, incluirSemCarteira: true });
  const lookup = criarLookupNomeGC({ accessToken: seg('GC_ACCESS_TOKEN'), secretToken: seg('GC_SECRET_ACCESS_TOKEN') }); const n = Math.min(Number(process.argv[2]) || 20, 20);
  const itens = plano.liberar.slice(0, n).map(it => ({ gestaoClickId: it.id, nomeCliente: null }));
  const lento = async gc => { await new Promise(r => setTimeout(r, 400)); return lookup(gc); };
  const r = await resolverNomesSelecionados(itens, { lookupNome: lento, max: n });
  const por = {}; r.itens.forEach(i => { por[i.nameResolved] = (por[i.nameResolved] || 0) + 1; });
  console.log(JSON.stringify({ ok: true, amostra: itens.length, resolvidos: r.itens.filter(i => i.nomeCliente).length, naoResolvidos: r.naoResolvidos, porSituacao: por, nomeComDocumentoSanitizado: lookup.stats.sanitized, nomeVazioAposSanitizar: lookup.stats.sanitizedEmpty, escritas: 0 }, null, 1)); process.exit(0);
})().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
