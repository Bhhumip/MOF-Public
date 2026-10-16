const test = require('node:test');
const assert = require('node:assert/strict');
const { createStatusSync, rfoHandle } = require('../src/status-sync');

const quiet = { warn() { } };
const RFO = 'gid://shopify/ReverseFulfillmentOrder/27807449386';
const job = {
    reverseFulfillmentOrderId: RFO, returnId: 'gid://shopify/Return/1', orderId: 'gid://shopify/Order/9',
    orderName: '#1103', carrier: 'redbox', trackingNumber: '191794157456', trackingUrl: 'https://t.example/1'
};

function fakeShopify({ failUpsert = false } = {}) {
    const calls = [];
    return {
        calls,
        async upsertReturnShipmentRecord(handle, fields) {
            calls.push({ op: 'upsert', handle, fields });
            if (failUpsert) throw new Error('Access denied');
            return { id: 'gid://shopify/Metaobject/77', handle };
        },
        async linkReturnShipmentToOrder(orderId, metaobjectId) { calls.push({ op: 'link', orderId, metaobjectId }); },
        async addOrderTags(orderId, tags) { calls.push({ op: 'tag', orderId, tags }); },
    };
}


test('the handle is stable and lowercase', () => {
    assert.equal(rfoHandle(RFO), 'rfo-27807449386');
});

test('disabled: nothing is written', async () => {
    const shopify = fakeShopify();
    const result = await createStatusSync({ shopify, enabled: false, logger: quiet }).recordBooking(job);
    assert.equal(result.synced, false);
    assert.equal(shopify.calls.length, 0);
});

test('booking creates the record as "created" and links it to the order', async () => {
    const shopify = fakeShopify();
    const result = await createStatusSync({ shopify, enabled: true, logger: quiet }).recordBooking(job);
    assert.equal(result.synced, true);
    assert.equal(shopify.calls[0].handle, 'rfo-27807449386');
    assert.equal(shopify.calls[0].fields.status, 'created');
    assert.equal(shopify.calls[0].fields.tracking_number, '191794157456');
    assert.deepEqual(shopify.calls[1], { op: 'link', orderId: 'gid://shopify/Order/9', metaobjectId: 'gid://shopify/Metaobject/77' });
});

test('a carrier event updates the same record and does not touch the order link', async () => {
    const shopify = fakeShopify();
    await createStatusSync({ shopify, enabled: true, logger: quiet }).recordEvent(job, {
        event: 'returned', rawStatus: 'returned', occurredAt: '2026-10-14T09:15:30.123Z', raw: { status_name: 'Returned' }
    });
    assert.equal(shopify.calls.length, 2);
    assert.equal(shopify.calls[0].handle, 'rfo-27807449386');
    assert.equal(shopify.calls[0].fields.status, 'returned');
    assert.equal(shopify.calls[0].fields.status_raw, 'Returned');
    assert.equal(shopify.calls[0].fields.last_event_at, '2026-10-14T09:15:30Z');
    assert.deepEqual(shopify.calls[1], { op: 'tag', orderId: 'gid://shopify/Order/9', tags: ['Return-Received'] });
});

test('a Shopify failure is contained and reported, never thrown', async () => {
    const shopify = fakeShopify({ failUpsert: true });
    const result = await createStatusSync({ shopify, enabled: true, logger: quiet }).recordBooking(job);
    assert.equal(result.synced, false);
    assert.match(result.error, /Access denied/);
});

test('only the milestone statuses add a tag', async () => {
    const shopify = fakeShopify();
    const sync = createStatusSync({ shopify, enabled: true, logger: quiet });
    await sync.recordEvent(job, { event: 'in_transit', rawStatus: 'in_transit_r', raw: {} });
    assert.equal(shopify.calls.filter((c) => c.op === 'tag').length, 0);
    await sync.recordEvent(job, { event: 'expired', rawStatus: 'expired', raw: {} });
    assert.deepEqual(shopify.calls.find((c) => c.op === 'tag').tags, ['Return-Attention']);
});
