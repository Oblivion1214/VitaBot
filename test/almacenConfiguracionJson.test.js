const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { crearAlmacenConfiguracionJson } = require('../utils/almacenConfiguracionJson');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vita-config-store-'));
    t.after(() => {
        assert.equal(path.dirname(root), os.tmpdir());
        fs.rmSync(root, { recursive: true, force: true });
    });
    return { root, file: path.join(root, 'config', 'audit.json') };
}
test('crear configuración y reemplazarla conserva las confirmaciones de otros servidores', t => {
    const { file } = fixture(t), store = crearAlmacenConfiguracionJson(file);
    assert.deepEqual(store.read(), {});
    store.write({ a: { _setupCompleto: true } });
    const value = store.read(); value.b = { _setupAceptado: true }; store.write(value);
    assert.deepEqual(store.read(), { a: { _setupCompleto: true }, b: { _setupAceptado: true } });
    assert.deepEqual(fs.readdirSync(path.dirname(file)), ['audit.json']);
});
test('un JSON dañado no se interpreta como pérdida de todas las confirmaciones', t => {
    const { root } = fixture(t), file = path.join(root, 'audit.json');
    fs.writeFileSync(file, '{broken');
    assert.throws(() => crearAlmacenConfiguracionJson(file).read(), /dañada/);
    assert.equal(fs.readFileSync(file, 'utf8'), '{broken');
});
test('un error de permisos de lectura no se convierte en una configuración vacía', () => {
    const io = { readFileSync() { throw Object.assign(Error('private path'), { code: 'EACCES' }); } };
    assert.throws(() => crearAlmacenConfiguracionJson('unused', io).read(), /No se pudo leer/);
});
test('si falla el reemplazo atómico permanece intacta la confirmación anterior', t => {
    const { root } = fixture(t), file = path.join(root, 'audit.json');
    fs.writeFileSync(file, JSON.stringify({ a: { _setupCompleto: true } }));
    const store = crearAlmacenConfiguracionJson(file, { ...fs, renameSync() { throw Error('disk failure'); } });
    assert.throws(() => store.write({ b: {} }), /No se pudo guardar/);
    assert.deepEqual(store.read(), { a: { _setupCompleto: true } });
    assert.deepEqual(fs.readdirSync(root), ['audit.json']);
});
test('rechaza arreglos y null como archivos de configuración', t => {
    const { root } = fixture(t), file = path.join(root, 'audit.json');
    for (const value of ['[]', 'null']) {
        fs.writeFileSync(file, value); assert.throws(() => crearAlmacenConfiguracionJson(file).read(), /dañada/);
    }
});
