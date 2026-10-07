'use strict';

const CARRIER_NAMES = Object.freeze({
  REDBOX: 'redbox',
  ARAMEX: 'aramex'
});

/**
 * Returned whenever the carrier cannot be decided with confidence.
 * The middleware sends these to the operations-owned manual review process
 * instead of guessing.
 */
const FALLBACK_CARRIER = 'manual_review';

/**
 * Tag -> carrier lookup. The carrier is decided ONLY by an order tag
 * (confirmed by the mentor and the client). Keys must be lowercase and
 * trimmed, because tags are normalised before lookup.
 * A new tag is a new row here, not a code change.
 */
const DEFAULT_TAG_MAP = Object.freeze({
  redbox: CARRIER_NAMES.REDBOX,
  aramex: CARRIER_NAMES.ARAMEX
});

function normalizeTag(tag) {
  return String(tag ?? '').normalize('NFKC').trim().toLowerCase();
}

// GraphQL returns tags as a list; order webhook payloads typically send a
// comma-separated string. Accept both.
function toTagList(tags) {
  if (Array.isArray(tags)) return tags;
  if (typeof tags === 'string') return tags.split(',');
  return [];
}

/**
 * Decide the carrier from an order's tags.
 *   exactly one carrier  -> that carrier,  reason "matched"
 *   no carrier tag       -> manual_review, reason "no_carrier_tag"
 *   tags for two carriers-> manual_review, reason "conflicting_carrier_tags"
 * Returns { carrier, reason, matchedOn } so the decision can be logged.
 */
function resolveCarrierFromTags(tags = [], { tagMap = DEFAULT_TAG_MAP } = {}) {
  const matchedOn = [];

  for (const raw of toTagList(tags)) {
    const tag = normalizeTag(raw);
    // hasOwn avoids matching inherited keys such as "constructor".
    if (Object.hasOwn(tagMap, tag)) {
      matchedOn.push({ tag, carrier: tagMap[tag] });
    }
  }

  const carriers = new Set(matchedOn.map((match) => match.carrier));

  if (carriers.size === 0) {
    return { carrier: FALLBACK_CARRIER, reason: 'no_carrier_tag', matchedOn: [] };
  }
  if (carriers.size > 1) {
    return { carrier: FALLBACK_CARRIER, reason: 'conflicting_carrier_tags', matchedOn };
  }
  return { carrier: [...carriers][0], reason: 'matched', matchedOn };
}

module.exports = {
  CARRIER_NAMES,
  FALLBACK_CARRIER,
  DEFAULT_TAG_MAP,
  normalizeTag,
  resolveCarrierFromTags
};