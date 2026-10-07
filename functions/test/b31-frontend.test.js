'use strict';
// B3.1 — telas: reativação aparece no fluxo normal (Hoje), sem escrita direta e sem escolha de owner/data/vendedor.
const fs = require('fs'), path = require('path');
const V = require('../../modulos/crm-view.js');
const hoje = '2026-10-07', agoraMs = Date.parse('2026-10-07T13:00:00Z');
const item = (id, ex = {}) => ({ opportunityInstanceId: id, commercialEntityId: 'GC_NATIVE:123456', tipoOportunidade: 'REATIVACAO_120D', nomeCliente: 'Cliente X', contextoComercial: { versao: 'V1', motivo: 'm', rotuloTipo: 'Reativação 120 dias', historico: { diasSemComprar: 150, ultimaCompraEm: '2026-05-10' } },
  reativacao: { chave: 'REATIVE', semCarteira: false, reservaAte: '2026-10-14', followUpAte: null, estado: 'RESERVADA', bloqueadoContato: false }, ...ex });
describe('B3.1 — montarHoje com reativações', () => {
  test('reserva do vendedor vira cartão na seção reativações (independe da worklist do dia); sem duplicar; estado visual correto', () => {
    const v = V.montarHoje({ doc: null, opMap: new Map(), uid: 'u1', hoje, agoraMs, podeOperar: true, reativacoes: [item('aaaaaaaaaaaaaaaa'), item('aaaaaaaaaaaaaaaa')] });
    expect(v.reativacoes).toHaveLength(1); expect(v.contagens.reativacoes).toBe(1); expect(v.reativacoes[0]).toMatchObject({ grupoOrigem: 'reativacoes', estado: { codigo: 'DISPONIVEL', podeIniciar: true } });
    const m = V.modeloCartao(v.reativacoes[0], null, null); expect(m.nome).toBe('Cliente X'); expect(m.linhas.find(l => l.k === 'Dias sem comprar').v).toBe('150'); expect(m.tipo).toBe('Reativação 120 dias');
  });
  test('sem reservas: seção vazia; em atendimento e concluída refletem o estado da oportunidade', () => {
    expect(V.montarHoje({ doc: null, opMap: new Map(), uid: 'u1', hoje, agoraMs, podeOperar: true }).reativacoes).toEqual([]);
    const op = new Map([['bbbbbbbbbbbbbbbb', { estado: 'EM_ATENDIMENTO', claimAtual: { operadorId: 'u1', claimadoEm: '2026-10-07T12:00:00Z' }, eventos: [] }]]);
    expect(V.montarHoje({ doc: null, opMap: op, uid: 'u1', hoje, agoraMs, podeOperar: true, reativacoes: [item('bbbbbbbbbbbbbbbb')] }).reativacoes[0].estado.codigo).toBe('EM_ATENDIMENTO_MEU');
  });
});
describe('B3.1 — crm.html', () => {
  const h = fs.readFileSync(path.join(__dirname, '../../modulos/crm.html'), 'utf8');
  test('mostra reativação (sem carteira, reserva, bloqueio de contato) e exige motivo no follow-up', () => {
    expect(h).toContain("['reativacoes', 'Reativação (120 dias)'"); expect(h).toMatch(/Sem carteira — a reserva não cria carteira/); expect(h).toMatch(/NÃO CONTATAR — bloqueado pela gestão/); expect(h).toMatch(/Motivo do follow-up \(obrigatório\)/);
  });
  test('nenhuma escrita direta e nenhum controle de owner/vendedor/data de 120 dias na tela', () => {
    expect(h).not.toMatch(/setDoc|updateDoc|addDoc|deleteDoc|writeBatch/); expect(h).not.toMatch(/ownerUid|novoOwner|transferir|cicloAncoraEm|destinoUid/);
  });
});
