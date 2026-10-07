const fs = require('node:fs');
const { DatabaseSync } = require('node:sqlite');

const dbPath = process.argv[2];
const shop = process.env.SHOPIFY_STORE_DOMAIN;
if (!dbPath || !shop) {
    console.error('Usage: node --env-file=.env scripts/save-dev-token.js <path to prisma/dev.sqlite>');
    process.exit(1);
}

const db = new DatabaseSync(dbPath);
let row;
try {
    row = db
        .prepare('SELECT accessToken FROM Session WHERE shop = ? AND isOnline = 0 AND accessToken IS NOT NULL')
        .get(shop);
} catch (error) {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all().map((t) => t.name);
    console.error(`Query failed (${error.message}). Tables found: ${tables.join(', ')}`);
    process.exit(1);
}
if (!row) {
    console.error(`No offline session for ${shop}. Open the app on that store first.`);
    process.exit(1);
}

let env = fs.readFileSync('.env', 'utf8');
const line = `SHOPIFY_ADMIN_ACCESS_TOKEN=${row.accessToken}`;
env = /^SHOPIFY_ADMIN_ACCESS_TOKEN=.*$/m.test(env)
    ? env.replace(/^SHOPIFY_ADMIN_ACCESS_TOKEN=.*$/m, () => line)
    : `${env.trimEnd()}\n${line}\n`;
fs.writeFileSync('.env', env);
console.log(`Token saved for ${shop} (ends with ...${row.accessToken.slice(-4)})`);