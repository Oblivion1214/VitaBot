const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { crearSupervisor } = require('../audio/supervisor');
function fixture(probe = async () => {}) {
    let now = 0; const children = [], timers = [], sent = [], killed = [];
    const supervisor = crearSupervisor({
        spawn() { const child = new EventEmitter(); child.send = value => sent.push(value); children.push(child); return child; },
        kill(child) { killed.push(child); child.emit('exit'); }, probe, now: () => now,
        schedule(fn, ms) { const timer = { fn, ms }; timers.push(timer); return timer; }, cancel(timer) { timer.cancelled = true; },
        every() { return {}; }, cancelEvery() {},
    });
    return { supervisor, children, timers, sent, killed, advance: ms => now += ms };
}
test('reintenta con espera creciente y no reinicia después de cerrar', () => {
    const f = fixture(); f.children[0].emit('exit'); assert.equal(f.timers[0].ms, 1000); f.timers[0].fn();
    f.children[1].emit('exit'); assert.equal(f.timers[1].ms, 2000); f.supervisor.close(); f.timers[1].fn();
    assert.equal(f.children.length, 2);
});
test('no reinicia por un fallo de health y detiene solo a su hijo después de dos fallos', async () => {
    const f = fixture(async () => { throw Error('offline'); }); f.advance(20_000);
    await f.supervisor.check(); assert.equal(f.sent.length, 0);
    await f.supervisor.check(); assert.equal(f.sent[0].type, 'shutdown');
    assert.equal(f.killed.length, 0); f.timers[0].fn(); assert.equal(f.killed[0], f.children[0]);
    f.supervisor.close();
});
test('health correcto no interrumpe la reproducción y reinicia contador de fallos', async () => {
    const f = fixture(); f.advance(20_000);
    await f.supervisor.check(); await f.supervisor.check(); assert.equal(f.sent.length, 0);
    f.supervisor.close(); assert.equal(f.sent[0].type, 'shutdown');
});
