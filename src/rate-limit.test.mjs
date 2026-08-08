import assert from 'node:assert/strict';
import { hitCount, limited, RateLimiter, _test } from './rate-limit.js';

_test.fallback.clear();
assert.equal(await hitCount({}, 'local', 60000), 1);
assert.equal(await hitCount({}, 'local', 60000), 2);
assert.equal(await limited({}, 'local', 2, 60000), true);

const records = new Map();
const alarms = [];
const storage = {
  get: async (key) => records.get(key),
  put: async (key, value) => records.set(key, value),
  setAlarm: async (time) => alarms.push(time),
  deleteAll: async () => records.clear()
};
const object = new RateLimiter({ storage });
assert.equal((await object.fetch(new Request('https://internal/hit', {
  method: 'POST', body: JSON.stringify({ windowMs: 60000 })
}))).status, 200);
const second = await object.fetch(new Request('https://internal/hit', {
  method: 'POST', body: JSON.stringify({ windowMs: 60000 })
}));
assert.equal((await second.json()).count, 2, 'durable counter persists across calls');
assert.ok(alarms.length > 0, 'expired counters are scheduled for cleanup');
await object.alarm();
assert.equal(records.size, 0);
assert.equal((await object.fetch(new Request('https://internal/hit'))).status, 405);

let remoteCount = 0;
const binding = {
  idFromName: (name) => name,
  get: () => ({ fetch: async () => Response.json({ count: ++remoteCount }) })
};
assert.equal(await hitCount({ RATE_LIMITER: binding }, 'shared', 60000), 1);
assert.equal(await hitCount({ RATE_LIMITER: binding }, 'shared', 60000), 2);

const realError = console.error;
console.error = () => {};
assert.equal(await limited({ RATE_LIMITER: {
  idFromName: () => 'id',
  get: () => ({ fetch: async () => { throw new Error('down'); } })
} }, 'fail-closed', 10, 60000), true, 'configured limiter failures fail closed');
console.error = realError;

console.log('ok — durable, local, cleanup, and fail-closed rate limiting');
