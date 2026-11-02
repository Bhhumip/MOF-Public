'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { createCleanup } = require('../src/cleanup');
const { createMemoryJobStore } = require('../src/jobs');
const { createSqliteJobStore } = require('../src/jobs-sqlite');

const NOW = new Date('2026-11-30T12:00:00Z');
const daysAgo = (days) => new Date(NOW - days * 24 * 3600 * 1000).toISOString();
const silent = { info() { }, warn() { }, error() { } };

async function addJob(store, key, data = {}, { ageDays } = {}) {
    await store.claim(key, {});
    await store.update(key, data);
    if (ageDays !== undefined) (await store.get(key)).updatedAt = daysAgo(ageDays);
}

const finished = (days, extra = {}) => ({ status: 'booked', dispositionStatus: 'complete', dispositionAt: daysAgo(days), ...extra });

async function setup(options = {}) {
    const store = createMemoryJobStore();
    await addJob(store, 'rfo:old-done', finished(40));
    await addJob(store, 'rfo:recent-done', finished(5));
    await addJob(store, 'rfo:old-partial', { status: 'booked', dispositionStatus: 'partial', dispositionAt: daysAgo(40) });
    await addJob(store, 'rfo:old-attention', finished(40, { needsAttention: 'pickup_failed' }));
    await addJob(store, 'rfo:old-failed', { status: 'failed', dispositionStatus: 'complete', dispositionAt: daysAgo(40) });
    await addJob(store, 'rfo:old-writeback', finished(40, { writebackStatus: 'failed' }));
    await addJob(store, 'rfo:never-disposed', { status: 'booked' });
    await addJob(store, 'evt:old', { kind: 'carrier_event', status: 'applied' }, { ageDays: 10 });
    await addJob(store, 'evt:new', { kind: 'carrier_event', status: 'applied' }, { ageDays: 1 });
    const cleanup = createCleanup({ jobStore: store, retentionDays: 30, eventRetentionDays: 7, logger: silent, ...options });
    return { store, cleanup };
}

const keys = async (store) => (await store.list()).map((job) => job.key).sort();

test('only finished old returns and old carrier events are deleted', async () => {
    const { store, cleanup } = await setup();
    const summary = await cleanup.runOnce({ now: NOW });
    assert.equal(summary.deleted, 2);
    assert.deepEqual(await keys(store), [
        'evt:new', 'rfo:never-disposed', 'rfo:old-attention', 'rfo:old-failed',
        'rfo:old-partial', 'rfo:old-writeback', 'rfo:recent-done'
    ]);
});

test('a dry run reports what it would delete and deletes nothing', async () => {
    const { store, cleanup } = await setup({ dryRun: true });
    const summary = await cleanup.runOnce({ now: NOW });
    assert.equal(summary.wouldDelete, 2);
    assert.equal(summary.deleted, 0);
    assert.equal((await store.list()).length, 9);
});

test('runs at most once per interval unless forced', async () => {
    const { cleanup } = await setup();
    assert.equal((await cleanup.runOnce({ now: NOW })).deleted, 2);
    assert.equal((await cleanup.runOnce({ now: new Date(NOW.getTime() + 60 * 1000) })).skipped, true);
    assert.equal((await cleanup.runOnce({ now: new Date(NOW.getTime() + 61 * 60 * 1000) })).skipped, undefined);
    assert.equal((await cleanup.runOnce({ now: NOW, force: true })).skipped, undefined);
});

test('a job with no usable date is kept', async () => {
    const store = createMemoryJobStore();
    await addJob(store, 'rfo:no-date', { status: 'booked', dispositionStatus: 'complete' });
    const cleanup = createCleanup({ jobStore: store, logger: silent });
    assert.equal((await cleanup.runOnce({ now: NOW })).deleted, 0);
});

test('a store without remove() is refused', () => {
    assert.throws(() => createCleanup({ jobStore: { list: async () => [] } }), /remove/);
});

test('one failing delete is counted and the others still run', async () => {
    const { store, cleanup } = await setup();
    const original = store.remove;
    store.remove = async (key) => { if (key === 'rfo:old-done') throw new Error('boom'); return original(key); };
    const summary = await cleanup.runOnce({ now: NOW });
    assert.deepEqual([summary.deleted, summary.errors], [1, 1]);
});

test('the sqlite store removes a job and reports whether one existed', async () => {
    const store = createSqliteJobStore(':memory:');
    await store.claim('rfo:1', { a: 1 });
    assert.equal(await store.remove('rfo:1'), true);
    assert.equal(await store.remove('rfo:1'), false);
    assert.equal(await store.get('rfo:1'), null);
    // The key is free again, so it can be claimed as a new job.
    assert.equal((await store.claim('rfo:1', {})).claimed, true);
    store.close();
});