const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const vm = require('node:vm');
const { createRequire } = require('node:module');
const { EventEmitter } = require('node:events');
const { Collection } = require('discord.js');
const tick = () => new Promise(resolve => setImmediate(resolve));

function cargarModulo(archivo, opciones = {}) {
    const ruta = path.join(__dirname, '..', archivo);
    const requerir = createRequire(ruta);
    const entorno = { module: { exports: {} }, __dirname: path.dirname(ruta),
        process: { env: opciones.env || {} }, console: opciones.console || { log() {}, warn() {}, error() {} },
        require: nombre => nombre === './logger' && opciones.logger ? opciones.logger : requerir(nombre),
    };
    vm.runInNewContext(fs.readFileSync(ruta, 'utf8'), entorno, { filename: ruta });
    return entorno.module.exports;
}

function preparar(t, opciones = {}) {
    const carpeta = fs.mkdtempSync(path.join(os.tmpdir(), 'vita-auditoria-'));
    t.after(() => fs.rmSync(carpeta, { recursive: true, force: true }));
    const ruta = path.join(carpeta, 'audit-config.json');
    const configuracion = {
        servidor: { activo: opciones.activo !== false, categorias: { general: true, musica: opciones.musica !== false },
            canalLogId: 'registro', canalLogMode: 'custom' },
        otro: { activo: true, categorias: { musica: true }, canalLogId: 'registro-otro', canalLogMode: 'custom' },
    };
    fs.writeFileSync(ruta, JSON.stringify(configuracion));
    const mensajes = [], avisos = [];
    const canal = { id: 'registro', name: 'auditoria', permissionsFor: () => ({ has: () => true }),
        send: async contenido => { mensajes.push(contenido); } };
    const guild = { id: 'servidor', name: 'Servidor de prueba', members: { me: {} },
        channels: { cache: new Collection([['registro', canal]]) } };
    const logger = opciones.logger || cargarModulo('utils/logger.js', { env: { AUDIT_CONFIG_PATH: ruta } });
    const interfaz = cargarModulo('utils/interfazMusica.js', { logger,
        console: { warn: mensaje => avisos.push(mensaje) } });
    const servicio = new EventEmitter();
    interfaz.vincularInterfazMusica(servicio);
    const sesion = { channel: { id: 'voz', guild }, bitrate: 64, tracks: [],
        textChannel: { send: async () => { if (opciones.falloPanel) throw Error('panel inaccesible'); return { edit: async () => {} }; } } };
    const propietario = { track: { title: 'Canción de prueba', author: 'Autor',
        durationSeconds: 19, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw' }, generation: 1 };
    sesion.current = propietario;
    return { servicio, sesion, propietario, mensajes, avisos, ruta, configuracion };
}

test('la reproducción envía el registro al canal designado del servidor', async t => {
    const f = preparar(t);
    f.servicio.emit('trackStart', f.sesion, f.propietario);
    await tick();
    assert.equal(f.mensajes.length, 1);
    const registro = f.mensajes[0].embeds[0].toJSON();
    assert.match(registro.title, /Reproducción iniciada/);
    assert.equal(registro.fields.find(c => c.name === 'Canción').value, 'Canción de prueba');
    assert.equal(registro.fields.find(c => c.name === 'Canal de voz').value, '<#voz>');
    assert.equal(JSON.parse(fs.readFileSync(f.ruta)).otro.canalLogId, 'registro-otro');
});

test('un fallo del panel de reproducción no impide enviar la auditoría', async t => {
    const f = preparar(t, { falloPanel: true });
    f.servicio.emit('trackStart', f.sesion, f.propietario);
    await f.sesion.panelTask;
    await tick();
    assert.equal(f.mensajes.length, 1);
});

for (const opcion of ['musica', 'activo']) {
    test(`respeta la opción ${opcion} desactivada en la configuración`, async t => {
        const f = preparar(t, { [opcion]: false });
        for (const evento of ['trackStart', 'trackError', 'speechStart', 'speechError', 'sessionStop']) {
            f.servicio.emit(evento, f.sesion, evento === 'trackStart' ? f.propietario : Error('privado'));
        }
        await tick();
        assert.equal(f.mensajes.length, 0);
    });
}

test('registra voz, errores y cierre sin copiar texto privado ni errores internos', async t => {
    const f = preparar(t);
    f.sesion.current = { kind: 'tts', text: 'texto privado de /decir' };
    f.servicio.emit('speechStart', f.sesion);
    f.servicio.emit('speechError', f.sesion, Error('token=privado /home/saul/privado'));
    f.servicio.emit('trackError', f.sesion, Error('token=privado /home/saul/privado'));
    f.servicio.emit('sessionStop', f.sesion);
    await tick();
    assert.equal(f.mensajes.length, 4);
    const registros = JSON.stringify(f.mensajes);
    assert.doesNotMatch(registros, /texto privado|token=privado|\/home\/saul/);
    for (const titulo of ['Mensaje de voz iniciado', 'Error de mensaje de voz', 'Error de reproducción', 'Sesión de audio terminada']) {
        assert.ok(f.mensajes.some(m => m.embeds[0].toJSON().title.includes(titulo)));
    }
});

test('una auditoría lenta o rechazada no bloquea el panel ni produce un rechazo sin manejar', async t => {
    let rechazar;
    const f = preparar(t, { logger: { log: () => new Promise((_, reject) => { rechazar = reject; }) } });
    f.servicio.emit('trackStart', f.sesion, f.propietario);
    await f.sesion.panelTask;
    assert.ok(f.sesion.panel);
    rechazar(Error('credencial privada'));
    await tick();
    assert.equal(f.avisos.length, 1);
    assert.doesNotMatch(f.avisos[0], /credencial/);
});
