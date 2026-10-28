'use strict';

/**
 * Re-runs a return that is stuck in "failed" or "manual_review", AFTER the cause was fixed
 * (address in Shopify, order tags, ...).
 *
 *   node --env-file=.env scripts/reprocess-return.js <returnId>          e.g. gid://shopify/Return/123
 *   node --env-file=.env scripts/reprocess-return.js <returnId> --force  only after checking at the
 *                                                                        carrier that no shipment exists
 *
 * It refuses jobs that already have a tracking number, and jobs whose booking outcome is unknown
 * (unless --force). It then runs the normal flow again on the same job, so nothing is booked twice.
 * Afterwards remove the old manual_review tags from the order in Shopify by hand.
 */
const { getConfig } = require('../src/config');
const { createServer } = require('../src/app');

async function main() {
    const [returnId, ...flags] = process.argv.slice(2);
    if (!returnId) {
        console.error('Usage: scripts/reprocess-return.js <returnId> [--force]');
        process.exit(1);
    }
    const server = createServer({ config: getConfig() }); // not listening: only the services are built
    try {
        const result = await server.returns.reprocess(returnId, { force: flags.includes('--force') });
        console.log(JSON.stringify(result, null, 2));
    } finally {
        await server.jobStore.close();
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});