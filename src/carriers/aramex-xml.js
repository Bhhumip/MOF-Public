'use strict';

/**
 * A small, dependency-free XML reader for Aramex SOAP responses.
 *
 * Why not regular expressions: Aramex is a .NET (WCF) service. Its responses
 * use namespace prefixes that can change (a:, b:, none), mark empty values as
 * <Tag i:nil="true"/>, and nest the same element names at several levels
 * (HasErrors and Notifications exist on the response AND on each shipment).
 * Reading a real tree and asking for DIRECT children avoids mixing those
 * levels up.
 *
 * Every element is reduced to its local name (the part after the colon).
 */

const NAMED_ENTITIES = { lt: '<', gt: '>', quot: '"', apos: "'", amp: '&' };

function decodeEntities(text) {
    return text.replace(/&(#x[0-9a-f]+|#\d+|lt|gt|quot|apos|amp);/gi, (match, entity) => {
        const lower = entity.toLowerCase();
        if (lower[0] !== '#') return NAMED_ENTITIES[lower];
        const code = lower[1] === 'x' ? parseInt(lower.slice(2), 16) : parseInt(lower.slice(1), 10);
        return Number.isInteger(code) && code >= 0 && code <= 0x10ffff ? String.fromCodePoint(code) : match;
    });
}

function localName(qualifiedName) {
    const index = qualifiedName.lastIndexOf(':');
    return index === -1 ? qualifiedName : qualifiedName.slice(index + 1);
}

// xsi:nil="true" (any prefix) means "this value is empty".
function isNil(attributeText) {
    return /\b(?:[\w.-]+:)?nil\s*=\s*["'](?:true|1)["']/i.test(attributeText);
}

// Tokens: CDATA | comment | processing instruction | tag | text.
const TOKEN = /<!\[CDATA\[([\s\S]*?)\]\]>|<!--[\s\S]*?-->|<\?[\s\S]*?\?>|<(\/)?([A-Za-z_][\w.:-]*)([^>]*?)(\/)?>|([^<]+)/g;

function createNode(name, nil = false) {
    return { name, nil, text: '', children: [] };
}

/** Parse an XML string into a tree. Returns a synthetic root whose children are the top elements. */
function parseXml(xml) {
    const root = createNode('#root');
    const stack = [root];

    for (const match of String(xml ?? '').matchAll(TOKEN)) {
        const [, cdata, closing, tagName, attributes = '', selfClosing, text] = match;
        const current = stack[stack.length - 1];

        if (cdata !== undefined) {
            current.text += cdata;
        } else if (text !== undefined) {
            current.text += decodeEntities(text);
        } else if (tagName) {
            const name = localName(tagName);
            if (closing) {
                // Tolerate sloppy input: close up to the matching open tag, ignore stray closers.
                const openIndex = stack.map((node) => node.name).lastIndexOf(name);
                if (openIndex > 0) stack.length = openIndex;
            } else {
                const node = createNode(name, isNil(attributes));
                current.children.push(node);
                if (!selfClosing) stack.push(node);
            }
        }
    }
    return root;
}

/** First DIRECT child with this local name, or null. */
function child(node, name) {
    return node?.children.find((entry) => entry.name === name) ?? null;
}

/** All DIRECT children with this local name (always an array, even for one or none). */
function children(node, name) {
    return node ? node.children.filter((entry) => entry.name === name) : [];
}

/** First descendant (depth-first) with this local name, or null. */
function descendant(node, name) {
    if (!node) return null;
    for (const entry of node.children) {
        if (entry.name === name) return entry;
        const found = descendant(entry, name);
        if (found) return found;
    }
    return null;
}

/** Trimmed text of a node. null when the node is missing or marked nil. */
function valueOf(node) {
    if (!node || node.nil) return null;
    return node.text.trim();
}

/** Trimmed text of a direct child. null when the child is missing or nil. */
function childText(node, name) {
    return valueOf(child(node, name));
}

module.exports = { parseXml, child, children, descendant, valueOf, childText, decodeEntities };