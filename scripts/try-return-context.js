const { getConfig } = require('../src/config');
const { createShopifyClient, toOrderGid } = require('../src/shopify');

const ORDER_RETURNS = `
  query ($id: ID!) { order(id: $id) { returns(first: 5) { nodes { id } } } }
`;

async function main() {
    const orderId = process.argv[2];
    if (!orderId) {
        console.error('Usage: node --env-file=.env scripts/try-return-context.js <order number or GID>');
        process.exit(1);
    }
    const { shopify } = getConfig();
    console.error(`Store: ${shopify.storeDomain}`); // must be the DEV store
    const client = createShopifyClient(shopify);

    const data = await client.query(ORDER_RETURNS, { id: toOrderGid(orderId) });
    const ids = (data.order?.returns.nodes || []).map((node) => node.id);
    if (ids.length === 0) {
        console.error('This order has no returns.');
        return;
    }
    for (const id of ids) {
        console.log(JSON.stringify(await client.getReturnContext(id), null, 2));
    }
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});