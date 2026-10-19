const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), os = require('node:os'), path = require('node:path');
const { crearAlmacenSeguridad } = require('../utils/almacenSeguridad');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vita-security-store-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    return path.join(root, 'state.json');
}
test('los casos vencen y se eliminan del disco al limpiar', t => {
    const file = fixture(t); let now = 100;
    const store = crearAlmacenSeguridad(file, { now: () => now });
    const record = store.createCase({ content: 'private' });
    now += 7 * 86400_000 + 1;
    assert.equal(store.getCase(record.id), null); store.prune();
    assert.equal(fs.readFileSync(file, 'utf8').includes('private'), false);
});
test('almacenamiento lleno o dañado falla sin eliminar casos anteriores', t => {
    const file = fixture(t); const store = crearAlmacenSeguridad(file);
    for (let index = 0; index < 100; index++) store.createCase({ content: 'test' });
    assert.throws(() => store.createCase({ content: 'extra' }), /llena/);
    assert.equal(Object.keys(JSON.parse(fs.readFileSync(file, 'utf8')).cases).length, 100);
    fs.writeFileSync(file, '{broken'); assert.throws(() => store.getCase('any'), /dañada/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('los paneles autorizados sobreviven al reinicio y expiran a los 90 días', t => {
    const file = fixture(t); let now = 100; const store = crearAlmacenSeguridad(file, { now: () => now });
    store.addPanel({ messageId: 'panel', guildId: 'guild', roleId: 'role' });
    assert.equal(crearAlmacenSeguridad(file, { now: () => now }).getPanel('panel').roleId, 'role');
    now += 90 * 86400_000 + 1; assert.equal(store.getPanel('panel'), null);
});
test('otra instancia no puede sobrescribir un registro mientras se modifica', t => {
    const file = fixture(t); const other = crearAlmacenSeguridad(file);
    let attempted = false;
    const io = { ...fs, openSync(name, flags, mode) {
        const descriptor = fs.openSync(name, flags, mode);
        if (String(name).endsWith('.lock') && !attempted) {
            attempted = true;
            assert.throws(() => other.createCase({ content: 'concurrent' }), /ocupado/);
        }
        return descriptor;
    } };
    const first = crearAlmacenSeguridad(file, { io }); first.addPanel({ messageId: 'panel' });
    const record = other.createCase({ content: 'safe' }); first.prune();
    assert.equal(other.getCase(record.id).content, 'safe');
    assert.equal(other.getPanel('panel').messageId, 'panel');
});
test('solo una instancia puede reclamar una decisión y un mensaje original', t => {
    const file = fixture(t), first = crearAlmacenSeguridad(file), second = crearAlmacenSeguridad(file);
    const record = first.createCase({ content: 'original', guildId: 'guild', originalMessageId: 'message' });
    assert.throws(() => second.createCase({ guildId: 'guild', originalMessageId: 'message' }), /ya tiene/);
    first.transitionCase(record.id, 'prepared', { status: 'pending' });
    assert.equal(second.getCase(record.id).status, 'pending');
    first.transitionCase(record.id, 'pending', { status: 'restoring' });
    assert.throws(() => second.transitionCase(record.id, 'pending', { status: 'restoring' }), /ya se está/);
    assert.equal(second.getCase(record.id).status, 'restoring');
});
