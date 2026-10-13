
const test = require('node:test');
const assert = require('node:assert/strict');
const { MongoClient } = require('mongodb');
const { createMongoJobStore } = require('../src/jobs-mongodb');

const uri = process.env.MONGODB_TEST_URI;

test(
    'MongoDB job store claims, updates and persists jobs',
    { skip: !uri && 'Set MONGODB_TEST_URI to run MongoDB integration tests' },
    async () => {
        const databaseName = `mof_jobs_test_${process.pid}_${Date.now()}`;

        const store = createMongoJobStore({
            uri,
            databaseName
        });

        try {

            const first = await store.claim('return-1', {
                returnId: 'return-1'
            });

            const duplicate = await store.claim('return-1', {
                returnId: 'different-return',
                trackingNumber: 'SHOULD-NOT-BE-SAVED'
            });

            assert.equal(first.claimed, true);
            assert.equal(duplicate.claimed, false);

            // A duplicate claim must return the original job data.
            assert.equal(duplicate.job.returnId, 'return-1');
            assert.equal(duplicate.job.trackingNumber, undefined);


            assert.equal(first.claimed, true);
            assert.equal(duplicate.claimed, false);
            assert.equal(duplicate.job.status, 'processing');

            const updated = await store.update('return-1', {
                status: 'booked',
                trackingNumber: 'TEST-123'
            });

            assert.equal(updated.status, 'booked');
            assert.equal(updated.trackingNumber, 'TEST-123');

            const persisted = await store.get('rfo:test-1');

            assert.equal(persisted.status, 'booked');
            assert.equal(persisted.trackingNumber, 'TEST-123');

            const jobs = await store.list();

            assert.equal(
                jobs.some((job) => job.key === 'rfo:test-1'),
                true
            );

            await assert.rejects(
                () => store.update('rfo:missing', {}),
                /Unknown job/
            );

        } finally {
            await store.close();

            const cleanupClient = new MongoClient(uri);

            try {
                await cleanupClient.connect();
                await cleanupClient.db(databaseName).dropDatabase();
            } finally {
                await cleanupClient.close();
            }
        }

    }
);
