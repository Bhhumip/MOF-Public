'use strict';

// Read-only inspector. Never prints order names, IDs or customer data.
const domain = process.env.CLIENT_SHOP_DOMAIN;
const token = process.env.CLIENT_ACCESS_TOKEN;
const version = process.env.CLIENT_API_VERSION || '2026-07';

if (!domain || !token) {
    console.error('Set CLIENT_SHOP_DOMAIN and CLIENT_ACCESS_TOKEN in this PowerShell session first.');
    process.exit(1);
}

const SCOPES_QUERY = `query { currentAppInstallation { app { title handle } accessScopes { handle } } }`;

const SHIPPING_QUERY = `
  query ($first: Int!, $after: String) {
    orders(first: $first, after: $after, reverse: true) {
      pageInfo { hasNextPage endCursor }
      nodes {
        id
        shippingLines(first: 5) {
          nodes { title code source carrierIdentifier custom shippingRateHandle }
        }
      }
    }
  }
`;

const ORDER_QUERY = `
  query ($id: ID!) {
    order(id: $id) {
    tags
    customAttributes { key }
    metafields(first: 10) { nodes { namespace key } }
      shippingLines(first: 5) { nodes { id title code source carrierIdentifier custom } }
      fulfillments(first: 5) { status trackingInfo(first: 3) { company } 
      fulfillmentLineItems(first: 10) { nodes { lineItem { id } } }
       }
      fulfillmentOrders(first: 5) {
        nodes {
          id
          assignedLocation { name address1 address2 city zip countryCode province }
          lineItems(first: 10) {
            nodes { id totalQuantity lineItem { id } shippingLine { id title } }
          }
        }
      }
      returns(first: 5) {
        nodes {
          id
          status
          reverseFulfillmentOrders(first: 5) {
            nodes {
              id
              lineItems(first: 10) {
                nodes { id totalQuantity fulfillmentLineItem { lineItem { id } } }
              }
            }
          }
        }
      }
    }
  }
`;

async function gql(query, variables = {}) {
    if (/\bmutation\b/i.test(query)) throw new Error('Mutations are blocked in this read-only script');
    const response = await fetch(`https://${domain}/admin/api/${version}/graphql.json`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Shopify-Access-Token': token },
        body: JSON.stringify({ query, variables })
    });
    const body = await response.json();
    if (!response.ok || body.errors) throw new Error(JSON.stringify(body.errors || body));
    return body.data;
}

function anonymise(value) {
    const seen = new Map();
    const text = JSON.stringify(value).replace(/gid:\/\/shopify\/(\w+)\/(\d+)/g, (match, type) => {
        if (!seen.has(match)) seen.set(match, seen.size + 1);
        return `gid://shopify/${type}/${seen.get(match)}`;
    });
    return JSON.parse(text);
}

async function main() {
    const args = process.argv.slice(2);
    const valueOf = (flag) => (args.includes(flag) ? args[args.indexOf(flag) + 1] : null);
    const orderId = valueOf('--order');
    const pages = Number(valueOf('--pages') || 4);
    const findText = valueOf('--find');
    const found = [];
    const info = (await gql(SCOPES_QUERY)).currentAppInstallation;
    const scopes = info.accessScopes.map((scope) => scope.handle);
    console.log(`Store: ${domain}`);
    console.log(`App: ${info.app.title}`);
    console.log(`Scopes: ${scopes.join(', ')}`);

    if (!scopes.includes('read_orders')) {
        console.error('\nThis token does not have read_orders, so orders cannot be queried.');
        process.exit(1);
    }

    if (orderId) {
        const data = await gql(ORDER_QUERY, { id: orderId });
        console.log(JSON.stringify(anonymise(data), null, 2));
        return;
    }

    const counts = new Map();
    let after = null;
    for (let page = 0; page < pages; page += 1) {
        const data = await gql(SHIPPING_QUERY, { first: 50, after });
        for (const order of data.orders.nodes) {
            if (findText && found.length < 3 && order.shippingLines.nodes.some((l) => (l.title || '').includes(findText))) {
                found.push(order.id);
            }
            const lines = order.shippingLines.nodes;
            const key = JSON.stringify(lines.length ? lines : [{ none: true }]);
            counts.set(key, (counts.get(key) || 0) + 1);
        }
        if (findText && found.length >= 3) break;
        if (!data.orders.pageInfo.hasNextPage) break;
        after = data.orders.pageInfo.endCursor;
    }

    if (findText) {
        console.log(found.length ? found.join('\n') : 'No match in the scanned orders');
        return;
    }

    const rows = [...counts.entries()]
        .map(([key, orders]) => ({ orders, shippingLines: JSON.parse(key) }))
        .sort((a, b) => b.orders - a.orders);
    console.log(JSON.stringify(rows, null, 2));
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});