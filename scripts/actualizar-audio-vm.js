// Se ejecuta dentro de la VM. No imprime el contenido de .env ni modifica cookies.
const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { execFileSync } = require('node:child_process');

const [rootArg, endpointArg, previousHost] = process.argv.slice(2);
if (!rootArg || !endpointArg || !previousHost) {
    throw new Error('Uso: node actualizar-audio-vm.js DIRECTORIO URL_PC HOST_ANTERIOR');
}
const root = fs.realpathSync(path.resolve(rootArg));
const endpoint = new URL(endpointArg);
if (endpoint.protocol !== 'http:' || endpoint.port !== '3000' || endpoint.username || endpoint.password) {
    throw new Error('Se espera la URL HTTP privada de audio en el puerto 3000, sin credenciales.');
}
if (!fs.existsSync(path.join(root, 'index.js')) || !fs.existsSync(path.join(root, 'package.json'))) {
    throw new Error('El directorio no contiene la aplicación esperada.');
}

const files = ['index.js'];
for (const dir of ['commands', 'utils']) {
    for (const name of fs.readdirSync(path.join(root, dir))) {
        if (name.endsWith('.js')) files.push(path.join(dir, name));
    }
}
const changes = [];
for (const relative of files) {
    const file = path.join(root, relative);
    if (fs.lstatSync(file).isSymbolicLink()) throw new Error('No se modifican enlaces simbólicos.');
    const before = fs.readFileSync(file, 'utf8');
    const after = before.split(previousHost).join(endpoint.hostname);
    if (after !== before) changes.push({ relative, before, after, mode: fs.statSync(file).mode });
}
const envFile = path.join(root, '.env');
if (fs.lstatSync(envFile).isSymbolicLink()) throw new Error('El .env no puede ser un enlace simbólico.');
const envBefore = fs.readFileSync(envFile, 'utf8');
const line = `PC_AUDIO_URL=${endpoint.origin}`;
const envAfter = /^PC_AUDIO_URL=/m.test(envBefore)
    ? envBefore.replace(/^PC_AUDIO_URL=[^\r\n]*/m, line)
    : `${envBefore.replace(/\s*$/, '')}\n${line}\n`;
if (envAfter !== envBefore) changes.push({ relative: '.env', before: envBefore, after: envAfter, mode: fs.statSync(envFile).mode });

if (!changes.length) {
    console.log(JSON.stringify({ root, changed: [], alreadyConfigured: true }));
    process.exit(0);
}
const backupRoot = process.env.VITABOT_BACKUP_DIR || path.join(os.homedir(), '.vitabot-backups');
fs.mkdirSync(backupRoot, { recursive: true, mode: 0o700 });
const backup = fs.mkdtempSync(path.join(backupRoot, 'audio-'));
fs.chmodSync(backup, 0o700);
for (const change of changes) {
    const saved = path.join(backup, 'before', change.relative);
    const proposed = path.join(backup, 'proposed', change.relative);
    fs.mkdirSync(path.dirname(saved), { recursive: true, mode: 0o700 });
    fs.mkdirSync(path.dirname(proposed), { recursive: true, mode: 0o700 });
    fs.writeFileSync(saved, change.before, { mode: 0o600 });
    fs.writeFileSync(proposed, change.after, { mode: 0o600 });
    if (change.relative.endsWith('.js')) {
        execFileSync(process.execPath, ['--check', proposed], { stdio: ['ignore', 'pipe', 'pipe'] });
    }
}
const manifest = { root, files: changes.map(c => c.relative) };
fs.writeFileSync(path.join(backup, 'manifest.json'), JSON.stringify(manifest, null, 2), { mode: 0o600 });
for (const change of changes) {
    const file = path.join(root, change.relative);
    const temp = `${file}.audio-update-${process.pid}`;
    fs.writeFileSync(temp, change.after, { mode: change.mode & 0o777 });
    fs.renameSync(temp, file);
}
console.log(JSON.stringify({ root, changed: manifest.files, backup, syntax: 'OK' }));
