const path = require('node:path');
const crypto = require('node:crypto');
const fs = require('node:fs');
const { crearAlmacenConfiguracionJson } = require('./almacenConfiguracionJson');

function crearAlmacenSeguridad(file, { now = Date.now, io = fs } = {}) {
    const json = crearAlmacenConfiguracionJson(file, io);
    function read() {
        const value = json.read();
        if (value.version !== undefined && value.version !== 1) throw Error('Versión de seguridad desconocida.');
        const state = { version: 1, panels: {}, cases: {}, ...value };
        for (const field of ['panels', 'cases']) {
            if (!state[field] || typeof state[field] !== 'object' || Array.isArray(state[field])) throw Error('Registro de seguridad inválido.');
        }
        return state;
    }
    function update(action) {
        io.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
        let lock;
        try { lock = io.openSync(`${file}.lock`, 'wx', 0o600); }
        catch { throw Error('Registro de seguridad ocupado. Reintenta cuando termine la otra operación.'); }
        try {
        const state = read();
        // Opportunistic bounded retention; no process, database or periodic timer needed.
        for (const [id, record] of Object.entries(state.cases)) {
            if (record.expiresAt <= now()) delete state.cases[id];
        }
        for (const [id, record] of Object.entries(state.panels)) {
            if (record.expiresAt <= now()) delete state.panels[id];
        }
        const result = action(state); json.write(state); return result;
        } finally {
            io.closeSync(lock); io.unlinkSync(`${file}.lock`);
        }
    }
    return {
        prune() { update(() => {}); },
        addPanel(record) {
            return update(state => {
                if (Object.keys(state.panels).length >= 200) throw Error('Límite de paneles alcanzado.');
                state.panels[record.messageId] = { ...record, expiresAt: now() + 90 * 86400_000 };
            });
        },
        getPanel(id) { const r = read().panels[id]; return r?.expiresAt > now() ? r : null; },
        createCase(record) {
            return update(state => {
                if (Object.keys(state.cases).length >= 100) throw Error('Cuarentena llena; el mensaje se conserva.');
                if (record.originalMessageId && Object.values(state.cases).some(item => item.guildId === record.guildId && item.originalMessageId === record.originalMessageId)) {
                    throw Error('Este mensaje ya tiene un caso de cuarentena.');
                }
                const item = { ...record, id: crypto.randomUUID(), status: 'prepared', createdAt: now(), expiresAt: now() + 7 * 86400_000 };
                state.cases[item.id] = item; return item;
            });
        },
        getCase(id) { const r = read().cases[id]; return r?.expiresAt > now() ? r : null; },
        patchCase(id, patch) {
            return update(state => {
                if (!state.cases[id]) throw Error('Caso no disponible.');
                Object.assign(state.cases[id], patch); return state.cases[id];
            });
        },
        transitionCase(id, expected, patch) {
            return update(state => {
                const record = state.cases[id];
                if (!record || record.status !== expected) throw Error('Este caso cambió o ya se está procesando.');
                Object.assign(record, patch); return record;
            });
        },
    };
}
const defaultPath = process.env.SECURITY_STATE_PATH || path.join(path.dirname(
    process.env.AUDIT_CONFIG_PATH || path.join(__dirname, '../config/audit-config.json')), 'security-state.json');
const almacenSeguridad = crearAlmacenSeguridad(defaultPath);
// A single unreferenced timer, shared by all cases. Retention also survives idle servers.
const cleanup = setInterval(() => {
    try { almacenSeguridad.prune(); } catch { console.warn('[Seguridad] No se pudo limpiar el registro privado.'); }
}, 3600_000);
cleanup.unref();
module.exports = { crearAlmacenSeguridad, almacenSeguridad };
