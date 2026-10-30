import { DurableObject } from 'cloudflare:workers';
import { KeyStore } from './key-store.js';

export class ApiKeyLedger extends DurableObject {
    constructor(ctx, env) {
        super(ctx, env);
        this.storage=ctx.storage;
        this.store = new KeyStore(ctx.storage.sql);
    }
    async fetch(request) {
        try {
            const input=await request.json();
            const data = this.storage.transactionSync(()=>this.store.dispatch(input));
            return Response.json(data, {status:data.status});
        } catch (e) {
            const status=e.status||503;
            return Response.json({status,message:status<500?e.message:'Persistent key storage is temporarily unavailable',
                code:e.code||(status<500?'VALIDATION_ERROR':'KEY_STORE_UNAVAILABLE')},{status});
        }
    }
}
