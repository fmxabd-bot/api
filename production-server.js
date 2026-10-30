// Production must never fall back to ephemeral filesystem quota storage.
for (const name of ['ADMIN_SECRET','KEY_LEDGER_URL']) {
    if (!process.env[name]) throw new Error(`${name} is required for the published MovieAPI service`);
}
const ledger=new URL(process.env.KEY_LEDGER_URL);
if(ledger.protocol!=='https:') throw new Error('KEY_LEDGER_URL must use HTTPS');
process.env.NODE_ENV='production';
await import('./local-server.js');
