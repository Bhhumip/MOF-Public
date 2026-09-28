function createShopifyClient({ storeDomain, adminAccessToken, apiVersion }) {
  const endpoint = `https://${storeDomain}/admin/api/${apiVersion}/graphql.json`;

  return {
    endpoint,
    async query(query, variables = {}) {
      const response = await fetch(endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Shopify-Access-Token': adminAccessToken
        },
        body: JSON.stringify({ query, variables })
      });

      const payload = await response.json();

      if (!response.ok || payload.errors) {
        const message = payload.errors?.map((error) => error.message).join('; ')
          || `Shopify Admin GraphQL request failed with status ${response.status}`;
        throw new Error(message);
      }

      return payload.data;
    }
  };
}

module.exports = { createShopifyClient };