const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { isValidSignature } = require('../src/webhooks');
const { createWebhookHandler } = require('../src/webhooks');

function fakeResponse() {
  return { status: null, writeHead(code) { this.status = code; }, end() { } };
}

function fakeRequest(body, headers) {
  const { Readable } = require('node:stream');
  const request = Readable.from([Buffer.from(body)]);
  request.method = 'POST';
  request.headers = headers;
  return request;
}

test('validates Shopify webhook HMAC signatures', () => {
  const body = Buffer.from('{"id":"return-1"}');
  const secret = 'webhook-secret';
  const signature = createHmac('sha256', secret).update(body).digest('base64');

  assert.equal(isValidSignature(body, signature, secret), true);
  assert.equal(isValidSignature(body, 'invalid', secret), false);
});


test('the handler rejects a bad signature and never calls the orchestrator', async () => {
  let called = false;
  const handler = createWebhookHandler({
    webhookSecret: 'secret',
    orchestrator: { onReturnApproved: async () => { called = true; } }
  });
  const response = fakeResponse();
  await handler(
    fakeRequest('{"id":"1"}', { 'x-shopify-hmac-sha256': 'bad', 'x-shopify-topic': 'returns/approve' }),
    response
  );
  assert.equal(response.status, 401);
  assert.equal(called, false);
});

test('the handler accepts a valid signature and calls the orchestrator', async () => {
  const body = '{"admin_graphql_api_id":"gid://shopify/Return/1"}';
  const signature = createHmac('sha256', 'secret').update(body).digest('base64');
  let received = null;
  const handler = createWebhookHandler({
    webhookSecret: 'secret',
    orchestrator: { onReturnApproved: async (payload) => { received = payload; } }
  });
  const response = fakeResponse();
  await handler(
    fakeRequest(body, { 'x-shopify-hmac-sha256': signature, 'x-shopify-topic': 'returns/approve' }),
    response
  );
  assert.equal(response.status, 200);
  assert.equal(received.admin_graphql_api_id, 'gid://shopify/Return/1');
});