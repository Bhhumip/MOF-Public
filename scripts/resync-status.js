'use strict';

// Re-sends the status of booked returns to Shopify.
//   node --env-file=.env scripts/resync-status.js         only jobs whose last sync failed
//   node --env-file=.env scripts/resync-status.js --all   every booked job (e.g. the first time you switch sync on)
const { getConfig } = require('../src/config');
const { createShopifyClient } = require('../src/shopify');
const { createStatusSync } = require('../src/status-sync');
const { createSqliteJobStore } = require('../src/jobs-sqlite');
const { createMongoJobStore } = require('../src/jobs-mongodb');

async function main() {
    const config = getConfig();
    const jobStore = config.jobStore.type === 'mongodb'
        ? createMongoJobStore({ uri: config.jobStore.mongodbUri, databaseName: config.jobStore.mongodbDatabase })
        : createSqliteJobStore(config.jobStore.sqlitePath);
    const statusSync = createStatusSync({ shopify: createShopifyClient(config.shopify), enabled: true });
    const all = process.argv.includes('--all');

    try {
        const jobs = (await jobStore.list()).filter((job) => job.status === 'booked' && (all || job.statusSyncError));
        console.log(`${jobs.length} job(s) to sync`);
        for (const job of jobs) {
            let result = await statusSync.recordBooking(job);
            if (result.synced && job.carrierStatus) {
                result = await statusSync.recordEvent(job, {
                    event: job.carrierStatus, rawStatus: job.carrierStatus, occurredAt: job.updatedAt, raw: {}
                });
            }
            await jobStore.update(job.key, { statusSyncError: result.synced ? null : result.error });
            console.log(result.synced ? 'synced ' : `FAILED (${result.error}) `, job.key);
        }
    } finally {
        await jobStore.close();
    }
}

main().catch((error) => { console.error('Failed:', error.message); process.exit(1); });