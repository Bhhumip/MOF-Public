'use strict';

/**
 * Lists the Shopify webhooks registered by this app, or points them at a new public URL.
 *
 *   node --env-file=.env scripts/shopify-webhooks.js                          list them
 *   node --env-file=.env scripts/shopify-webhooks.js --set https://<host>     create/update ours
 *
 * --set uses <host>/webhooks/shopify for every topic in SHOPIFY webhookTopics (returns/approve,
 * returns/cancel, reverse_fulfillment_orders/dispose, ...). Run it again whenever the ngrok
 * address changes. Only the dev store named in ALLOWED_SHOPIFY_STORE is touched.
 *
 * Note: webhooks declared in the app's own configuration file (shopify.app.toml) are managed
 * there, not here. If the list is empty but webhooks do arrive, change the URL in that file instead.
 */
const { getConfig } = require('../src/config');
const { createShopifyClient } = require('../src/shopify');

const LIST = `
  query { webhookSubscriptions(first: 50) {
    nodes { id topic endpoint { __typename ... on WebhookHttpEndpoint { callbackUrl } } }
  } }`;

const CREATE = `
  mutation ($topic: WebhookSubscriptionTopic!, $url: URL!) {
    webhookSubscriptionCreate(topic: $topic, webhookSubscription: { callbackUrl: $url, format: JSON }) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }`;

const UPDATE = `
  mutation ($id: ID!, $url: URL!) {
    webhookSubscriptionUpdate(id: $id, webhookSubscription: { callbackUrl: $url }) {
      webhookSubscription { id topic }
      userErrors { field message }
    }
  }`;

const toEnum = (topic) => topic.replace('/', '_').toUpperCase(); // returns/approve -> RETURNS_APPROVE

async function main() {
    const flags = process.argv.slice(2);
    const at = flags.indexOf('--set');
    const baseUrl = at >= 0 ? flags[at + 1] : null;
    if (at >= 0 && !/^https:\/\/[^/\s]+$/.test(baseUrl || '')) {
        console.error('--set needs a public https address without a path, e.g. https://abcd-1234.ngrok-free.app');
        process.exit(1);
    }

    const { shopify: settings } = getConfig();
    console.error(`Store: ${settings.storeDomain}`);
    const shopify = createShopifyClient(settings);

    const list = async () => (await shopify.query(LIST)).webhookSubscriptions.nodes;
    const show = (nodes) => nodes.forEach((n) => console.log(n.topic.padEnd(40), n.endpoint.callbackUrl || n.endpoint.__typename));

    let nodes = await list();
    console.log(nodes.length ? 'Registered webhooks:' : 'No webhooks registered by this app.');
    show(nodes);
    if (!baseUrl) return;

    const url = `${baseUrl}/webhooks/shopify`;
    for (const topic of settings.webhookTopics) {
        const existing = nodes.find((n) => n.topic === toEnum(topic));
        const result = existing
            ? (existing.endpoint.callbackUrl === url ? null : (await shopify.query(UPDATE, { id: existing.id, url })).webhookSubscriptionUpdate)
            : (await shopify.query(CREATE, { topic: toEnum(topic), url })).webhookSubscriptionCreate;
        if (!result) { console.log(`unchanged  ${topic}`); continue; }
        if (result.userErrors.length) console.log(`FAILED     ${topic}: ${result.userErrors.map((e) => e.message).join('; ')}`);
        else console.log(`${existing ? 'updated  ' : 'created  '}  ${topic}`);
    }
    console.log('\nAfter the change:');
    show(await list());
}

main().catch((error) => {
    console.error('Failed:', error.message);
    process.exit(1);
});