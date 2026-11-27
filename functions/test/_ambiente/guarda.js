'use strict';
// TRAVA DE REDE DOS TESTES. Carregada em todo processo de teste (NODE_OPTIONS --require, inclusive filhos) e pelo setupFiles do Jest.
// Só deixa conectar em: (a) portas do emulador isolado desta execução e (b) portas que o próprio processo abriu (servidores falsos).
// Qualquer outro destino — produção, GestãoClick, metadados do Google, servidores de outros projetos nesta máquina — é recusado.
const net = require('net');
const { PROIBIDAS } = require('./portas');
const MARCA = Symbol.for('mr4.guardaDeRede');
const LOCAIS = new Set(['localhost', '127.0.0.1', '::1', '0.0.0.0', '::', '::ffff:127.0.0.1']);

function destino(args) {
  let a = args[0];
  if (Array.isArray(a)) a = a[0];                                   // forma normalizada interna do Node
  if (a && typeof a === 'object') return a.path ? null : { host: String(a.host || 'localhost'), porta: Number(a.port) };
  if (typeof a === 'number' || (typeof a === 'string' && /^\d+$/.test(a))) return { host: typeof args[1] === 'string' ? args[1] : 'localhost', porta: Number(a) };
  return null;                                                      // soquete local por caminho (IPC)
}

function instalar() {
  if (net.Socket.prototype[MARCA]) return net.Socket.prototype[MARCA];
  let emulador = [];
  try { emulador = Object.values(JSON.parse(process.env.MR4_TEST_PORTAS || '{}')); } catch { emulador = []; }
  const estado = { emulador: new Set(emulador), proprias: new Set(), bloqueios: [] };
  const permitido = ({ host, porta }) => LOCAIS.has(host.replace(/^\[|\]$/g, '').toLowerCase()) && !PROIBIDAS.includes(porta) && (estado.emulador.has(porta) || estado.proprias.has(porta));

  const conectar = net.Socket.prototype.connect;
  net.Socket.prototype.connect = function conectarComGuarda(...args) {
    const d = destino(args);
    if (!d || permitido(d)) return conectar.apply(this, args);
    const erro = Object.assign(new Error(`[guarda-de-testes] conexão BLOQUEADA para ${d.host}:${d.porta} — testes só falam com o emulador isolado e com servidores abertos pelo próprio teste`), { code: 'MR4_GUARDA' });
    estado.bloqueios.push(`${d.host}:${d.porta}`);
    process.stderr.write(erro.message + '\n');
    process.nextTick(() => this.destroy(erro));
    return this;
  };
  const ouvir = net.Server.prototype.listen;
  net.Server.prototype.listen = function ouvirComRegistro(...args) {
    const d = destino(args);
    if (d && PROIBIDAS.includes(d.porta)) throw new Error(`[guarda-de-testes] a porta ${d.porta} é de outro projeto: não pode ser usada em teste`);
    this.once('listening', () => { const e = this.address(); if (e && typeof e === 'object') estado.proprias.add(e.port); });
    return ouvir.apply(this, args);
  };
  net.Socket.prototype[MARCA] = estado;
  return estado;
}

// credenciais reais nunca entram no ambiente de teste
delete process.env.GOOGLE_APPLICATION_CREDENTIALS;
delete process.env.FIREBASE_TOKEN;
process.env.GCE_METADATA_HOST = '127.0.0.1:1';

module.exports = { instalar, destino };
instalar();
