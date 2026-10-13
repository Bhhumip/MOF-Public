const { createHmac } = require('node:crypto');

const secret = process.env.SHOPIFY_WEBHOOK_SECRET;
const returnId = process.argv[2];
const url = process.argv[3] || 'http://localhost:3000/webhooks/shopify';

if (!secret || !returnId) {
    console.error('Usage: node --env-file=.env scripts/send-test-webhook.js <return GID> [url]');
    process.exit(1);
}

const body = JSON.stringify({ admin_graphql_api_id: returnId, status: 'open' });
const signature = createHmac('sha256', secret).update(body).digest('base64');

fetch(url, {
    method: 'POST',
    headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Topic': 'returns/approve',
        'X-Shopify-Hmac-Sha256': signature
    },
    body
})
    .then((response) => console.log('Response:', response.status))
    .catch((error) => console.error('Failed:', error.message));