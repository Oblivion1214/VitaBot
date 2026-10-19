const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
function esEntornoPruebas(env = process.env, argumentos = process.argv) {
    return env.BOT_ENV === 'test' || argumentos?.includes('--pruebas') === true;
}
function esServidorPermitido(guildId, env = process.env, argumentos = process.argv) {
    return !esEntornoPruebas(env, argumentos) || !!guildId && guildId === env.TEST_GUILD_ID;
}
function validarIdentidadEjecucion(env = process.env, root = process.cwd(), argumentos = process.argv) {
    if (!esEntornoPruebas(env, argumentos)) return;
    if (!env.PRODUCTION_ENV_PATH) throw Error('Configura PRODUCTION_ENV_PATH antes de iniciar el bot de pruebas.');
    const productionFile = path.resolve(root, env.PRODUCTION_ENV_PATH);
    const production = parseEnv(fs.readFileSync(productionFile, 'utf8'));
    if (!env.TOKEN?.trim() || !production.TOKEN?.trim() || env.TOKEN.trim() === production.TOKEN.trim() ||
        !production.CLIENT_ID || !/^[0-9]{17,20}$/.test(env.CLIENT_ID || '') || env.CLIENT_ID === production.CLIENT_ID) {
        throw Error('Pruebas requiere una aplicación Discord distinta. No reutilices TOKEN ni CLIENT_ID de producción.');
    }
    if (!/^[0-9]{17,20}$/.test(env.TEST_GUILD_ID || '')) throw Error('Configura TEST_GUILD_ID con el servidor permitido para pruebas.');
    validarSeparacionEstado(env, root, production, path.dirname(productionFile));
    return production.CLIENT_ID;
}
function validarSeparacionEstado(env, root, production, productionRoot) {
    function canonical(file) {
        const missing = []; let current = file;
        while (!fs.existsSync(current) && path.dirname(current) !== current) { missing.unshift(path.basename(current)); current = path.dirname(current); }
        const value = path.join(fs.realpathSync(current), ...missing);
        return process.platform === 'win32' ? value.toLowerCase() : value;
    }
    const statePath = (settings, base, name) => canonical(path.resolve(base, settings[name] || (name === 'AUDIT_CONFIG_PATH'
        ? 'config/audit-config.json' : path.join(path.dirname(settings.AUDIT_CONFIG_PATH || 'config/audit-config.json'), 'security-state.json'))));
    const propias = ['AUDIT_CONFIG_PATH', 'SECURITY_STATE_PATH'].map(key => statePath(env, root, key));
    const principales = ['AUDIT_CONFIG_PATH', 'SECURITY_STATE_PATH'].map(key => statePath(production, productionRoot, key));
    function mismoArchivo(a, b) {
        if (a === b) return true;
        if (!fs.existsSync(a) || !fs.existsSync(b)) return false;
        const x = fs.statSync(a), y = fs.statSync(b);
        return x.ino !== 0 && x.dev === y.dev && x.ino === y.ino;
    }
    if (mismoArchivo(propias[0], propias[1]) || propias.some(a => principales.some(b => mismoArchivo(a, b))) ||
        path.dirname(propias[0]) !== path.dirname(propias[1]) ||
        principales.some(archivo => path.dirname(archivo) === path.dirname(propias[0]))) {
        throw Error('Pruebas requiere archivos de estado separados de producción y una carpeta propia para sus respaldos.');
    }
}
async function verificarAplicacionPruebas(env = process.env, root = process.cwd(), { consultar = fetch, argumentos = process.argv } = {}) {
    if (!esEntornoPruebas(env, argumentos)) return;
    const principal = validarIdentidadEjecucion(env, root, argumentos);
    try {
        const respuesta = await consultar('https://discord.com/api/v10/oauth2/applications/@me', {
            headers: { Authorization: 'Bot ' + env.TOKEN }, redirect: 'error', signal: AbortSignal.timeout(8000),
        });
        if (!respuesta.ok) { await respuesta.body?.cancel(); throw Error(); }
        const aplicacion = await respuesta.json();
        if (aplicacion.id !== env.CLIENT_ID || aplicacion.id === principal) throw Error();
    } catch { throw Error('No se pudo validar que el token pertenezca a la aplicación independiente de pruebas.'); }
}
async function iniciarSesionSegura(client, env = process.env, root = process.cwd(), opciones) {
    await verificarAplicacionPruebas(env, root, opciones);
    return client.login(env.TOKEN);
}
module.exports = { validarIdentidadEjecucion, validarSeparacionEstado, esEntornoPruebas, esServidorPermitido, verificarAplicacionPruebas, iniciarSesionSegura };
