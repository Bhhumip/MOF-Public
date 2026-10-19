
const test = require('node:test');
const assert = require('node:assert/strict');

const {
    createManualReviewQueue,
    createReasonTag
} = require('../src/manual-review');

test('creates a stable reason tag', () => {
    assert.equal(
        createReasonTag('booking_outcome_unknown'),
        'manual_review:booking_outcome_unknown'
    );

    assert.equal(
        createReasonTag('No Warehouse'),
        'manual_review:no_warehouse'
    );
});

test('adds the base manual_review tag and reason tag to the order', async () => {
    const calls = [];

    const queue = createManualReviewQueue({
        shopify: {
            async addOrderTags(orderId, tags) {
                calls.push({ orderId, tags });
            }
        },
        logger: { warn() { }, error() { } }
    });

    const result = await queue.enqueue({
        returnId: 'gid://shopify/Return/1',
        orderId: 'gid://shopify/Order/9',
        reverseFulfillmentOrderId:
            'gid://shopify/ReverseFulfillmentOrder/5',
        reason: 'no_warehouse'
    });

    assert.equal(calls.length, 1);
    assert.equal(calls[0].orderId, 'gid://shopify/Order/9');
    assert.deepEqual(calls[0].tags, [
        'manual_review',
        'manual_review:no_warehouse'
    ]);
    assert.equal(result.orderTagged, true);
});

test('does not attempt Shopify tagging when the order ID is missing', async () => {
    const warnings = [];

    const queue = createManualReviewQueue({
        shopify: {
            async addOrderTags() {
                assert.fail('Should not tag without an order ID');
            }
        },
        logger: {
            warn(message) { warnings.push(message); },
            error() { }
        }
    });

    const result = await queue.enqueue({
        returnId: 'gid://shopify/Return/1',
        reason: 'order_not_accessible'
    });

    assert.equal(result.orderTagged, false);
    assert.equal(warnings.length, 1);
});
