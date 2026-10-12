// E2E do gatilho pontoProtegerMesAssinado no emulador. Uso: firebase emulators:exec --only functions,firestore --project demo-mr4 "node functions/scripts/ponto_trigger_e2e.js". Dados sintéticos; nunca produção.

const admin=require('firebase-admin');
admin.initializeApp({projectId:'demo-mr4'});const db=admin.firestore();
(async()=>{
  await db.doc('espelhos/E_TESTE_1').set({funcId:'F_SINT',mes:'2026-09',assinado:false,versao:1});
  await new Promise(r=>setTimeout(r,4000));
  const antes=(await db.doc('ponto_meses_protegidos/F_SINT_2026-09').get()).exists;
  await db.doc('espelhos/E_TESTE_1').update({assinado:true});
  let depois=false; for(let i=0;i<20&&!depois;i++){await new Promise(r=>setTimeout(r,1500));depois=(await db.doc('ponto_meses_protegidos/F_SINT_2026-09').get()).exists;}
  console.log(JSON.stringify({marcadorAntesDeAssinar:antes,marcadorDepoisDeAssinar:depois,doc:depois?(await db.doc('ponto_meses_protegidos/F_SINT_2026-09').get()).data().origem:null}));
})().catch(e=>{console.log('ERR',e.message);process.exit(1)});
