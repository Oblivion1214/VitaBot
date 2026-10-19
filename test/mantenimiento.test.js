const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { ejecutarMantenimiento } = require('../utils/mantenimiento');
const { agregarRegistro, rotarRegistroActivo } = require('../utils/registroLimitado');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vita-maintenance-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    return root;
}
test('retiene siete respaldos por archivo y elimina contenido vencido también en los respaldos', t => {
    const root = fixture(t), auditPath = path.join(root, 'audit.json'), securityPath = path.join(root, 'state.json'), backupDir = path.join(root, 'backups');
    let now = Date.UTC(2026, 0, 1);
    fs.writeFileSync(auditPath, JSON.stringify({ guild: { _setupCompleto: true } }));
    fs.writeFileSync(securityPath, JSON.stringify({ cases: { old: { content: 'private', expiresAt: now + 86400_000 } }, panels: {} }));
    for (let day = 0; day < 9; day++) { ejecutarMantenimiento({ auditPath, securityPath, backupDir, now: () => now }); now += 86400_000; }
    const names = fs.readdirSync(backupDir);
    assert.equal(names.length, 14); assert.equal(names.filter(name => name.startsWith('audit')).length, 7);
    assert.ok(names.every(name => !fs.readFileSync(path.join(backupDir, name), 'utf8').includes('private')));
    assert.equal(JSON.parse(fs.readFileSync(auditPath, 'utf8')).guild._setupCompleto, true);
    assert.ok(fs.readFileSync(securityPath, 'utf8').includes('private')); // Never modifies the live store.
});
test('un original corrupto no se respalda ni reemplaza una copia válida', t => {
    const root = fixture(t), auditPath = path.join(root, 'audit.json'), securityPath = path.join(root, 'missing.json'), backupDir = path.join(root, 'backups');
    fs.writeFileSync(auditPath, '{broken');
    assert.throws(() => ejecutarMantenimiento({ auditPath, securityPath, backupDir }), /dañada/);
    assert.equal(fs.readFileSync(auditPath, 'utf8'), '{broken');
});
test('limpia casos vencidos de respaldos aunque el original falte y la auditoría esté dañada', t => {
    const root = fixture(t), backupDir = path.join(root, 'backups'), auditPath = path.join(root, 'audit.json');
    fs.mkdirSync(backupDir); fs.writeFileSync(auditPath, '{broken');
    const old = path.join(backupDir, 'security-2026-01-01.json');
    fs.writeFileSync(old, JSON.stringify({ cases: { expired: { content: 'private', expiresAt: 1 } } }));
    assert.throws(() => ejecutarMantenimiento({ auditPath, securityPath: path.join(root, 'missing.json'), backupDir }), /dañada/);
    assert.ok(!fs.readFileSync(old, 'utf8').includes('private'));
});
test('logs limitados rotan y copytruncate mantiene el descriptor activo de PM2', t => {
    const root = fixture(t), file = path.join(root, 'service.log');
    for (let i = 0; i < 8; i++) agregarRegistro(file, '1234567890', { limit: 20, copies: 2 });
    assert.equal(fs.readdirSync(root).length, 3);
    const fd = fs.openSync(file, 'a'); fs.writeSync(fd, 'x'.repeat(60));
    assert.equal(rotarRegistroActivo(file, { limit: 20, copies: 2 }), true);
    fs.writeSync(fd, 'still-open'); fs.closeSync(fd);
    assert.equal(fs.readFileSync(file, 'utf8'), 'still-open');
    assert.equal(fs.statSync(file + '.history').size, 20);
});
