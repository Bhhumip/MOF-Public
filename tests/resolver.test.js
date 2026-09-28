const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCarrier } = require('../src/carriers/resolver');

test('resolves RedBox from a shipping line title', () => {
  assert.equal(resolveCarrier([{ title: 'RedBox Returns' }]), 'redbox');
});

test('resolves Aramex from a shipping line code', () => {
  assert.equal(resolveCarrier([{ code: 'ARAMEX' }]), 'aramex');
});

test('uses deterministic RedBox precedence when both carriers appear', () => {
  assert.equal(
    resolveCarrier([{ title: 'Aramex' }, { title: 'RedBox' }]),
    'redbox'
  );
});

test('returns null for an unknown carrier', () => {
  assert.equal(resolveCarrier([{ title: 'Local delivery' }]), null);
});