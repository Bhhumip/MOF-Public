'use strict';

/**
 * Restocks a returned parcel in Shopify AFTER staff inspected the goods, then records it on the job.
 *
 *   node --env-file=.env scripts/restock-return.js <reverseFulfillmentOrderId> --location <locationId>
 *   e.g. gid://shopify/ReverseFulfillmentOrder/123 --location gid://shopify/Location/456
 *
 * Only the quantity that is not yet restocked/disposed is sent, so running it twice is harmless.
 * To write goods off instead (damaged, not restockable), use the return page in Shopify admin;
 * the dispose webhook then updates the job the same way.
 */
const { getConfig } = require('../src/config');
const { createShopifyClient } = require('../src/shopify');
const { createServer } = require('../src/app');

async function main() {
    const [rfoId, ...flags] = process.argv.slice(2);
    const at = flags.indexOf('--location');
    const locationId = at >= 0 ? flags[at + 1] : null;

    if (!rfoId?.startsWith('gid://shopify/ReverseFulfillmentOrder/') || !locationId?.startsWith('gid://shopify/Location/')) {
        console.error('Usage: scripts/restock-return.js gid://shopify/ReverseFulfillmentOrder/<id> --location gid://shopify/Location/<id>');
        process.exit(1);
    }

    const config = getConfig(); // refuses to run against a store that is not ALLOWED_SHOPIFY_STORE
    console.error(`Store: ${config.shopify.storeDomain}`);
    const shopify = createShopifyClient(config.shopify);

    const restock = await shopify.restockReverseFulfillmentOrder({ reverseFulfillmentOrderId: rfoId, locationId });
    console.log('Shopify restock:', JSON.stringify(restock));

    // Record the result on the job (the same code the dispose webhook runs).
    const server = createServer({ config });
    try {
        const job = await server.returns.onReverseFulfillmentOrderDisposed({ admin_graphql_api_id: rfoId });
        console.log('Job:', JSON.stringify(job, null, 2));
    } finally {
        await server.jobStore.close();
    }
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});