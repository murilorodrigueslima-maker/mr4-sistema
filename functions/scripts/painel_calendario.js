#!/usr/bin/env node
'use strict';
// painel_calendario/default — calendário comercial do Painel (configurável). Feriados classificados por EVIDÊNCIA de vendas reais (GestãoClick, 2025–2026):
// FECHADO só onde a loja de fato não vendeu; NORMAL onde vendeu. Sem evidência (datas futuras) vale a regra do negócio: sem expediente (verificado:false).
// Dry-run por padrão; --aplicar cria (recusa sobrescrever). Não toca o Ponto nem as metas.
const F = (data, nome, ambito, expediente, verificado, evidencia, extra = {}) => ({ data, nome, ambito, expediente, verificado, evidencia, ...extra });
const CAL = {
  inicio: '08:30', horasDiaCompleto: 9, horasPorDiaSemana: { 0: 0, 1: 9, 2: 9, 3: 9, 4: 9, 5: 9, 6: 3.5 },
  feriados: [
    F('2026-01-01', 'Ano Novo', 'nacional', 'FECHADO', true, 'sem vendas em 01/01/2025 e 01/01/2026'),
    F('2026-02-16', 'Carnaval (segunda)', 'nacional', 'FECHADO', true, 'sem vendas em 03/03/2025 e 16/02/2026'),
    F('2026-02-17', 'Carnaval (terça)', 'nacional', 'FECHADO', true, 'sem vendas em 04/03/2025 e 17/02/2026'),
    F('2026-02-18', 'Quarta-feira de Cinzas', 'nacional', 'REDUZIDO', true, 'vendeu 7 pedidos em 18/02/2026 (expediente parcial)', { horas: 4 }),
    F('2026-03-19', 'São José (Ceará)', 'estadual', 'NORMAL', true, 'vendeu 4 pedidos em 19/03/2026'),
    F('2026-04-03', 'Sexta-feira Santa', 'nacional', 'FECHADO', true, 'sem vendas em 03/04/2026'),
    F('2026-04-21', 'Tiradentes', 'nacional', 'NORMAL', true, 'vendeu 10 pedidos em 21/04/2026'),
    F('2026-05-01', 'Dia do Trabalho', 'nacional', 'FECHADO', true, 'sem vendas em 01/05/2026'),
    F('2026-06-04', 'Corpus Christi', 'nacional', 'NORMAL', true, 'vendeu 12 pedidos em 04/06/2026'),
    F('2026-07-25', 'Abolição Escravatura CE', 'estadual', 'NORMAL', true, 'vendeu 15 pedidos em 25/07/2026 (sábado)'),
    F('2026-08-15', 'N.Sra. da Assunção', 'municipal', 'NORMAL', true, 'vendeu 13 pedidos em 15/08/2026 (sábado)'),
    F('2026-09-07', 'Independência do Brasil', 'nacional', 'FECHADO', true, 'sem vendas em 07/09/2026'),
    F('2026-09-21', 'Dia da categoria (CCT autopeças, cl. 51ª/aditivo)', 'convencao', 'NORMAL', true, 'vendeu 8 pedidos em 21/09/2026: a loja não observou; aplicabilidade da CCT não confirmada'),
    F('2026-10-12', 'N.Sra. Aparecida', 'nacional', 'FECHADO', false, 'sem evidência em dia útil (2025 caiu no domingo): regra padrão sem expediente'),
    F('2026-10-30', 'Dia da categoria (CCT autopeças, cl. 51ª)', 'convencao', 'NORMAL', false, 'aplicabilidade da CCT não confirmada; em 21/09/2026 a loja funcionou'),
    F('2026-11-02', 'Finados', 'nacional', 'FECHADO', false, 'sem evidência em dia útil: regra padrão sem expediente'),
    F('2026-11-20', 'Consciência Negra', 'nacional', 'NORMAL', true, 'vendeu 14 pedidos em 20/11/2025 (quinta)'),
    F('2026-12-08', 'N.Sra. da Conceição', 'municipal', 'NORMAL', true, 'vendeu 22 pedidos em 08/12/2025 (segunda)'),
    F('2026-12-25', 'Natal', 'nacional', 'FECHADO', true, 'sem vendas em 25/12/2025'),
  ],
  excecoes: [],
  fonte: 'Lista de feriados do módulo Ponto (leitura) + evidência de vendas GestãoClick; revisar a cada ano.', versao: 1,
};
module.exports = { CAL };
if (require.main === module) {
  console.log(JSON.stringify({ modo: process.argv.includes('--aplicar') ? 'APLICAR' : 'DRY-RUN', feriados: CAL.feriados.length }, null, 1));
  if (process.argv.includes('--aplicar')) {
    const admin = require('firebase-admin'); admin.initializeApp({ projectId: 'mr4-ponto', credential: admin.credential.applicationDefault() }); const db = admin.firestore();
    const ref = db.doc('painel_calendario/default');
    db.runTransaction(async tx => { if ((await tx.get(ref)).exists) throw new Error('CALENDARIO_JA_EXISTE'); tx.create(ref, { ...CAL, criadoEm: admin.firestore.FieldValue.serverTimestamp() }); })
      .then(() => console.log(JSON.stringify({ aplicado: true }))).catch(e => { console.log(JSON.stringify({ ok: false, erro: e.message })); process.exit(2); });
  }
}
