'use strict';

/**
 * Shows (default) or performs the job-store cleanup by hand.
 *
 *   node --env-file=.env scripts/cleanup-jobs.js           dry run: lists what would be deleted
 *   node --env-file=.env scripts/cleanup-jobs.js --apply   deletes it
 *
 * Uses CLEANUP_RETENTION_DAYS (default 30) and CLEANUP_EVENT_RETENTION_DAYS (default 7).
 * Deleted: finished return jobs (restock/dispose complete) and old carrier event rows.
 * Never deleted: failed, manual_review, in-progress and "needs attention" jobs.
 */
const { getConfig } = require('../src/config');
const { createServer } = require('../src/app');
const { createCleanup } = require('../src/cleanup');

async function main() {
    const apply = process.argv.includes('--apply');
    const config = getConfig();
    const server = createServer({ config }); // not listening: only the job store is used
    try {
        const cleanup = createCleanup({ jobStore: server.jobStore, ...config.cleanup, dryRun: !apply });
        const summary = await cleanup.runOnce({ force: true });
        console.log(JSON.stringify({ mode: apply ? 'apply' : 'dry-run', ...summary }, null, 2));
    } finally {
        await server.jobStore.close();
    }
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});