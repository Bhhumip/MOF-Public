const test = require('node:test');
const assert = require('node:assert/strict');
const { createServer } = require('../src/app');

// Verifies that closing the HTTP server closes the injected job store.
test('closing the HTTP server closes the job store', async () => {
    let storeClosed = false;

    const jobStore = {
        close: async () => {
            storeClosed = true;
        }
    };

    const config = {
        shopify: {
            storeDomain: 'example.myshopify.com',
            adminAccessToken: 'test-token',
            webhookSecret: 'test-secret'
        },
        jobStore: {
            type: 'sqlite',
            sqlitePath: ':memory:'
        },
        carriers: {
            redbox: { mode: 'dry-run' },
            aramex: { mode: 'dry-run' }
        },
        carrierMode: 'dry-run',
        defaultItemWeightKg: 1,
        port: 0
    };

    const server = createServer({ config, jobStore });

    try {
        await new Promise((resolve, reject) => {
            server.once('error', reject);
            server.listen(0, '127.0.0.1', resolve);
        });

        await new Promise((resolve, reject) => {
            server.close((error) => {
                if (error) reject(error);
                else resolve();
            });
        });

        // Wait for the asynchronous close handler to finish.
        await new Promise((resolve) => setImmediate(resolve));

        assert.equal(storeClosed, true);
    } finally {
        if (server.listening) {
            await new Promise((resolve) => server.close(resolve));
        }
    }
});