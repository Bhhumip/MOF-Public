'use strict';

const CARRIER_NAMES = Object.freeze({
  REDBOX: 'redbox',
  ARAMEX: 'aramex'
});

/**
 * Returned whenever carrier resolution cannot make a confident, unambiguous
 * match. The middleware should route these to the operations-owned manual
 * review / default-carrier process rather than guessing.
 */
const FALLBACK_CARRIER = 'manual_review';

/**
 * shippingLines -> carrier adapter mapping table.
 *
 * This is deliberately data, not code: a new checkout shipping method only
 * requires a new entry here, not a redeploy of the matching logic.
 *
 * Fields are read from the order's `shippingLines.nodes[]` shape returned by
 * the GetOrderShipping query. Strongest signals first.
 *
 * NOTE: the exact string/code values below must be confirmed against the
 * client's live checkout configuration during implementation. The regexes are
 * placeholders that keep the resolver usable until those values are known.
 */
const DEFAULT_MAPPING = Object.freeze([
  { carrier: CARRIER_NAMES.REDBOX, field: 'carrierIdentifier', match: [/redbox/i] },
  { carrier: CARRIER_NAMES.ARAMEX, field: 'carrierIdentifier', match: [/aramex/i] },
  { carrier: CARRIER_NAMES.REDBOX, field: 'requestedFulfillmentService.serviceName', match: [/redbox/i] },
  { carrier: CARRIER_NAMES.ARAMEX, field: 'requestedFulfillmentService.serviceName', match: [/aramex/i] },
  { carrier: CARRIER_NAMES.REDBOX, field: 'source', match: [/redbox/i] },
  { carrier: CARRIER_NAMES.ARAMEX, field: 'source', match: [/aramex/i] },
  { carrier: CARRIER_NAMES.REDBOX, field: 'title', match: [/redbox/i, /locker/i] },
  { carrier: CARRIER_NAMES.ARAMEX, field: 'title', match: [/aramex/i] },
  { carrier: CARRIER_NAMES.REDBOX, field: 'code', match: [/redbox/i] },
  { carrier: CARRIER_NAMES.ARAMEX, field: 'code', match: [/aramex/i] }
]);

function getFieldValue(line, field) {
  if (!line || !field) return undefined;
  return String(field)
    .split('.')
    .reduce((value, key) => (value == null ? undefined : value[key]), line);
}

function matchShippingLine(line, mapping) {
  for (const rule of mapping) {
    const raw = getFieldValue(line, rule.field);
    if (raw == null || raw === '') continue;

    const value = String(raw).trim();
    for (const pattern of rule.match) {
      const hit = pattern instanceof RegExp
        ? pattern.test(value)
        : value.toLowerCase() === String(pattern).toLowerCase();

      if (hit) {
        return { carrier: rule.carrier, field: rule.field, value, pattern: String(pattern) };
      }
    }
  }
  return null;
}

/**
 * Detailed resolution — use this when the middleware needs to log or persist
 * *why* a carrier was chosen (auditability requirement).
 *
 * @param {Array} shippingLines  nodes from order.shippingLines
 * @param {Object} [options]
 * @param {Array}  [options.mapping]  override mapping table
 * @param {Set}    [options.lineIds]  restrict to the lines tied to the RFO's items
 */
function resolveCarrierMatch(shippingLines = [], { mapping = DEFAULT_MAPPING, lineIds = null } = {}) {
  const lines = Array.isArray(shippingLines) ? shippingLines.filter(Boolean) : [];
  const relevant = lineIds
    ? lines.filter((line) => lineIds.has(line.id))
    : lines;

  if (relevant.length === 0) {
    return { carrier: FALLBACK_CARRIER, reason: 'no_shipping_lines', matchedOn: [] };
  }

  const matches = relevant
    .map((line) => matchShippingLine(line, mapping))
    .filter(Boolean);

  if (matches.length === 0) {
    return { carrier: FALLBACK_CARRIER, reason: 'no_confident_match', matchedOn: [] };
  }

  // A Reverse Fulfillment Order spanning items from shipping lines with
  // different carriers is an explicit fallback case — do not guess.
  const distinct = new Set(matches.map((match) => match.carrier));
  if (distinct.size > 1) {
    return { carrier: FALLBACK_CARRIER, reason: 'conflicting_carriers', matchedOn: matches };
  }

  return { carrier: matches[0].carrier, reason: 'matched', matchedOn: matches };
}

/**
 * Backwards-compatible string resolver used by returns.js.
 * Returns a carrier name, or FALLBACK_CARRIER when no confident match exists.
 */
function resolveCarrier(shippingLines = [], options = {}) {
  return resolveCarrierMatch(shippingLines, options).carrier;
}

function createCarrierResolver({ mapping = DEFAULT_MAPPING } = {}) {
  return {
    mapping,
    resolve: (shippingLines, options = {}) =>
      resolveCarrier(shippingLines, { ...options, mapping }),
    resolveMatch: (shippingLines, options = {}) =>
      resolveCarrierMatch(shippingLines, { ...options, mapping })
  };
}

module.exports = {
  CARRIER_NAMES,
  FALLBACK_CARRIER,
  DEFAULT_MAPPING,
  getFieldValue,
  matchShippingLine,
  resolveCarrier,
  resolveCarrierMatch,
  createCarrierResolver
};