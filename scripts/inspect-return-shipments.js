'use strict';

const { getConfig } = require('../src/config');
const { createShopifyClient, toOrderGid } = require('../src/shopify');

const LIST = `
  query ListReturnShipments {
    metaobjects(type: "$app:return_shipment", first: 20) {
      nodes { handle updatedAt fields { key value } }
    }
  }
`;
const ORDER_LINKS = `
  query OrderLinks($id: ID!) {
    order(id: $id) { name metafield(namespace: "$app", key: "return_shipments") { value } }
  }
`;

async function main() {
    const { shopify } = getConfig();
    const client = createShopifyClient(shopify);
    console.error(`Store: ${shopify.storeDomain}`);

    const data = await client.query(LIST);
    for (const node of data.metaobjects.nodes) {
        const f = Object.fromEntries(node.fields.map((x) => [x.key, x.value]));
        console.log({ handle: node.handle, order: f.order_name, tracking: f.tracking_number, status: f.status, raw: f.status_raw, lastEvent: f.last_event_at });
    }

    const orderArg = process.argv[2];
    if (orderArg) {
        const result = await client.query(ORDER_LINKS, { id: toOrderGid(orderArg) });
        console.log('order link:', result.order?.name, result.order?.metafield?.value ?? '(none)');
    }
}

main().catch((error) => { console.error('Failed:', error.message); process.exit(1); });