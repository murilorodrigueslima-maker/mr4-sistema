'use strict';
// S7 — handlers dos gatilhos de auditoria (puros em relação ao Firebase: db/FieldValue injetáveis p/ teste).
const A = require('./auditoria');

const dados = snap => (snap && snap.exists ? snap.data() : null);
function fabrica(db, FieldValue) {
  const base = async (event, entityType, diff, source, comAtorDoContexto) => {
    const antes = dados(event.data && event.data.before), depois = dados(event.data && event.data.after);
    const itens = diff(antes, depois);
    if (!itens.length) return 0;
    const ator = comAtorDoContexto ? await A.enriquecerAtor(db, A.atorDoContexto(event.authType, event.authId)) : { uid: null, type: 'SYSTEM', origin: 'SERVER' };
    const id = (event.params && (event.params.uid || event.params.clienteId || event.params.oppId)) || 'x';
    return A.auditarMudanca({ db, FieldValue, eventId: event.id, ator, entityType, entityId: id, source, itens });
  };
  return {
    users: ev => base(ev, 'users', A.diffUsers, 'TRIGGER:users', true),
    sistemaUsuarios: ev => base(ev, 'sistema_usuarios', A.diffSistemaUsuarios, 'TRIGGER:sistema_usuarios', true),
    clientes: ev => base(ev, 'clientes', A.diffClientes, 'TRIGGER:clientes', true),
    interacoes: ev => base(ev, 'interacoes_fila', A.diffInteracoes, 'TRIGGER:interacoes_fila', false),
  };
}
module.exports = { fabrica };
