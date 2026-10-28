'use strict';

/**
 * Read-only check of the "missed webhook" query: lists approved returns of recently updated
 * orders, and whether each reverse fulfillment order already has a job.
 *
 *   node --env-file=.env scripts/list-open-returns.js [hours]     default 24
 *
 * Run it once on the dev store to confirm the query finds your test returns.
 * It books nothing and changes nothing.
 */
const { getConfig } = require('../src/config');
const { createShopifyClient } = require('../src/shopify');

async function main() {
    const hours = Number(process.argv[2] || 24);
    const client = createShopifyClient(getConfig().shopify);
    const open = await client.listOpenReturns({ since: new Date(Date.now() - hours * 3600 * 1000) });
    console.log(`${open.length} approved return(s) in the last ${hours}h`);
    for (const ret of open) {
        console.log(ret.order.name, ret.returnId, 'tags:', ret.order.tags.join(',') || '(none)',
            'RFOs:', ret.reverseFulfillmentOrders.map((rfo) => rfo.id).join(', ') || '(none open)');
    }
}

main().catch((error) => {
    console.error(error.message);
    process.exit(1);
});