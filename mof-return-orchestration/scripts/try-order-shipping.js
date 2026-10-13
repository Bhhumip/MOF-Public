const fs = require('node:fs');
const path = require('node:path');
const { getConfig } = require('../src/config');
const { createShopifyClient } = require('../src/shopify');

async function main() {
    const args = process.argv.slice(2);
    const outIndex = args.indexOf('--out');
    const outFile = outIndex >= 0 ? args[outIndex + 1] : null;
    const orderId = args.find(
        (arg, i) => !arg.startsWith('--') && (outIndex < 0 || i !== outIndex + 1)
    );

    if (!orderId) {
        console.error('Usage: node --env-file=.env scripts/try-order-shipping.js <order number or GID> [--out file.json]');
        process.exit(1);
    }

    const { shopify } = getConfig();
    console.error(`Store: ${shopify.storeDomain}`); // must be the DEV store
    const result = await createShopifyClient(shopify).getOrderShipping(orderId);
    const json = JSON.stringify(result, null, 2);

    if (outFile) {
        fs.mkdirSync(path.dirname(outFile), { recursive: true });
        fs.writeFileSync(outFile, `${json}\n`, 'utf8');
        console.error(`Saved ${outFile}`);
    } else {
        console.log(json);
    }
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});