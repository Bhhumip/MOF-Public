const test = require('node:test');
const assert = require('node:assert/strict');
const { createReturnOrchestrator, resolveReturnCarrier } = require('../src/returns');

test('return orchestration delegates carrier selection to the resolver', () => {
  const match = resolveReturnCarrier({ tags: ['aramex', 'printed'] });
  assert.equal(match.carrier, 'aramex');
  assert.equal(match.reason, 'matched');
});

test('return orchestrator returns the resolved carrier without calling an adapter', async () => {
  const orchestrator = createReturnOrchestrator();
  const result = await orchestrator.handle({ tags: ['Paytabs', 'RedBox'] });
  assert.equal(result.carrier, 'redbox');
  assert.equal(result.reason, 'matched');
});

test('onReturnApproved books with the carrier chosen by tags', async () => {
  const calls = [];
  const carriers = {
    redbox: {
      name: 'redbox',
      async createReturnShipment(payload, options) {
        calls.push({ payload, options });
        return { dryRun: true, trackingNumber: 'T1' };
      }
    }
  };
  const orchestrator = createReturnOrchestrator({ carriers });

  const result = await orchestrator.onReturnApproved({
    id: 'r1',
    reverse_fulfillment_order_id: 'rfo1',
    tags: ['RedBox']
  });

  assert.equal(result.carrier, 'redbox');
  assert.equal(result.action, 'dry_run');
  assert.equal(calls.length, 1);
  assert.equal(calls[0].options.idempotencyKey, 'rfo:rfo1');
});

test('onReturnApproved queues a return with no carrier tag and books nothing', async () => {
  const queued = [];
  const orchestrator = createReturnOrchestrator({
    carriers: {},
    manualReviewQueue: { async enqueue(record) { queued.push(record); } }
  });

  const result = await orchestrator.onReturnApproved({
    id: 'r2',
    reverse_fulfillment_order_id: 'rfo2',
    tags: ['Paytabs', 'printed']
  });

  assert.equal(result.action, 'manual_review');
  assert.equal(result.reason, 'no_carrier_tag');
  assert.equal(queued.length, 1);
});
test('a dry-run booking is never written back to Shopify', async () => {
  let shopifyCalled = false;
  const shopify = {
    async createReverseDeliveryWithShipping() { shopifyCalled = true; }
  };
  const carriers = {
    aramex: {
      name: 'aramex',
      async createReturnShipment() { return { dryRun: true, trackingNumber: 'DRYRUN-1' }; }
    }
  };
  const orchestrator = createReturnOrchestrator({ shopify, carriers });

  const result = await orchestrator.onReturnApproved({
    id: 'r3', reverse_fulfillment_order_id: 'rfo3', tags: ['aramex']
  });

  assert.equal(result.action, 'dry_run');
  assert.equal(shopifyCalled, false);
});

test('a real booking is written back to Shopify with its tracking number', async () => {
  const written = [];
  const shopify = {
    async createReverseDeliveryWithShipping(input) { written.push(input); }
  };
  const carriers = {
    redbox: {
      name: 'redbox',
      async createReturnShipment() { return { trackingNumber: 'TRK1', trackingUrl: null }; }
    }
  };
  const orchestrator = createReturnOrchestrator({ shopify, carriers });

  const result = await orchestrator.onReturnApproved({
    id: 'r4', reverse_fulfillment_order_id: 'rfo4', tags: ['RedBox']
  });

  assert.equal(result.action, 'booked');
  assert.equal(written.length, 1);
  assert.equal(written[0].reverseFulfillmentOrderId, 'rfo4');
  assert.equal(written[0].trackingInput.number, 'TRK1');
  assert.equal(written[0].trackingInput.company, 'redbox');
});