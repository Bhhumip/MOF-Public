const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCarrier, resolveCarrierFromTags, DEFAULT_TAG_MAP } = require('../src/carriers/resolver');

test('resolves RedBox from a shipping line title', () => {
  assert.equal(resolveCarrier([{ title: 'RedBox Returns' }]), 'redbox');
});

test('resolves Aramex from a shipping line code', () => {
  assert.equal(resolveCarrier([{ code: 'ARAMEX' }]), 'aramex');
});

test('sends conflicting carriers to manual review', () => {
  assert.equal(
    resolveCarrier([{ title: 'RedBox Locker' }, { title: 'Aramex Standard' }]),
    'manual_review'
  );
});

test('falls back to manual review for an unknown carrier', () => {
  assert.equal(resolveCarrier([{ title: 'Some Other Courier' }]), 'manual_review');
});

const redboxOrder = require('./fixtures/order-redbox.json');
const aramexOrder = require('./fixtures/order-aramex.json');
const noTagOrder = require('./fixtures/order-no-carrier-tag.json');
const bothOrder = require('./fixtures/order-both-tags.json');
const branchOrder = require('./fixtures/order-branch-pickup.json');

test('tags: fixtures resolve as designed', () => {
  assert.equal(resolveCarrierFromTags(redboxOrder.tags).carrier, 'redbox');
  assert.equal(resolveCarrierFromTags(aramexOrder.tags).carrier, 'aramex');
  assert.equal(resolveCarrierFromTags(noTagOrder.tags).reason, 'no_carrier_tag');
  assert.equal(resolveCarrierFromTags(bothOrder.tags).reason, 'conflicting_carrier_tags');
  assert.equal(resolveCarrierFromTags(branchOrder.tags).reason, 'no_carrier_tag');
});

test('tags: matching ignores case and surrounding spaces', () => {
  assert.equal(resolveCarrierFromTags([' ARAMEX ']).carrier, 'aramex');
  assert.equal(resolveCarrierFromTags(['REDBOX']).carrier, 'redbox');
});

test('tags: the same carrier twice is not a conflict', () => {
  const match = resolveCarrierFromTags(['RedBox', 'redbox']);
  assert.equal(match.carrier, 'redbox');
  assert.equal(match.reason, 'matched');
});

test('tags: conflicting carrier tags go to manual review', () => {
  const match = resolveCarrierFromTags(['RedBox', 'aramex']);
  assert.equal(match.carrier, 'manual_review');
  assert.equal(match.reason, 'conflicting_carrier_tags');
  assert.equal(match.matchedOn.length, 2);
});

test('tags: missing or empty input goes to manual review', () => {
  assert.equal(resolveCarrierFromTags(undefined).reason, 'no_carrier_tag');
  assert.equal(resolveCarrierFromTags(null).reason, 'no_carrier_tag');
  assert.equal(resolveCarrierFromTags([]).reason, 'no_carrier_tag');
});

test('tags: a comma-separated string works like a list', () => {
  assert.equal(resolveCarrierFromTags('Paytabs, RedBox, printed').carrier, 'redbox');
});

test('tags: inherited property names do not match', () => {
  assert.equal(resolveCarrierFromTags(['constructor', 'toString']).reason, 'no_carrier_tag');
});

test('tags: the tag map is data, so a new tag needs no code change', () => {
  const tagMap = { ...DEFAULT_TAG_MAP, 'aramex-cod': 'aramex' };
  assert.equal(resolveCarrierFromTags(['Aramex-COD'], { tagMap }).carrier, 'aramex');
});