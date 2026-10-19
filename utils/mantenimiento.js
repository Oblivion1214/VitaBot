const fs = require('node:fs');
const path = require('node:path');
const os = require('node:os');
const { crearAlmacenConfiguracionJson } = require('./almacenConfiguracionJson');
const { rotarRegistroActivo } = require('./registroLimitado');
const { esEntornoPruebas } = require('./identidadEjecucion');
function eliminarVencidos(state, time) {
    const result = structuredClone(state);
    for (const field of ['cases', 'panels']) {
        if (!result[field] || typeof result[field] !== 'object') continue;
        for (const [id, record] of Object.entries(result[field])) if (!(record.expiresAt > time)) delete result[field][id];
    }
    return result;
}
function ejecutarMantenimiento({ auditPath, securityPath, backupDir, logFiles = [], now = Date.now }) {
    let failure;
    const date = new Date(now()).toISOString().slice(0, 10);
    fs.mkdirSync(backupDir, { recursive: true, mode: 0o700 });
    for (const [kind, source] of [['audit', auditPath], ['security', securityPath]]) {
        const target = path.join(backupDir, `${kind}-${date}.json`);
        try {
            if (fs.existsSync(source) && !fs.existsSync(target)) {
                const value = crearAlmacenConfiguracionJson(source).read();
                crearAlmacenConfiguracionJson(target).write(kind === 'security' ? eliminarVencidos(value, now()) : value);
            }
        } catch (error) { failure ||= error; }
        const names = fs.readdirSync(backupDir).filter(name => new RegExp(`^${kind}-\\d{4}-\\d{2}-\\d{2}\\.json$`).test(name)).sort().reverse();
        for (const name of names.slice(7)) fs.unlinkSync(path.join(backupDir, name));
        if (kind === 'security') for (const name of names.slice(0, 7)) {
            try {
                const store = crearAlmacenConfiguracionJson(path.join(backupDir, name)), old = store.read(), clean = eliminarVencidos(old, now());
                if (JSON.stringify(old) !== JSON.stringify(clean)) store.write(clean);
            } catch (error) { failure ||= error; }
        }
    }
    for (const file of logFiles) rotarRegistroActivo(file);
    if (failure) throw failure;
}
function iniciarMantenimiento({ env = process.env, now = Date.now } = {}) {
    const auditPath = env.AUDIT_CONFIG_PATH || path.join(__dirname, '../config/audit-config.json');
    const securityPath = env.SECURITY_STATE_PATH || path.join(path.dirname(auditPath), 'security-state.json');
    const backupDir = path.join(path.dirname(auditPath), 'backups');
    const logDir = path.join(env.PM2_HOME || path.join(os.homedir(), '.pm2'), 'logs');
    const nombre = esEntornoPruebas(env) ? 'vitabot-pruebas' : 'vitabot';
    const logFiles = [`${nombre}-out.log`, `${nombre}-error.log`].map(name => path.join(logDir, name));
    let lastBackup = -Infinity;
    const tick = () => {
        try {
            if (now() - lastBackup >= 3600_000) { ejecutarMantenimiento({ auditPath, securityPath, backupDir, logFiles, now }); lastBackup = now(); }
            else for (const file of logFiles) rotarRegistroActivo(file);
        } catch { console.warn('[Mantenimiento] No se pudo completar una tarea local; se conserva la configuración original.'); }
    };
    tick(); const timer = setInterval(tick, 60_000); timer.unref();
    return { close() { clearInterval(timer); } };
}
module.exports = { ejecutarMantenimiento, eliminarVencidos, iniciarMantenimiento };
