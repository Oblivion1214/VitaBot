const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const { instalarManejoErrores } = require('../utils/manejoErrores');
const codigo = fs.readFileSync(require.resolve('../index'), 'utf8');
const marca = 'SECRETO_SINTETICO_NO_REAL_12345';
const turno = () => new Promise(resolve => setImmediate(resolve));
function preparar({ falloEntorno, falloIdentidad, falloComando, falloLogin, falloRespuesta, permitido = true } = {}) {
    const proceso = new EventEmitter(), registros = [], auditorias = [], salidas = [], cierres = [], temporizadores = [], respuestas = [];
    proceso.env = { TOKEN: marca }; proceso.exit = codigo => salidas.push(codigo);
    let client, control, opcionesDotenv;
    class Cliente extends EventEmitter {
        constructor() { super(); client = this; }
        async destroy() { cierres.push('discord'); }
        async login() { if (falloLogin) throw falloLogin; }
    }
    class Musica { close() { cierres.push('musica'); } }
    const comando = { data: { name: 'prueba' }, cooldown: 0, execute: async () => { if (falloComando) throw falloComando; } };
    const modulos = {
        './utils/manejoErrores': { instalarManejoErrores() {
            control = instalarManejoErrores({ proceso, escribir: texto => registros.push(texto),
                programar(fn, ms) { const timer = { fn, ms }; temporizadores.push(timer); return timer; }, cancelar() {} });
            return control;
        } },
        dotenv: { config(opciones) { opcionesDotenv = opciones; if (falloEntorno) throw falloEntorno; } },
        './utils/identidadEjecucion': { validarIdentidadEjecucion() { if (falloIdentidad) throw falloIdentidad; },
            iniciarSesionSegura: cliente => cliente.login(), esEntornoPruebas: () => false, esServidorPermitido: () => permitido },
        'discord.js': { Client: Cliente, Collection: Map, GatewayIntentBits: {}, MessageFlags: { Ephemeral: 64 } },
        fs: { readdirSync: () => ['prueba.js'] },
        'genius-lyrics': { Client: class {} },
        './utils/logger': { log: async (guild, datos) => auditorias.push(datos), obtenerConfigServidor: () => ({ activo: false }) },
        './utils/servicioMusica': { ServicioMusica: Musica },
        './utils/interfazMusica': { vincularInterfazMusica() {} },
        './utils/musicButtons': {},
        './utils/guildSetup': { registrarGuildCreate() {}, setupCollectors: new Map() },
        './utils/linkGuard': {}, './utils/rolesAutoservicio': {}, './utils/cuarentena': {},
        './utils/mantenimiento': { iniciarMantenimiento: () => ({ close() { cierres.push('mantenimiento'); } }) },
        './commands/prueba.js': comando,
    };
    try {
        vm.runInNewContext(codigo, { process: proceso, require(nombre) {
            assert.ok(Object.hasOwn(modulos, nombre), 'Importación inesperada: ' + nombre); return modulos[nombre];
        }, console: { log() {}, error: (...datos) => registros.push(datos.join(' ')), warn() {} },
        setTimeout(fn, ms) { temporizadores.push({ fn, ms }); },
        });
    } catch (error) { proceso.emit('uncaughtException', error); }
    const interaccion = { isChatInputCommand: () => true, commandName: 'prueba', user: { id: 'usuario' }, guild: {},
        reply: async datos => { if (falloRespuesta) throw falloRespuesta; respuestas.push(datos); } };
    return { proceso, registros, auditorias, salidas, cierres, temporizadores, respuestas, client, control, comando, interaccion,
        get opcionesDotenv() { return opcionesDotenv; } };
}
test('el límite de errores ya protege fallos al cargar el entorno y validar la identidad', () => {
    for (const opciones of [{ falloEntorno: new Error(marca) }, { falloIdentidad: new Error(marca) }]) {
        const f = preparar(opciones); assert.deepEqual(f.salidas, [1]); assert.equal(f.client, undefined);
        assert.equal(f.registros.join('').includes(marca), false);
    }
});
test('el login rechazado se captura, limpia todos los recursos y no expone su error', async () => {
    const f = preparar({ falloLogin: { token: marca } }); await turno();
    assert.deepEqual(f.salidas, [1]); assert.deepEqual(f.cierres, ['mantenimiento', 'musica', 'discord']);
    assert.match(f.registros.join(''), /sesión de Discord/); assert.equal(f.registros.join('').includes(marca), false);
    assert.equal(f.opcionesDotenv.quiet, true);
});
test('un comando con error hostil conserva respuesta local, auditoría genérica y permite otro comando', async () => {
    let accesos = 0;
    const hostil = { get message() { accesos++; throw Error(marca); }, toString() { accesos++; throw Error(marca); } };
    const f = preparar({ falloComando: hostil });
    const ejecutar = f.client.listeners('interactionCreate')[0]; await ejecutar(f.interaccion);
    assert.equal(accesos, 0); assert.equal(f.respuestas.length, 1); assert.equal(f.auditorias.length, 1);
    assert.equal(JSON.stringify(f.auditorias).includes(marca), false); assert.equal(f.registros.join('').includes(marca), false);
    assert.deepEqual(f.salidas, []);
    let ejecutado = false; f.comando.execute = async () => { ejecutado = true; }; await ejecutar(f.interaccion);
    assert.equal(ejecutado, true);
});
test('una respuesta de interacción fallida no imprime datos del proveedor ni se convierte en fatal', async () => {
    const f = preparar({ falloComando: new Error(marca), falloRespuesta: new Error(marca) });
    f.interaccion.deferred = true;
    f.interaccion.followUp = async () => { throw new Error(marca); };
    await f.client.listeners('interactionCreate')[0](f.interaccion);
    assert.match(f.registros.join(''), /responder a una interacción/); assert.equal(f.registros.join('').includes(marca), false);
    assert.deepEqual(f.salidas, []);
});
test('el cierre por señal limpia y deja de aceptar comandos', async () => {
    const f = preparar(); let ejecutado = false; f.comando.execute = async () => { ejecutado = true; };
    f.proceso.emit('SIGTERM'); await f.client.listeners('interactionCreate')[0](f.interaccion); await turno();
    assert.deepEqual(f.cierres, ['mantenimiento', 'musica', 'discord']); assert.deepEqual(f.salidas, [0]); assert.equal(ejecutado, false);
});
test('una respuesta de cooldown que Discord rechaza sigue siendo un fallo recuperable', async () => {
    const f = preparar(), ejecutar = f.client.listeners('interactionCreate')[0];
    await ejecutar(f.interaccion);
    f.comando.cooldown = 10;
    f.interaccion.reply = async () => { throw new Error(marca); };
    await assert.doesNotReject(ejecutar(f.interaccion));
    assert.match(f.registros.join(''), /responder a una interacción/);
    assert.equal(f.registros.join('').includes(marca), false); assert.deepEqual(f.salidas, []);
});
test('el dispatcher no ejecuta comandos ni procesa contenido de servidores no permitidos', async () => {
    const f = preparar({ permitido: false }); let ejecutado = false;
    f.comando.execute = async () => { ejecutado = true; };
    await f.client.listeners('interactionCreate')[0](f.interaccion);
    await f.client.listeners('messageCreate')[0]({ guildId: 'ajeno', get content() { throw Error('No debe leer mensajes ajenos'); } });
    f.client.emit('voiceStateUpdate', {}, { guild: { id: 'ajeno' } });
    assert.equal(ejecutado, false); assert.deepEqual(f.respuestas, []); assert.deepEqual(f.salidas, []);
});
