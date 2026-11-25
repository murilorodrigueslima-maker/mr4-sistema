'use strict';
const { resumir } = require('../lib/webhooks/relatorio');
test('resumo: duplicidade, fora de ordem, estorno, falhas e latências (p50/p95)', () => {
  const t = Date.parse('2026-11-25T10:00:00Z');
  const ev = [
    { evento: 'venda.cadastrada', recurso: 'vendas', registro_id: '1', ocorrido_em: '2026-11-25T10:00:00Z', recebido_ms: t + 2000, processado_ms: t + 5000, status: 'SOMBRA_CONCLUIDA', resultado: 'CONFERIDO', modo: 'SOMBRA' },
    { evento: 'venda.situacao_alterada', recurso: 'vendas', registro_id: '1', ocorrido_em: '2026-11-25T09:59:00Z', recebido_ms: t + 9000, status: 'PENDENTE_SOMBRA', modo: 'SOMBRA', tentativa: 2 },   // chegou depois, mas ocorreu antes
    { evento: 'recebimento.estornado', recurso: 'recebimentos', registro_id: '7', ocorrido_em: '2026-11-25T10:00:10Z', recebido_ms: t + 12000, status: 'RECEBIDO', modo: 'RECEPCAO' }];
  const r = resumir(ev);
  expect(r.total).toBe(3); expect(r.duplicadosReenviados).toBe(1); expect(r.foraDeOrdem).toBe(1); expect(r.estornos).toBe(1); expect(r.falhas).toBe(1);
  expect(r.latGcParaReceptorMs.n).toBe(3); expect(r.latReceptorParaSombraMs.p50).toBe(3000); expect(r.porModo).toEqual({ SOMBRA: 2, RECEPCAO: 1 });
});
