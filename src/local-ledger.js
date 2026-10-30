import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { KeyStore } from './key-store.js';

const dir = fileURLToPath(new URL('../.data/', import.meta.url));
mkdirSync(dir, {recursive:true});
const db = new DatabaseSync(`${dir}/keys.sqlite`);
// Install the busy handler before changing journal mode: switching to WAL can
// itself need a lock while an older preview process is still shutting down.
db.exec('PRAGMA busy_timeout=5000;');
db.exec('PRAGMA journal_mode=WAL;');
const sql = { exec(query, ...args) {
    const statement = db.prepare(query);
    if (/^\s*(SELECT|PRAGMA)/i.test(query)) return statement.all(...args);
    statement.run(...args);
    return [];
} };
const store = new KeyStore(sql);
export const localLedger = { dispatch(data) {
    db.exec('BEGIN IMMEDIATE');
    try {
        const result=store.dispatch(data);
        db.exec('COMMIT');
        return result;
    } catch(e) {db.exec('ROLLBACK');throw e;}
} };
