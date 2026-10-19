'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const { parseXml, child, children, descendant, childText, decodeEntities } = require('../src/carriers/aramex-xml');

test('namespace prefixes are ignored: a:Tag, b:Tag and Tag are the same element', () => {
    const root = parseXml('<s:Envelope xmlns:s="x"><s:Body><a:Result xmlns:a="y"><b:ID>42</b:ID></a:Result></s:Body></s:Envelope>');
    const result = descendant(root, 'Result');
    assert.equal(childText(result, 'ID'), '42');
});

test('a nil element reads as null, not as an empty string or false', () => {
    const root = parseXml('<R xmlns:i="http://www.w3.org/2001/XMLSchema-instance"><LabelURL i:nil="true"/><Other/></R>');
    const r = descendant(root, 'R');
    assert.equal(childText(r, 'LabelURL'), null);
    assert.equal(childText(r, 'Other'), '');
    assert.equal(childText(r, 'Missing'), null);
});

test('a nil element with a closing tag is also null', () => {
    const r = descendant(parseXml('<R><V xsi:nil="true"></V></R>'), 'R');
    assert.equal(childText(r, 'V'), null);
});

test('children() always returns an array: none, one or many', () => {
    const r = descendant(parseXml('<R><Item>1</Item></R>'), 'R');
    assert.equal(children(r, 'Item').length, 1);
    assert.equal(children(r, 'Nothing').length, 0);
    const many = descendant(parseXml('<R><Item>1</Item><Item>2</Item></R>'), 'R');
    assert.deepEqual(children(many, 'Item').map((n) => n.text), ['1', '2']);
});

test('child() reads direct children only, so same-named elements at other levels are not confused', () => {
    const r = descendant(parseXml('<R><HasErrors>false</HasErrors><Shipments><P><HasErrors>true</HasErrors></P></Shipments></R>'), 'R');
    assert.equal(childText(r, 'HasErrors'), 'false');
    assert.equal(childText(child(child(r, 'Shipments'), 'P'), 'HasErrors'), 'true');
});

test('entities and CDATA are decoded', () => {
    const r = descendant(parseXml('<R><M>Tom &amp; Jerry &lt;3 &#65;&#x42;</M><C><![CDATA[a < b & c]]></C></R>'), 'R');
    assert.equal(childText(r, 'M'), 'Tom & Jerry <3 AB');
    assert.equal(childText(r, 'C'), 'a < b & c');
    assert.equal(decodeEntities('&#99999999;'), '&#99999999;');
});

test('declarations, comments and stray closing tags do not break parsing', () => {
    const r = descendant(parseXml('<?xml version="1.0"?><!-- c --><R></Stray><C>2</C></R>'), 'R');
    assert.equal(childText(r, 'C'), '2');
});

test('empty or non-string input gives an empty tree', () => {
    assert.equal(descendant(parseXml(''), 'R'), null);
    assert.equal(descendant(parseXml(undefined), 'R'), null);
});