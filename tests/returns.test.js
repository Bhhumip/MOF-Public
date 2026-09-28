const test = require('node:test');
const assert = require('node:assert/strict');
const { createReturnOrchestrator, resolveReturnCarrier } = require('../src/returns');

test('return orchestration delegates carrier selection to the resolver', () => {
  assert.equal(
    resolveReturnCarrier({ shippingLines: [{ title: 'Aramex Returns' }] }),
    'aramex'
  );
});

test('return orchestrator returns the resolved carrier without calling an adapter', async () => {
  const orchestrator = createReturnOrchestrator();

  assert.deepEqual(
    await orchestrator.handle({ shippingLines: [{ title: 'RedBox Returns' }] }),
    { carrier: 'redbox' }
  );
});