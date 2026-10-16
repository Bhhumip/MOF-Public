'use strict';

// Usage: node scripts/fake-redbox-push.js <return tracking number> <status> [minutes ago] [--numeric]
const [tracking, status, minutes] = process.argv.slice(2);
if (!tracking || !status) {
    console.error('Usage: node scripts/fake-redbox-push.js <tracking number> <status> [minutes ago] [--numeric]');
    process.exit(1);
}

fetch(`http://127.0.0.1:${process.env.FAKE_REDBOX_PORT || 4000}/__push`, {
    method: 'POST',
    body: JSON.stringify({
        tracking_number: tracking,
        status,
        minutes_ago: Number.isFinite(Number(minutes)) ? Number(minutes) : 0,
        numeric: process.argv.includes('--numeric')
    })
}).then((response) => response.json()).then((result) => console.log(JSON.stringify(result)))
    .catch((error) => { console.error('Failed:', error.message); process.exit(1); });