const test = require('node:test');
const assert = require('node:assert/strict');
const { createMongoJobStore } = require('../src/jobs-mongodb');

// Verifies that concurrent close() calls return the same Promise.
test('concurrent close calls share the same shutdown promise', async () => {
    const store = createMongoJobStore({
        uri: 'mongodb://127.0.0.1:27017'
    });

    const first = store.close();
    const second = store.close();

    assert.equal(first, second);

    await first;
});

// Verifies that update() rejects null, arrays, and other invalid patches.
test('update rejects invalid patches with a clear error', async () => {
    const store = createMongoJobStore({
        uri: 'mongodb://127.0.0.1:27017'
    });

    try {
        await assert.rejects(
            () => store.update('rfo:test-1', null),
            /Job update patch must be an object/
        );

        await assert.rejects(
            () => store.update('rfo:test-1', []),
            /Job update patch must be an object/
        );

        await assert.rejects(
            () => store.update('rfo:test-1', 'invalid'),
            /Job update patch must be an object/
        );
    } finally {
        await store.close();
    }
});


test('update rejects field names containing dots', async () => {
    const store = createMongoJobStore({
        uri: 'mongodb://127.0.0.1:27017'
    });

    try {
        await assert.rejects(
            store.update('job-1', { 'data.trackingNumber': 'TEST-123' }),
            /Invalid job field name/
        );
    } finally {
        await store.close();
    }
});

test('update rejects field names beginning with dollar signs', async () => {
    const store = createMongoJobStore({
        uri: 'mongodb://127.0.0.1:27017'
    });

    try {
        await assert.rejects(
            store.update('job-1', { '$set': { status: 'booked' } }),
            /Invalid job field name/
        );
    } finally {
        await store.close();
    }
});


// Verifies that update() rejects an empty or invalid job key.
test('update rejects an invalid job key', async () => {
    const store = createMongoJobStore({
        uri: 'mongodb://127.0.0.1:27017'
    });

    try {
        await assert.rejects(
            () => store.update('', {}),
            /A non-empty job key is required/
        );
    } finally {
        await store.close();
    }
});