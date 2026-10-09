const test = require('node:test');
const assert = require('node:assert/strict');
const { createReturnOrchestrator, resolveReturnCarrier } = require('../src/returns');

const DEFAULT_RFO = 'gid://shopify/ReverseFulfillmentOrder/5';

const approvedPayload = {
  admin_graphql_api_id: 'gid://shopify/Return/1',
  order: { admin_graphql_api_id: 'gid://shopify/Order/9' }
};

// Details shaped like what shopify.getReturnShipmentDetails() returns.
// Each RFO gets one line item, and the fulfillment order holds all of them.
function makeDetails(rfoIds, { noWarehouse = false } = {}) {
  return {
    returnId: 'gid://shopify/Return/1',
    order: {
      id: 'gid://shopify/Order/9',
      name: '#1090',
      email: 'customer@example.com',
      phone: null,
      shippingAddress: {
        name: 'Test Customer', company: null, address1: '1 Test St', address2: null,
        city: 'Riyadh', province: null, zip: '11111', countryCodeV2: 'SA', phone: '0500000000'
      },
      fulfillmentOrders: [{
        id: 'gid://shopify/FulfillmentOrder/2',
        assignedLocation: {
          name: 'Warehouse A', address1: '2 Depot Rd', address2: null, city: 'Jeddah',
          province: null, zip: '21000', countryCode: 'SA', phone: null
        },
        lineItemIds: noWarehouse
          ? ['gid://shopify/LineItem/999']
          : rfoIds.map((_, index) => `gid://shopify/LineItem/${index + 4}`)
      }]
    },
    reverseFulfillmentOrders: rfoIds.map((id, index) => ({
      id,
      lineItems: [{
        lineItemId: `gid://shopify/LineItem/${index + 4}`,
        sku: `SKU${index + 1}`,
        name: 'Scrub Top',
        quantity: 1
      }]
    }))
  };
}

function fakeShopify({
  tags,
  rfoIds = [DEFAULT_RFO],
  missing = false,
  noWarehouse = false,
  detailsMissing = false
} = {}) {
  const written = [];
  return {
    written,
    async getReturnContext(returnId) {
      if (missing) return null;
      return {
        returnId,
        status: 'OPEN',
        order: { id: 'gid://shopify/Order/9', name: '#1090', tags },
        reverseFulfillmentOrders: rfoIds.map((id) => ({ id, status: 'OPEN' }))
      };
    },
    async getReturnShipmentDetails() {
      if (detailsMissing) return null;
      return makeDetails(rfoIds, { noWarehouse });
    },
    async createReverseDeliveryWithShipping(input) {
      written.push(input);
    }
  };
}

function fakeCarrier(name, { dryRun = false } = {}) {
  const calls = [];
  return {
    name,
    calls,
    async createReturnShipment(payload, options) {
      calls.push({ payload, options });
      return dryRun
        ? { dryRun: true, trackingNumber: 'DRYRUN-1' }
        : { trackingNumber: 'TRK1', trackingUrl: null };
    }
  };
}

test('resolveReturnCarrier uses the order tags', () => {
  const match = resolveReturnCarrier({ tags: ['aramex', 'printed'] });
  assert.equal(match.carrier, 'aramex');
  assert.equal(match.reason, 'matched');
});

test('handle returns the resolved carrier without calling an adapter', async () => {
  const orchestrator = createReturnOrchestrator();
  const result = await orchestrator.handle({ tags: ['Paytabs', 'RedBox'] });
  assert.equal(result.carrier, 'redbox');
  assert.equal(result.reason, 'matched');
});

test('approve fetches the return, resolves by tag and books with an idempotency key', async () => {
  const redbox = fakeCarrier('redbox');
  const shopify = fakeShopify({ tags: ['Paytabs', 'RedBox'] });
  const orchestrator = createReturnOrchestrator({ shopify, carriers: { redbox } });

  const { results } = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(results[0].carrier, 'redbox');
  assert.equal(results[0].action, 'booked');
  assert.equal(redbox.calls[0].options.idempotencyKey, `rfo:${DEFAULT_RFO}`);
  assert.equal(shopify.written.length, 1);
  assert.equal(shopify.written[0].trackingInput.number, 'TRK1');
  assert.equal(shopify.written[0].trackingInput.company, 'redbox');
});

test('the adapter receives the neutral returnShipment', async () => {
  const redbox = fakeCarrier('redbox');
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ tags: ['RedBox'] }),
    carriers: { redbox }
  });

  await orchestrator.onReturnApproved(approvedPayload);

  const shipment = redbox.calls[0].payload;
  assert.equal(shipment.returnId, 'gid://shopify/Return/1');
  assert.equal(shipment.reverseFulfillmentOrderId, DEFAULT_RFO);
  assert.equal(shipment.warehouse.name, 'Warehouse A');
  assert.equal(shipment.customer.address.city, 'Riyadh');
  assert.equal(shipment.items.length, 1);
});

test('a dry-run booking is never written back to Shopify', async () => {
  const aramex = fakeCarrier('aramex', { dryRun: true });
  const shopify = fakeShopify({ tags: ['aramex'] });
  const orchestrator = createReturnOrchestrator({ shopify, carriers: { aramex } });

  const { results } = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(results[0].action, 'dry_run');
  assert.equal(shopify.written.length, 0);
});

test('the same approve webhook twice books only once', async () => {
  const redbox = fakeCarrier('redbox');
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ tags: ['RedBox'] }),
    carriers: { redbox }
  });

  const first = await orchestrator.onReturnApproved(approvedPayload);
  const second = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(first.results[0].action, 'booked');
  assert.equal(second.results[0].action, 'duplicate');
  assert.equal(redbox.calls.length, 1);
});

test('two simultaneous approve webhooks book only once', async () => {
  const redbox = fakeCarrier('redbox');
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ tags: ['RedBox'] }),
    carriers: { redbox }
  });

  await Promise.all([
    orchestrator.onReturnApproved(approvedPayload),
    orchestrator.onReturnApproved(approvedPayload)
  ]);

  assert.equal(redbox.calls.length, 1);
});

test('no carrier tag goes to the review queue and books nothing', async () => {
  const queued = [];
  const redbox = fakeCarrier('redbox');
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ tags: ['Paytabs', 'printed'] }),
    carriers: { redbox },
    manualReviewQueue: { async enqueue(record) { queued.push(record); } }
  });

  const { results } = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(results[0].action, 'manual_review');
  assert.equal(results[0].reason, 'no_carrier_tag');
  assert.equal(queued.length, 1);
  assert.equal(redbox.calls.length, 0);
});

test('both carrier tags go to manual review', async () => {
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ tags: ['RedBox', 'aramex'] }),
    carriers: { redbox: fakeCarrier('redbox'), aramex: fakeCarrier('aramex') }
  });

  const { results } = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(results[0].reason, 'conflicting_carrier_tags');
});

test('an unreadable return goes to manual review as order_not_accessible', async () => {
  const queued = [];
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ missing: true }),
    manualReviewQueue: { async enqueue(record) { queued.push(record); } }
  });

  const { results } = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(results[0].reason, 'order_not_accessible');
  assert.equal(queued.length, 1);
});

test('missing warehouse data sends the return to manual review without booking', async () => {
  const queued = [];
  const redbox = fakeCarrier('redbox');
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ tags: ['RedBox'], noWarehouse: true }),
    carriers: { redbox },
    manualReviewQueue: { async enqueue(record) { queued.push(record); } }
  });

  const { results } = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(results[0].action, 'manual_review');
  assert.equal(results[0].reason, 'no_warehouse');
  assert.equal(redbox.calls.length, 0);
  assert.equal(queued.length, 1);
});

test('unreadable shipment details go to manual review without booking', async () => {
  const redbox = fakeCarrier('redbox');
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ tags: ['RedBox'], detailsMissing: true }),
    carriers: { redbox }
  });

  const { results } = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(results[0].reason, 'details_not_accessible');
  assert.equal(redbox.calls.length, 0);
});

test('each reverse fulfillment order is booked separately', async () => {
  const redbox = fakeCarrier('redbox');
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({
      tags: ['RedBox'],
      rfoIds: [DEFAULT_RFO, 'gid://shopify/ReverseFulfillmentOrder/6']
    }),
    carriers: { redbox }
  });

  const { results } = await orchestrator.onReturnApproved(approvedPayload);

  assert.equal(results.length, 2);
  assert.equal(redbox.calls.length, 2);
});

test('a failed booking marks the job failed and rethrows', async () => {
  const broken = {
    name: 'redbox',
    async createReturnShipment() { throw new Error('carrier down'); }
  };
  const orchestrator = createReturnOrchestrator({
    shopify: fakeShopify({ tags: ['RedBox'] }),
    carriers: { redbox: broken }
  });

  await assert.rejects(() => orchestrator.onReturnApproved(approvedPayload), /carrier down/);
});

test('a payload without a return id is rejected', async () => {
  const orchestrator = createReturnOrchestrator({ shopify: fakeShopify({ tags: [] }) });
  await assert.rejects(() => orchestrator.onReturnApproved({}), /admin_graphql_api_id/);
});