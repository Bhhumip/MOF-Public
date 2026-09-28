# MOF Middleware Orchestration

Minimal Node.js structure for Shopify Plus returns middleware integrations.

## Setup

Requires Node.js 20 or newer.

```sh
npm install
copy .env.example .env
```

The initial server does not call Shopify or carrier APIs. Configure environment
variables now so integrations can be added without putting credentials in code.

## Run

```sh
npm start
```

The health endpoint is available at `http://localhost:3000/health`.

## Verify

```sh
npm test
npm run lint
```