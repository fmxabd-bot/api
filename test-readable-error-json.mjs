import test from 'node:test';
import assert from 'node:assert/strict';
import { json } from './src/router.js';

test('all error responses are indented, consistently shaped, and exclude private key records', async () => {
    const response = json({
        valid: true,
        code: 'API_KEY_DAILY_LIMIT_EXCEEDED',
        message: 'daily request limit reached',
        error: 'daily request limit reached',
        contact: '/request-key',
        contactAction: 'request_key',
        contactLabel: 'Request your own key',
        period: 'daily',
        retryAfter: 120,
        key: {
            key: 'must-not-appear',
            owner: 'Test key',
            email: 'private@example.invalid',
            dailyLimit: 50,
        },
    }, 429);

    assert.equal(response.status, 429);
    assert.match(response.headers.get('content-type'), /application\/json/);
    assert.equal(response.headers.get('retry-after'), '120');

    const text = await response.text();
    assert.match(text, /^\{\n  "status": 429/m);
    assert.doesNotMatch(text, /must-not-appear|private@example\.invalid/);
    assert.deepEqual(JSON.parse(text), {
        status: 429,
        success: false,
        creator: 'DaraTech',
        code: 'API_KEY_DAILY_LIMIT_EXCEEDED',
        error: 'daily request limit reached',
        message: 'daily request limit reached',
        contact: '/request-key',
        contactAction: 'request_key',
        contactLabel: 'Request your own key',
        period: 'daily',
        retryAfter: 120,
    });
});

test('all common HTTP failures get stable error codes and readable JSON', async () => {
    for (const [status, code] of [
        [400, 'VALIDATION_ERROR'],
        [401, 'UNAUTHORIZED'],
        [403, 'FORBIDDEN'],
        [404, 'NOT_FOUND'],
        [405, 'METHOD_NOT_ALLOWED'],
        [409, 'CONFLICT'],
        [410, 'ENDPOINT_REMOVED'],
        [413, 'REQUEST_TOO_LARGE'],
        [429, 'RATE_LIMITED'],
        [502, 'UPSTREAM_ERROR'],
        [503, 'SERVICE_UNAVAILABLE'],
    ]) {
        const response = json({ message: `problem ${status}` }, status);
        const text = await response.text();
        assert.match(text, /^\{\n  "status":/m);
        assert.equal(JSON.parse(text).code, code);
        assert.equal(JSON.parse(text).status, status);
    }
});
