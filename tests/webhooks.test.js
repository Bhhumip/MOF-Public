const test = require('node:test');
const assert = require('node:assert/strict');
const { createHmac } = require('node:crypto');
const { isValidSignature } = require('../src/webhooks');

test('validates Shopify webhook HMAC signatures', () => {
  const body = Buffer.from('{"id":"return-1"}');
  const secret = 'webhook-secret';
  const signature = createHmac('sha256', secret).update(body).digest('base64');

  assert.equal(isValidSignature(body, signature, secret), true);
  assert.equal(isValidSignature(body, 'invalid', secret), false);
});