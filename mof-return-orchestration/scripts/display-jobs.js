const { DatabaseSync } = require('node:sqlite');

const dbPath = process.env.JOB_DB_PATH || './data/jobs.sqlite';
const [command, needle] = process.argv.slice(2);
const db = new DatabaseSync(dbPath);

if (command === 'list') {
    const rows = db
        .prepare('SELECT key, status, data, created_at, updated_at FROM return_jobs WHERE key LIKE ? ORDER BY created_at')
        .all(`%${needle || ''}%`);
    for (const row of rows) {
        const data = JSON.parse(row.data);
        console.log({
            key: row.key,
            status: row.status,
            carrier: data.carrier,
            reason: data.reason,
            error: data.error,
            trackingNumber: data.trackingNumber,
            createdAt: row.created_at,
            updatedAt: row.updated_at,
            carrierStatus: data.carrierStatus,
        });
    }
} else if (command === 'delete' && needle) {
    // Development only: removing a job lets the same RFO be processed again.
    if ((process.env.CARRIER_MODE || 'dry-run') !== 'dry-run') {
        console.error('Refusing to delete jobs outside dry-run mode.');
        process.exit(1);
    }
    const result = db.prepare('DELETE FROM return_jobs WHERE key LIKE ?').run(`%${needle}%`);
    console.log(`Deleted ${result.changes} job(s)`);
} else {
    console.error('Usage: node --env-file=.env scripts/jobs.js list [text]\n       node --env-file=.env scripts/jobs.js delete <text>');
    process.exit(1);
}