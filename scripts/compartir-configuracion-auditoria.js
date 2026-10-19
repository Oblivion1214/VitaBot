const fs = require('node:fs');
const path = require('node:path');
const { parseEnv, parseArgs } = require('node:util');
const { crearAlmacenConfiguracionJson } = require('../utils/almacenConfiguracionJson');

function compartirConfiguracion({ root, secondary, target, backup }) {
    const roots = [root, secondary].map(value => path.resolve(value));
    target = path.resolve(target);
    backup = path.resolve(backup);
    if (roots[0] === roots[1]) throw new Error('Se requieren dos copias diferentes.');
    const sources = roots.map(directory => {
        const envFile = path.join(directory, '.env');
        const text = fs.readFileSync(envFile, 'utf8');
        const env = parseEnv(text);
        return { directory, envFile, text, env, configFile: path.resolve(directory, env.AUDIT_CONFIG_PATH || 'config/audit-config.json') };
    });
    if (!sources[0].env.TOKEN || sources[0].env.TOKEN !== sources[1].env.TOKEN) throw new Error('Las copias deben pertenecer al mismo bot de Discord.');
    // Leer todo antes de escribir; un JSON dañado no puede borrar confirmaciones válidas.
    const existing = crearAlmacenConfiguracionJson(target).read();
    const [primary, testing] = sources.map(source => crearAlmacenConfiguracionJson(source.configFile).read());
    const merged = { ...testing, ...primary, ...existing };
    for (const id of Object.keys(merged)) {
        merged[id] = { ...merged[id] };
        if ([existing[id], primary[id], testing[id]].some(entry => entry?._setupCompleto === true)) merged[id]._setupCompleto = true;
    }
    fs.mkdirSync(backup, { recursive: true, mode: 0o700 });
    const preserve = (file, label) => {
        if (!fs.existsSync(file)) return;
        const destination = path.join(backup, label);
        if (fs.existsSync(destination)) return;
        fs.copyFileSync(file, destination, fs.constants.COPYFILE_EXCL);
        fs.chmodSync(destination, 0o600);
    };
    preserve(target, 'shared-original.json');
    sources.forEach((source, i) => { preserve(source.configFile, `config-${i}.json`); preserve(source.envFile, `env-${i}.backup`); });
    crearAlmacenConfiguracionJson(target).write(merged);
    for (const source of sources) {
        const portableTarget = process.platform === 'win32' ? target.replace(/\\/g, '/') : target;
        if (/[\r\n"]/.test(portableTarget)) throw new Error('Ruta de configuración no válida para el entorno.');
        const setting = `AUDIT_CONFIG_PATH="${portableTarget}"`;
        const updated = /^AUDIT_CONFIG_PATH=.*$/m.test(source.text)
            ? source.text.replace(/^AUDIT_CONFIG_PATH=.*$/m, () => setting)
            : `${source.text.trimEnd()}\n${setting}\n`;
        fs.writeFileSync(source.envFile, updated, { mode: 0o600 });
        fs.chmodSync(source.envFile, 0o600);
    }
    return { guilds: Object.keys(merged).length, confirmed: Object.values(merged).filter(entry => entry._setupCompleto === true).length };
}
if (require.main === module) {
    const { values } = parseArgs({ options: Object.fromEntries(['root', 'secondary', 'target', 'backup'].map(key => [key, { type: 'string' }])) });
    console.log(JSON.stringify(compartirConfiguracion(values)));
}
module.exports = { compartirConfiguracion };
