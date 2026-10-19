const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { spawnSync } = require('node:child_process');
const { instalarManejoErrores } = require('../utils/manejoErrores');
const marca = 'SECRETO_SINTETICO_NO_REAL_12345';
const turno = () => new Promise(resolve => setImmediate(resolve));
function entorno({ escribir } = {}) {
    const proceso = new EventEmitter(), salidas = [], registros = [], temporizadores = [];
    proceso.exit = codigo => salidas.push(codigo);
    const control = instalarManejoErrores({ proceso, escribir: escribir || (texto => registros.push(texto)),
        programar(fn, ms) { const timer = { fn, ms }; temporizadores.push(timer); return timer; },
        cancelar(timer) { timer.cancelado = true; },
    });
    return { proceso, salidas, registros, temporizadores, control };
}
test('fatales terminan con código 1 sin inspeccionar errores, credenciales ni getters hostiles', () => {
    let accesos = 0;
    const hostil = new Proxy({}, { get() { accesos++; throw Error(marca); }, getOwnPropertyDescriptor() { accesos++; throw Error(marca); } });
    for (const evento of ['uncaughtException', 'unhandledRejection']) for (const error of [null, 7, Symbol(marca), marca, new Error(marca), { request: { headers: { Authorization: marca } } }, hostil]) {
        const f = entorno(); let cierres = 0; f.control.registrarLimpieza(() => cierres++);
        f.proceso.emit(evento, error);
        assert.deepEqual(f.salidas, [1]); assert.equal(f.proceso.exitCode, 1); assert.equal(cierres, 1);
        assert.equal(f.registros.length, 1); assert.equal(f.registros.join('').includes(marca), false);
        assert.equal(f.temporizadores.length, 0);
    }
    assert.equal(accesos, 0);
});
test('señales repetidas cierran una sola vez y esperan Discord hasta completar', async () => {
    const f = entorno(), orden = []; let completar;
    f.control.registrarLimpieza(() => { orden.push('discord'); return new Promise(resolve => { completar = resolve; }); });
    f.control.registrarLimpieza(() => orden.push('musica'));
    f.control.registrarLimpieza(() => orden.push('mantenimiento'));
    assert.equal(f.temporizadores.length, 0);
    f.proceso.emit('SIGTERM'); f.proceso.emit('SIGTERM'); f.proceso.emit('SIGINT');
    assert.deepEqual(orden, ['mantenimiento', 'musica', 'discord']); assert.deepEqual(f.salidas, []);
    completar(); await turno();
    assert.deepEqual(f.salidas, [0]); assert.equal(f.temporizadores[0].cancelado, true);
    assert.equal(f.control.estaCerrando(), true); assert.deepEqual(f.registros, []);
});
test('una limpieza que lanza o rechaza no impide intentar las otras y sale con error', async () => {
    const f = entorno(), orden = [];
    f.control.registrarLimpieza(() => { orden.push('discord'); return Promise.reject({ token: marca }); });
    f.control.registrarLimpieza(() => { orden.push('musica'); throw Error(marca); });
    f.control.registrarLimpieza(() => orden.push('mantenimiento'));
    f.proceso.emit('SIGINT'); await turno();
    assert.deepEqual(orden, ['mantenimiento', 'musica', 'discord']); assert.deepEqual(f.salidas, [1]);
    assert.equal(f.registros.join('').includes(marca), false); assert.match(f.registros.join(''), /tarea de cierre/);
});
test('el único plazo de cierre termina una promesa bloqueada y no permite salida posterior con cero', async () => {
    const f = entorno(); let completar;
    f.control.registrarLimpieza(() => new Promise(resolve => { completar = resolve; }));
    f.proceso.emit('SIGTERM'); assert.equal(f.temporizadores.length, 1); assert.equal(f.temporizadores[0].ms, 3000);
    f.temporizadores[0].fn(); completar(); await turno();
    assert.deepEqual(f.salidas, [1]); assert.match(f.registros.join(''), /plazo de cierre/);
});
test('un fatal durante el cierre escala a código 1 sin repetir tareas ni esperar promesas', async () => {
    const f = entorno(); let completar, cierres = 0;
    f.control.registrarLimpieza(() => { cierres++; return new Promise(resolve => { completar = resolve; }); });
    f.proceso.emit('SIGINT'); f.proceso.emit('uncaughtException', new Error(marca));
    assert.deepEqual(f.salidas, [1]); assert.equal(cierres, 1); assert.equal(f.temporizadores[0].cancelado, true);
    completar(); await turno(); assert.deepEqual(f.salidas, [1]);
});
test('un fallo de escritura del log no impide terminar tras el fatal', () => {
    const f = entorno({ escribir() { throw Error(marca); } });
    f.proceso.emit('unhandledRejection', new Error(marca)); assert.deepEqual(f.salidas, [1]);
});
test('los contextos desconocidos no se convierten a texto ni interpolan datos', () => {
    const f = entorno();
    const hostil = { toString() { throw Error(marca); } };
    for (const contexto of [marca, hostil, Symbol(marca), '__proto__']) f.control.registrarError(contexto);
    assert.equal(f.registros.every(texto => texto === '[VitaBot] Ocurrió un error interno.\n'), true);
    assert.deepEqual(f.salidas, []);
});
test('Node real sale con error para excepciones y rechazos, también en modo strict, sin imprimir el secreto', () => {
    const modulo = JSON.stringify(require.resolve('../utils/manejoErrores'));
    for (const [opciones, accion] of [[[], `throw new Error('${marca}')`], [[], `Promise.reject({ token: '${marca}' })`],
        [['--unhandled-rejections=strict'], `Promise.reject('${marca}')`]]) {
        // Reproduce los listeners que PM2 instala antes de cargar index.js.
        const previos = `process.on('uncaughtException', error => console.error('${marca}', error)); process.on('unhandledRejection', error => console.error('${marca}', error));`;
        const resultado = spawnSync(process.execPath, [...opciones, '-e', `${previos} require(${modulo}).instalarManejoErrores(); ${accion};`],
            { encoding: 'utf8', timeout: 5000, windowsHide: true });
        assert.equal(resultado.status, 1); assert.equal(resultado.stdout, ''); assert.match(resultado.stderr, /\[VitaBot\]/);
        assert.equal(resultado.stderr.includes(marca), false); assert.equal(resultado.stderr.includes(' at '), false);
    }
});
