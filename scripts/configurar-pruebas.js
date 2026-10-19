const fs = require('node:fs'), path = require('node:path'), os = require('node:os');
const { randomBytes } = require('node:crypto');
const { parseEnv, parseArgs } = require('node:util');
const { validarSeparacionEstado, verificarAplicacionPruebas } = require('../utils/identidadEjecucion');
const { crearAlmacenConfiguracionJson } = require('../utils/almacenConfiguracionJson');

function guardarEntorno(archivo, datos) {
    if (fs.existsSync(archivo) && fs.lstatSync(archivo).isSymbolicLink()) throw Error('No se modifica un entorno enlazado.');
    const temporal = archivo + '.' + process.pid + '.tmp';
    try {
        fs.writeFileSync(temporal, Object.entries(datos).map(([clave, valor]) => {
            const texto = ['PRODUCTION_ENV_PATH', 'AUDIT_CONFIG_PATH', 'SECURITY_STATE_PATH'].includes(clave) ? String(valor).replaceAll('\\', '/') : String(valor);
            return `${clave}=${JSON.stringify(texto)}`;
        }).join('\n') + '\n', { flag: 'wx', mode: 0o600 });
        fs.renameSync(temporal, archivo); fs.chmodSync(archivo, 0o600);
    } finally { try { fs.unlinkSync(temporal); } catch {} }
}
function prepararPruebas({ raiz = process.cwd(), principal, estado = path.join(os.homedir(), '.config/VitaBot-pruebas') } = {}) {
    raiz = fs.realpathSync(raiz); principal = fs.realpathSync(principal);
    const comparar = valor => process.platform === 'win32' ? valor.toLowerCase() : valor;
    if (comparar(raiz) === comparar(principal)) throw Error('El directorio de pruebas debe ser distinto del principal.');
    for (const carpeta of [raiz, principal]) if (!fs.existsSync(path.join(carpeta, 'index.js'))) throw Error('El directorio no contiene VitaBot.');
    const archivo = path.join(raiz, '.env'), produccion = parseEnv(fs.readFileSync(path.join(principal, '.env'), 'utf8'));
    const previo = fs.existsSync(archivo) ? parseEnv(fs.readFileSync(archivo, 'utf8')) : {};
    estado = path.resolve(estado);
    const rutas = { AUDIT_CONFIG_PATH: path.join(estado, 'audit-config.json'), SECURITY_STATE_PATH: path.join(estado, 'security-state.json') };
    validarSeparacionEstado(rutas, raiz, produccion, principal);
    const marcador = path.join(raiz, '.vitabot-pruebas');
    if (fs.existsSync(marcador) && fs.lstatSync(marcador).isSymbolicLink()) throw Error('Marcador enlazado no permitido.');
    fs.writeFileSync(marcador, 'pruebas\n', { mode: 0o600 });
    if (previo.BOT_ENV === 'test' && previo.PRODUCTION_ENV_PATH === path.join(principal, '.env').replaceAll('\\', '/') &&
        previo.AUDIT_CONFIG_PATH === rutas.AUDIT_CONFIG_PATH.replaceAll('\\', '/') && previo.SECURITY_STATE_PATH === rutas.SECURITY_STATE_PATH.replaceAll('\\', '/')) {
        return { preparado: true, sinCambios: true, credencialesPendientes: !previo.TOKEN || !previo.CLIENT_ID || !previo.TEST_GUILD_ID };
    }
    const configuracion = { BOT_ENV: 'test', PRODUCTION_ENV_PATH: path.join(principal, '.env'), TOKEN: '', CLIENT_ID: '', TEST_GUILD_ID: '', ...rutas };
    if (previo.TOKEN && previo.TOKEN !== produccion.TOKEN && previo.CLIENT_ID && previo.CLIENT_ID !== produccion.CLIENT_ID) {
        configuracion.TOKEN = previo.TOKEN; configuracion.CLIENT_ID = previo.CLIENT_ID; configuracion.TEST_GUILD_ID = previo.TEST_GUILD_ID || '';
    }
    const audio = new URL(produccion.PC_AUDIO_URL); audio.port = '3003';
    configuracion.PC_AUDIO_URL = audio.origin;
    configuracion.AUDIO_SHARED_TOKEN = randomBytes(32).toString('hex');
    // Las claves de proveedores se habilitan después con credenciales propias de pruebas.
    for (const clave of ['GEMINI_API_KEY', 'GENIUS_TOKEN', 'HF_TOKEN', 'VIRUSTOTAL_KEY', 'GOOGLE_SAFE_BROWSING_KEY', 'IPQS_KEY', 'URLSCAN_KEY', 'URLHAUS_KEY']) configuracion[clave] = '';
    configuracion.URLSCAN_ENABLED = 'false';
    fs.mkdirSync(estado, { recursive: true, mode: 0o700 });
    for (const [nombre, inicial] of [['audit-config.json', {}], ['security-state.json', { version: 1, panels: {}, cases: {} }]]) {
        const destino = path.join(estado, nombre), almacen = crearAlmacenConfiguracionJson(destino);
        if (fs.existsSync(destino)) almacen.read(); else almacen.write(inicial);
    }
    if (fs.existsSync(archivo)) {
        const respaldo = path.join(raiz, '.cache', 'entorno-anterior-pruebas-' + Date.now() + '.env');
        fs.mkdirSync(path.dirname(respaldo), { recursive: true, mode: 0o700 });
        fs.copyFileSync(archivo, respaldo, fs.constants.COPYFILE_EXCL); fs.chmodSync(respaldo, 0o600);
    }
    guardarEntorno(archivo, configuracion);
    return { preparado: true, credencialesPendientes: !configuracion.TOKEN || !configuracion.CLIENT_ID || !configuracion.TEST_GUILD_ID };
}
async function configurarCredenciales({ raiz = process.cwd(), token, aplicacion, servidor, consultar = fetch }) {
    const archivo = path.join(raiz, '.env'), env = parseEnv(fs.readFileSync(archivo, 'utf8'));
    if (env.BOT_ENV !== 'test') throw Error('Primero prepara el entorno independiente de pruebas.');
    const candidato = { ...env, TOKEN: token, CLIENT_ID: aplicacion, TEST_GUILD_ID: servidor };
    await verificarAplicacionPruebas(candidato, raiz, { consultar, argumentos: ['--pruebas'] });
    guardarEntorno(archivo, candidato);
    const { PermissionFlagsBits: P } = require('discord.js');
    const permisos = [P.ViewChannel, P.SendMessages, P.EmbedLinks, P.AttachFiles, P.ReadMessageHistory, P.Connect, P.Speak, P.ManageMessages, P.ManageChannels, P.ManageRoles].reduce((a, b) => a | b, 0n);
    const enlace = new URL('https://discord.com/oauth2/authorize');
    enlace.search = new URLSearchParams({ client_id: aplicacion, scope: 'bot applications.commands', permissions: String(permisos), guild_id: servidor, disable_guild_select: 'true' }).toString();
    return { configurado: true, enlaceInvitacion: enlace.href };
}
function leerTokenOculto() {
    if (!process.stdin.isTTY) throw Error('Introduce el token únicamente en una terminal interactiva.');
    process.stdout.write('Token del bot NUEVO (entrada oculta; no se guardará en el historial): ');
    return new Promise((resolve, reject) => {
        let valor = '';
        const terminar = () => { process.stdin.off('data', recibir); process.stdin.setRawMode(false); process.stdin.pause(); process.stdout.write('\n'); };
        function recibir(datos) {
            for (const caracter of datos.toString('utf8')) {
                if (caracter === '\u0003') { terminar(); reject(Error('Entrada cancelada.')); return; }
                if (caracter === '\r' || caracter === '\n') { terminar(); resolve(valor.trim()); return; }
                if (caracter === '\u007f' || caracter === '\b') valor = valor.slice(0, -1);
                else if (caracter >= ' ' && caracter <= '~' && valor.length < 1024) valor += caracter;
            }
        }
        process.stdin.setRawMode(true); process.stdin.resume(); process.stdin.on('data', recibir);
    });
}
if (require.main === module) (async () => {
    const { values } = parseArgs({ options: { preparar: { type: 'boolean' }, credenciales: { type: 'boolean' }, principal: { type: 'string' }, estado: { type: 'string' }, aplicacion: { type: 'string' }, servidor: { type: 'string' } } });
    if (values.credenciales && (!/^[0-9]{17,20}$/.test(values.aplicacion || '') || !/^[0-9]{17,20}$/.test(values.servidor || ''))) throw Error('Indica --aplicacion y --servidor con sus IDs.');
    const resultado = values.preparar ? prepararPruebas({ principal: values.principal, estado: values.estado })
        : values.credenciales ? await configurarCredenciales({ token: await leerTokenOculto(), aplicacion: values.aplicacion, servidor: values.servidor })
        : (() => { throw Error('Usa --preparar o --credenciales.'); })();
    console.log(JSON.stringify(resultado));
})().catch(() => { console.error('No se pudo configurar el bot de pruebas. Revisa los directorios, IDs y la aplicación elegida.'); process.exitCode = 1; });
module.exports = { prepararPruebas, configurarCredenciales };
