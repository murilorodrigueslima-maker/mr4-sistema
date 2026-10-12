#!/usr/bin/env node
'use strict';
// Cadastra (INATIVA) a norma coletiva versionada em banco_horas_normas/{id}. Valores conferidos no texto da CCT CE000233/2026 (cl. 28ª) —
// ver ~/mr4-ops/ponto-banco/FASE3-CCT-VERIFICACAO.md. NÃO cadastra acordo da empresa, NÃO ativa política, NÃO cria saldos.
// Uso: node scripts/banco_norma.js            (dry-run: mostra o documento)
//      node scripts/banco_norma.js --aplicar  (grava; recusa sobrescrever uma norma já existente)
const NORMA = {
  id: 'cct-ce000233-2026-v1', versao: 1, ativa: false,                                    // inativa: ativar é decisão separada
  origem: { registro: 'CE000233/2026', aditivos: ['CE001390/2026'], clausula: '28ª', partes: 'SINDGEL-CE × SINCOPECE', processo: '13624.200618/2026-20' },
  vigencia: { inicio: '2026-01-01', fim: '2027-12-31' },                                      // cl. 1ª
  bancoValidoAte: '2026-12-31',                                                               // cl. 28ª n ("não podendo ultrapassar o dia 31 de dezembro de 2026") — ambiguidade registrada
  apuracaoDias: 120, compensacaoDias: 30,                                                     // cl. 28ª b, n
  fatorFolgaPorHoraExtra: 1.5,                                                                // cl. 28ª a
  limiteNegativoMesMin: 240,                                                                  // cl. 28ª h (4 h/mês; exceção pela diretoria com 24 h de antecedência)
  limiteExtraDiarioMin: 120,                                                                  // cl. 28ª k (2 h) — leitura "por dia" a confirmar
  adicionalHoraExtra: 0.55, adicionalHoraExtraDomFeriado: 1.0,                                // cl. 8ª, 28ª c/j
  exigeAcordoColetivo: true,                                                                  // cl. 28ª l, 45ª, 52ª parágrafo único
  saldoNegativoFimCiclo: 'ZERAR',                                                             // cl. 28ª i
  rescisaoSaldoNegativo: 'ZERAR_SEM_COBRANCA', rescisaoSaldoPositivo: 'PAGAR_HORA_EXTRA',      // cl. 28ª j
  apenasDiasNormaisDeFuncionamento: true,                                                     // cl. 28ª f
  pendenciasJuridicas: ['ENQUADRAMENTO_SINDICAL_DA_MR4', 'VALIDADE_ATE_31_12_2026', 'FALTAS_E_ATRASOS_COMO_HORAS_NEGATIVAS', 'FATOR_1_5_NA_CONTABILIZACAO', 'LIMITE_2H_POR_DIA'],
};
module.exports = { NORMA };
if (require.main === module) {
  const aplicar = process.argv.includes('--aplicar');
  console.log(JSON.stringify({ modo: aplicar ? 'APLICAR' : 'DRY-RUN', norma: NORMA }, null, 1));
  if (aplicar) {
    const admin = require('firebase-admin'); admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
    (async () => {
      const ref = db.doc('banco_horas_normas/' + NORMA.id);
      await db.runTransaction(async tx => { if ((await tx.get(ref)).exists) throw new Error('NORMA_JA_EXISTE (versões são imutáveis; crie uma nova versão)'); tx.create(ref, { ...NORMA, criadaEm: admin.firestore.FieldValue.serverTimestamp() }); });
      console.log(JSON.stringify({ aplicado: true, id: NORMA.id, ativa: false }));
    })().catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
  }
}
