const test = require('node:test');
const assert = require('node:assert/strict');
const { resolveCarrier } = require('../src/carriers/resolver');

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