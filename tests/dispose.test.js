'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createReturnOrchestrator } = require('../src/returns');
const { createMemoryJobStore } = require('../src/jobs');

const RFO = 'gid://shopify/ReverseFulfillmentOrder/5';
const KEY = `rfo:${RFO}`;

async function setup({ summary, job = {} } = {}) {
    const jobStore = createMemoryJobStore();
    await jobStore.claim(KEY, {});
    await jobStore.update(KEY, {
        status: 'booked', returnId: 'gid://shopify/Return/1', orderId: 'gid://shopify/Order/9',
        awaitingInspection: true, needsAttention: 'returned', ...job
    });
    const calls = { reads: 0, tags: [] };
    const shopify = {
        async getReverseFulfillmentDispositions() { calls.reads += 1; return summary; },
        async addOrderTags(orderId, tags) { calls.tags.push([orderId, tags]); }
    };
    const orchestrator = createReturnOrchestrator({ shopify, jobStore });
    return { orchestrator, jobStore, calls };
}

const complete = { total: 2, disposed: 2, byType: { RESTOCKED: 2 }, complete: true };
const partial = { total: 2, disposed: 1, byType: { RESTOCKED: 1 }, complete: false };

test('a fully restocked return is recorded, cleared from the inspection queue and tagged once', async () => {
    const { orchestrator, jobStore, calls } = await setup({ summary: complete });
    const result = await orchestrator.onReverseFulfillmentOrderDisposed({ admin_graphql_api_id: RFO });
    assert.equal(result.status, 'complete');

    const job = await jobStore.get(KEY);
    assert.equal(job.dispositionStatus, 'complete');
    assert.deepEqual(job.dispositionByType, { RESTOCKED: 2 });
    assert.equal(job.awaitingInspection, false);
    assert.equal(job.needsAttention, null);
    assert.deepEqual(calls.tags, [['gid://shopify/Order/9', ['Return-Completed']]]);

    // A repeated webhook gives the same result and does not tag again.
    await orchestrator.onReverseFulfillmentOrderDisposed({ admin_graphql_api_id: RFO });
    assert.equal(calls.tags.length, 1);
});

test('a partly processed return stays in the inspection queue and is not tagged', async () => {
    const { orchestrator, jobStore, calls } = await setup({ summary: partial });
    const result = await orchestrator.onReverseFulfillmentOrderDisposed({ admin_graphql_api_id: RFO });
    assert.equal(result.status, 'partial');

    const job = await jobStore.get(KEY);
    assert.equal(job.dispositionStatus, 'partial');
    assert.equal(job.awaitingInspection, true);
    assert.equal(job.needsAttention, 'returned');
    assert.equal(calls.tags.length, 0);
});

test('other attention flags are not cleared by a disposition', async () => {
    const { orchestrator, jobStore } = await setup({ summary: complete, job: { needsAttention: 'pickup_failed' } });
    await orchestrator.onReverseFulfillmentOrderDisposed({ admin_graphql_api_id: RFO });
    assert.equal((await jobStore.get(KEY)).needsAttention, 'pickup_failed');
});

test('a reverse fulfillment order we have no job for is ignored without asking Shopify', async () => {
    const { orchestrator, calls } = await setup({ summary: complete });
    const result = await orchestrator.onReverseFulfillmentOrderDisposed({
        admin_graphql_api_id: 'gid://shopify/ReverseFulfillmentOrder/999'
    });
    assert.deepEqual([result.status, result.reason], ['ignored', 'not_our_job']);
    assert.equal(calls.reads, 0);
});

test('a payload without any reverse fulfillment order id is ignored', async () => {
    const { orchestrator } = await setup({ summary: complete });
    const result = await orchestrator.onReverseFulfillmentOrderDisposed({ something: 'else' });
    assert.deepEqual([result.status, result.reason], ['ignored', 'no_rfo_id']);
});

test('the id is found in a nested payload and from a numeric reverse_fulfillment_order_id', async () => {
    const { orchestrator } = await setup({ summary: complete });
    const nested = await orchestrator.onReverseFulfillmentOrderDisposed({ reverse_fulfillment_order_line_item: { reverse_fulfillment_order_id: 5 } });
    assert.equal(nested.reverseFulfillmentOrderId, RFO);
});

test('a tagging failure does not undo the recorded disposition', async () => {
    const { jobStore } = await setup({ summary: complete });
    const failing = createReturnOrchestrator({
        jobStore,
        shopify: {
            async getReverseFulfillmentDispositions() { return complete; },
            async addOrderTags() { throw new Error('boom'); }
        }
    });
    const result = await failing.onReverseFulfillmentOrderDisposed({ admin_graphql_api_id: RFO });
    assert.equal(result.status, 'complete');
    const job = await jobStore.get(KEY);
    assert.equal(job.dispositionStatus, 'complete');
    assert.notEqual(job.completionTagged, true);
});