const test = require('node:test');
const assert = require('node:assert/strict');
const { crearPoliticaSolicitudes } = require('../utils/politicaSolicitudes');
test('acota concurrencia y cola, procesa en orden y libera tras fallos', async () => {
    const policy = crearPoliticaSolicitudes({ concurrent: 1, queued: 1 });
    let finish; const events = [];
    const first = policy.run('a', () => new Promise(resolve => { finish = resolve; }));
    const second = policy.run('b', async () => { events.push('second'); throw Error('provider'); });
    await assert.rejects(policy.run('c', async () => {}), /ocupado/);
    await new Promise(setImmediate); assert.deepEqual(policy.stats(), { active: 1, queued: 1, scopes: 2 });
    finish('done'); assert.equal(await first, 'done'); await assert.rejects(second, /provider/);
    assert.equal(policy.stats().active, 0); assert.deepEqual(events, ['second']);
});
test('caduca trabajo en espera sin ejecutarlo ni consumir un socket', async () => {
    const callbacks = [], policy = crearPoliticaSolicitudes({ concurrent: 1, queued: 1,
        schedule: callback => { callbacks.push(callback); return callback; }, cancel() {} });
    let finish, ran = false;
    const first = policy.run('a', () => new Promise(resolve => { finish = resolve; }));
    const pending = policy.run('b', () => { ran = true; });
    callbacks[0](); await assert.rejects(pending, /ocupado/); await new Promise(setImmediate);
    finish(); await first; assert.equal(ran, false);
});
test('limita por servidor, renueva ventanas y acota el mapa sin olvidar cuotas activas', async () => {
    let now = 10; const policy = crearPoliticaSolicitudes({ perMinute: 2, maxScopes: 1, now: () => now });
    await policy.run('a', async () => {}); await policy.run('a', async () => {});
    await assert.rejects(policy.run('a', async () => {}), /ocupado/);
    await assert.rejects(policy.run('b', async () => {}), /ocupado/);
    now += 60_001; await policy.run('b', async () => {}); assert.equal(policy.stats().scopes, 1);
});
test('servidores distintos comparten el presupuesto global del proveedor', async () => {
    const policy = crearPoliticaSolicitudes({ globalPerMinute: 2 });
    await policy.run('a', async () => {}); await policy.run('b', async () => {});
    await assert.rejects(policy.run('c', async () => {}), /ocupado/);
});
