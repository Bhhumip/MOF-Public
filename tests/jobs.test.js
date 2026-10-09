const test = require('node:test');
const assert = require('node:assert/strict');
const { createMemoryJobStore } = require('../src/jobs');

test('the first claim wins and a second claim is a duplicate', async () => {
    const store = createMemoryJobStore();
    const first = await store.claim('rfo:1', { returnId: 'r1' });
    const second = await store.claim('rfo:1', { returnId: 'r1' });
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(second.job.status, 'processing');
});

test('two simultaneous claims produce exactly one winner', async () => {
    const store = createMemoryJobStore();
    const results = await Promise.all([store.claim('rfo:2', {}), store.claim('rfo:2', {})]);
    assert.equal(results.filter((r) => r.claimed).length, 1);
});

test('update changes a job and unknown keys throw', async () => {
    const store = createMemoryJobStore();
    await store.claim('rfo:3', {});
    const job = await store.update('rfo:3', { status: 'booked', trackingNumber: 'T1' });
    assert.equal(job.status, 'booked');
    assert.equal((await store.get('rfo:3')).trackingNumber, 'T1');
    await assert.rejects(() => store.update('rfo:missing', {}), /Unknown job/);
});