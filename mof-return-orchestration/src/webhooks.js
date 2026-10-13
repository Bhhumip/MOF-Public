const { createHmac, timingSafeEqual } = require('node:crypto');

function readBody(request) {
  return new Promise((resolve, reject) => {
    const chunks = [];
    request.on('data', (chunk) => chunks.push(chunk));
    request.on('end', () => resolve(Buffer.concat(chunks)));
    request.on('error', reject);
  });
}

function isValidSignature(body, signature, secret) {
  if (!signature || !secret) return false;

  const expected = createHmac('sha256', secret).update(body).digest('base64');
  const expectedBuffer = Buffer.from(expected);
  const receivedBuffer = Buffer.from(signature);

  return expectedBuffer.length === receivedBuffer.length
    && timingSafeEqual(expectedBuffer, receivedBuffer);
}

/**
 * Shopify sends the topic in the X-Shopify-Topic header, e.g.
 * "returns/approve", "reverse_fulfillment_orders/dispose".
 * We normalize to a handler key.
 */
function topicToHandler(topic) {
  const map = {
    'returns/request': 'onReturnRequested',
    'returns/approve': 'onReturnApproved',
    'returns/process': 'onReturnProcessed',
    'reverse_fulfillment_orders/dispose': 'onReverseFulfillmentOrderDisposed'
  };
  return map[topic] || null;
}

function createWebhookHandler({ webhookSecret, orchestrator }) {
  return async function handleWebhook(request, response) {
    if (request.method !== 'POST') {
      response.writeHead(405, { Allow: 'POST' });
      response.end();
      return;
    }

    const body = await readBody(request);
    const signature = request.headers['x-shopify-hmac-sha256'];

    if (!isValidSignature(body, signature, webhookSecret)) {
      response.writeHead(401);
      response.end();
      return;
    }

    let payload;
    try {
      payload = JSON.parse(body.toString('utf8'));
    } catch {
      response.writeHead(400);
      response.end();
      return;
    }

    const topic = request.headers['x-shopify-topic'];
    const handlerName = topicToHandler(topic);

    // Respond 200 immediately — Shopify retries if you don't.
    response.writeHead(200, { 'Content-Type': 'application/json' });
    response.end(JSON.stringify({ received: true }));

    if (!handlerName) {
      console.warn(`Unhandled Shopify webhook topic: ${topic}`);
      return;
    }

    // Fire-and-forget: the orchestrator owns retry/backoff internally.
    try {
      await orchestrator[handlerName](payload, topic);
    } catch (error) {
      console.error(`Webhook handler ${handlerName} failed for topic ${topic}`, error);
    }
  };
}

module.exports = {
  createWebhookHandler,
  isValidSignature,
  readBody,
  topicToHandler
};