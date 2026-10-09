const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { createSqliteJobStore } = require('../src/jobs-sqlite');

test('the first claim wins and a second claim is a duplicate', async () => {
    const store = createSqliteJobStore(':memory:');
    const first = await store.claim('rfo:1', { returnId: 'r1' });
    const second = await store.claim('rfo:1', { returnId: 'r1' });
    assert.equal(first.claimed, true);
    assert.equal(second.claimed, false);
    assert.equal(second.job.returnId, 'r1');
    store.close();
});

test('update merges data and changes status; unknown keys throw', async () => {
    const store = createSqliteJobStore(':memory:');
    await store.claim('rfo:2', { returnId: 'r2' });
    const job = await store.update('rfo:2', { status: 'booked', trackingNumber: 'T1' });
    assert.equal(job.status, 'booked');
    assert.equal(job.trackingNumber, 'T1');
    assert.equal(job.returnId, 'r2');
    await assert.rejects(() => store.update('rfo:missing', {}), /Unknown job/);
    store.close();
});

test('jobs survive a restart: a duplicate after reopening is still detected', async () => {
    const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mof-jobs-'));
    const file = path.join(dir, 'jobs.sqlite');
    try {
        const before = createSqliteJobStore(file);
        await before.claim('rfo:3', { returnId: 'r3' });
        await before.update('rfo:3', { status: 'booked', trackingNumber: 'T3' });
        before.close();

        const after = createSqliteJobStore(file); // simulates a server restart
        const again = await after.claim('rfo:3', { returnId: 'r3' });
        assert.equal(again.claimed, false);
        assert.equal(again.job.status, 'booked');
        assert.equal(again.job.trackingNumber, 'T3');
        after.close();
    } finally {
        fs.rmSync(dir, { recursive: true, force: true });
    }
});