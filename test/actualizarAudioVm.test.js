const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

test('el actualizador de la VM conserva credenciales, respalda cambios y es idempotente', () => {
    const cache = path.resolve(__dirname, '../.cache');
    fs.mkdirSync(cache, { recursive: true });
    const root = fs.mkdtempSync(path.join(cache, 'vm-audio-fixture-'));
    for (const dir of ['commands', 'utils']) fs.mkdirSync(path.join(root, dir));
    fs.writeFileSync(path.join(root, 'package.json'), '{}');
    fs.writeFileSync(path.join(root, 'index.js'), 'module.exports = {};');
    fs.writeFileSync(path.join(root, 'commands/play.js'), 'const url = "http://100.127.221.32:3000/api/play";');
    fs.writeFileSync(path.join(root, '.env'), 'TOKEN=TEST_ONLY_PLACEHOLDER\n');
    const env = { ...process.env, VITABOT_BACKUP_DIR: path.join(root, 'backups') };
    const args = [path.resolve(__dirname, '../scripts/actualizar-audio-vm.js'), root, 'http://100.100.213.77:3000', '100.127.221.32'];
    const result = JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8' }));
    assert.ok(fs.readFileSync(path.join(root, 'commands/play.js'), 'utf8').includes('100.100.213.77'));
    assert.ok(fs.readFileSync(path.join(root, '.env'), 'utf8').includes('TOKEN=TEST_ONLY_PLACEHOLDER'));
    assert.equal(fs.readFileSync(path.join(result.backup, 'before/.env'), 'utf8'), 'TOKEN=TEST_ONLY_PLACEHOLDER\n');
    const again = JSON.parse(execFileSync(process.execPath, args, { env, encoding: 'utf8' }));
    assert.equal(again.alreadyConfigured, true);
});
