'use strict';

const GET_ORDER_SHIPPING = `
  query GetOrderShipping($id: ID!) {
    order(id: $id) {
      id
      name
      tags
      shippingLines(first: 10) {
        nodes {
          id
          title
          code
          source
          carrierIdentifier
          custom
        }
      }
    }
  }
`;

function toOrderGid(orderId) {
  const value = String(orderId ?? '').trim();
  if (!value) throw new Error('An order ID is required');
  return value.startsWith('gid://') ? value : `gid://shopify/Order/${value}`;
}

function createShopifyClient({ storeDomain, adminAccessToken, apiVersion, fetchImpl = globalThis.fetch }) {
  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

  async function query(document, variables = {}) {
    const response = await fetchImpl(endpoint, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Shopify-Access-Token': adminAccessToken
      },
      body: JSON.stringify({ query: document, variables })
    });

    const payload = await response.json();

    if (!response.ok || payload.errors) {
      const message = Array.isArray(payload.errors)
        ? payload.errors.map((error) => error.message).join('; ')
        : `Shopify Admin GraphQL request failed with status ${response.status}`;
      throw new Error(message);
    }
    return payload.data;
  }

  async function getOrderShipping(orderId) {
    const data = await query(GET_ORDER_SHIPPING, { id: toOrderGid(orderId) });
    if (!data.order) throw new Error(`Order not found: ${orderId}`);
    return {
      id: data.order.id,
      name: data.order.name,
      tags: data.order.tags,
      shippingLines: data.order.shippingLines.nodes
    };
  }

  return { endpoint, query, getOrderShipping };
}

module.exports = { createShopifyClient, toOrderGid, GET_ORDER_SHIPPING };