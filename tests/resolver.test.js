const test = require('node:test');
const assert = require('node:assert/strict');
const {
  resolveCarrierFromTags,
  DEFAULT_TAG_MAP,
  FALLBACK_CARRIER
} = require('../src/carriers/resolver');

const redboxOrder = require('./fixtures/order-redbox.json');
const aramexOrder = require('./fixtures/order-aramex.json');
const noTagOrder = require('./fixtures/order-no-carrier-tag.json');
const bothOrder = require('./fixtures/order-both-tags.json');
const branchOrder = require('./fixtures/order-branch-pickup.json');

test('fixtures resolve as designed', () => {
  assert.equal(resolveCarrierFromTags(redboxOrder.tags).carrier, 'redbox');
  assert.equal(resolveCarrierFromTags(aramexOrder.tags).carrier, 'aramex');
  assert.equal(resolveCarrierFromTags(noTagOrder.tags).reason, 'no_carrier_tag');
  assert.equal(resolveCarrierFromTags(bothOrder.tags).reason, 'conflicting_carrier_tags');
  assert.equal(resolveCarrierFromTags(branchOrder.tags).reason, 'no_carrier_tag');
});

test('matching ignores case and surrounding spaces', () => {
  assert.equal(resolveCarrierFromTags([' ARAMEX ']).carrier, 'aramex');
  assert.equal(resolveCarrierFromTags(['REDBOX']).carrier, 'redbox');
});

test('one carrier tag among other tags resolves', () => {
  const match = resolveCarrierFromTags(['Paytabs', 'RedBox', 'printed', 'Refund']);
  assert.equal(match.carrier, 'redbox');
  assert.equal(match.reason, 'matched');
  assert.deepEqual(match.matchedOn, [{ tag: 'redbox', carrier: 'redbox' }]);
});

test('the same carrier twice is not a conflict', () => {
  assert.equal(resolveCarrierFromTags(['RedBox', 'redbox']).carrier, 'redbox');
});

test('conflicting carrier tags go to manual review', () => {
  const match = resolveCarrierFromTags(['RedBox', 'aramex']);
  assert.equal(match.carrier, FALLBACK_CARRIER);
  assert.equal(match.reason, 'conflicting_carrier_tags');
  assert.equal(match.matchedOn.length, 2);
});

test('no carrier tag goes to manual review', () => {
  const match = resolveCarrierFromTags(['Paytabs', 'printed']);
  assert.equal(match.carrier, FALLBACK_CARRIER);
  assert.equal(match.reason, 'no_carrier_tag');
});

test('missing or empty input goes to manual review', () => {
  assert.equal(resolveCarrierFromTags(undefined).reason, 'no_carrier_tag');
  assert.equal(resolveCarrierFromTags(null).reason, 'no_carrier_tag');
  assert.equal(resolveCarrierFromTags([]).reason, 'no_carrier_tag');
});

test('a comma-separated string works like a list', () => {
  assert.equal(resolveCarrierFromTags('Paytabs, RedBox, printed').carrier, 'redbox');
});

test('inherited property names do not match', () => {
  assert.equal(resolveCarrierFromTags(['constructor', 'toString']).reason, 'no_carrier_tag');
});

test('the tag map is data, so a new tag needs no code change', () => {
  const tagMap = { ...DEFAULT_TAG_MAP, 'aramex-cod': 'aramex' };
  assert.equal(resolveCarrierFromTags(['Aramex-COD'], { tagMap }).carrier, 'aramex');
});