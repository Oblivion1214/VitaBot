const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { validarIdentidadEjecucion } = require('../utils/identidadEjecucion');
test('producción conserva arranque y pruebas rechaza identidad o estado compartidos', t => {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vita-identities-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    const production = path.join(root, 'production.env');
    fs.writeFileSync(production, 'TOKEN=production\nCLIENT_ID=production-app\nAUDIT_CONFIG_PATH=' + path.join(root, 'audit.json').replaceAll('\\', '/') + '\n');
    validarIdentidadEjecucion({});
    const env = { BOT_ENV: 'test', PRODUCTION_ENV_PATH: production, TOKEN: 'production', CLIENT_ID: 'other-app' };
    assert.throws(() => validarIdentidadEjecucion(env, root), /distinta/);
    env.TOKEN = 'other'; env.AUDIT_CONFIG_PATH = path.join(root, 'audit.json');
    assert.throws(() => validarIdentidadEjecucion(env, root), /separados/);
    env.AUDIT_CONFIG_PATH = path.join(root, 'testing.json'); env.SECURITY_STATE_PATH = path.join(root, 'test-state.json');
    validarIdentidadEjecucion(env, root);
});
