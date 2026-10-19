const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { parseEnv } = require('node:util');
const { compartirConfiguracion } = require('../scripts/compartir-configuracion-auditoria');
function fixture(t, tokenB = 'same-token') {
    const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'vita-share-config-'));
    t.after(() => { assert.equal(path.dirname(directory), os.tmpdir()); fs.rmSync(directory, { recursive: true, force: true }); });
    const root = path.join(directory, 'main'), secondary = path.join(directory, 'tests');
    for (const [dir, token] of [[root, 'same-token'], [secondary, tokenB]]) {
        fs.mkdirSync(path.join(dir, 'config'), { recursive: true });
        fs.writeFileSync(path.join(dir, '.env'), `TOKEN=${token}\nANOTHER_KEY=preserved\n`);
    }
    fs.writeFileSync(path.join(root, 'config/audit-config.json'), JSON.stringify({ a: { _setupCompleto: true, canalLogMode: 'custom' }, b: { _setupCompleto: false } }));
    fs.writeFileSync(path.join(secondary, 'config/audit-config.json'), JSON.stringify({ a: { _setupCompleto: false, canalLogMode: 'auto' }, b: { _setupCompleto: true } }));
    return { root, secondary, target: path.join(directory, 'shared state', 'audit.json'), backup: path.join(directory, 'backup') };
}
test('principal y pruebas conservan aceptaciones y usan la misma ruta tras cambiar de copia', t => {
    const args = fixture(t);
    assert.deepEqual(compartirConfiguracion(args), { guilds: 2, confirmed: 2 });
    const value = JSON.parse(fs.readFileSync(args.target));
    assert.equal(value.a._setupCompleto, true); assert.equal(value.a.canalLogMode, 'custom'); assert.equal(value.b._setupCompleto, true);
    for (const root of [args.root, args.secondary]) {
        const env = parseEnv(fs.readFileSync(path.join(root, '.env'), 'utf8'));
        assert.equal(path.resolve(env.AUDIT_CONFIG_PATH), args.target); assert.equal(env.ANOTHER_KEY, 'preserved');
    }
    value.a.canalLogMode = 'new-choice'; fs.writeFileSync(args.target, JSON.stringify(value));
    compartirConfiguracion(args);
    assert.equal(JSON.parse(fs.readFileSync(args.target)).a.canalLogMode, 'new-choice');
    assert.equal(parseEnv(fs.readFileSync(path.join(args.backup, 'env-0.backup'), 'utf8')).AUDIT_CONFIG_PATH, undefined);
});
test('no mezcla la configuración de dos bots distintos', t => {
    const args = fixture(t, 'different-token');
    assert.throws(() => compartirConfiguracion(args), /mismo bot/); assert.equal(fs.existsSync(args.target), false);
});
test('configuración corrupta detiene la migración antes de modificar el entorno', t => {
    const args = fixture(t), original = fs.readFileSync(path.join(args.root, '.env'), 'utf8');
    fs.writeFileSync(path.join(args.secondary, 'config/audit-config.json'), '{broken');
    assert.throws(() => compartirConfiguracion(args), /dañada/);
    assert.equal(fs.readFileSync(path.join(args.root, '.env'), 'utf8'), original); assert.equal(fs.existsSync(args.target), false);
});
