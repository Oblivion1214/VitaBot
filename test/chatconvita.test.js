const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const discord = require('discord.js');
const { INSTRUCCIONES_SISTEMA_VITA } = require('../config/personalidadVita');

const source = fs.readFileSync(path.join(__dirname, '../commands/chatconvita.js'), 'utf8');
const normalResponse = text => ({ response: {
    candidates: [{ finishReason: 'STOP' }], text: () => text,
} });

function cargarComando(generar = async () => normalResponse('Vamos a resolverlo.'), env = {}) {
    const peticiones = [];
    const avisos = [];
    const timers = [];
    let now = 10_000;
    const sandbox = {
        module: { exports: {} },
        process: { env: { GEMINI_API_KEY: 'clave-ficticia-de-prueba', ...env } },
        console: { warn: (...args) => avisos.push(args.join(' ')) },
        Date: class extends Date { static now() { return now; } },
        setTimeout: callback => { timers.push(callback); return { unref() {} }; },
        require(name) {
            if (name === 'discord.js') return discord;
            if (name === '../config/personalidadVita') return { INSTRUCCIONES_SISTEMA_VITA };
            if (name === '../utils/servicioGemini') return { gemini: require('../utils/servicioGemini').crearServicioGemini({
                env: sandbox.process.env, now: () => now, policy: { run: (_scope, work) => work() },
                registrar: datos => avisos.push(JSON.stringify(datos)),
                clientFactory: () => ({ models: { generateContent: async ({ model, contents, config }) => {
                    const legacyConfig = { ...config, model };
                    const opciones = { timeout: config.httpOptions.timeout };
                    peticiones.push({ config: legacyConfig, mensaje: contents, opciones });
                    const value = await generar(legacyConfig, contents, opciones);
                    return { ...value.response, text: typeof value.response.text === 'function' ? value.response.text() : value.response.text };
                } } }),
            }) };
            throw new Error(`Dependencia inesperada en el chat: ${name}`);
        },
    };
    vm.runInNewContext(source, sandbox, { filename: 'chatconvita.js' });
    return {
        command: sandbox.module.exports, peticiones, avisos,
        avanzar(ms) { now += ms; timers.splice(0).forEach(callback => callback()); },
    };
}

function interaccion(mensaje = 'Explícame una promesa en JavaScript.', guildId = 'servidor-a', userId = 'usuario-a') {
    const respuestas = [];
    return {
        guildId, user: { id: userId }, respuestas,
        options: { getString: () => mensaje },
        async reply(payload) { respuestas.push({ tipo: 'reply', ...payload }); },
        async deferReply(payload) { respuestas.push({ tipo: 'defer', ...payload }); },
        async editReply(payload) { respuestas.push({ tipo: 'edit', ...payload }); },
    };
}

test('responde en el canal y solo envía al proveedor el mensaje actual y la personalidad', async () => {
    const { command, peticiones } = cargarComando(async () => normalResponse('Claro. @everyone'));
    const i = interaccion('Texto privado de prueba');
    await command.execute(i);
    assert.equal(i.respuestas[0].tipo, 'defer');
    assert.equal((i.respuestas[0].flags ?? 0) & discord.MessageFlags.Ephemeral, 0);
    assert.equal(peticiones.length, 1);
    assert.equal(peticiones[0].mensaje, 'Texto privado de prueba');
    assert.equal(peticiones[0].config.systemInstruction, INSTRUCCIONES_SISTEMA_VITA);
    assert.equal(peticiones[0].opciones.timeout, 15_000);
    const salida = i.respuestas.at(-1);
    assert.equal(salida.content, '**Vita:** Claro. @everyone');
    assert.equal(salida.allowedMentions.parse.length, 0);
    assert.ok(!salida.content.includes('Texto privado de prueba'));
});

test('limita la salida completa a 2000 caracteres incluso con una entrada larga y emojis', async () => {
    const { command } = cargarComando(async () => normalResponse('🔨'.repeat(1800)));
    const i = interaccion('x'.repeat(1000));
    await command.execute(i);
    const salida = i.respuestas.at(-1).content;
    assert.ok(salida.length <= 2000);
    assert.ok(salida.isWellFormed());
    assert.ok(salida.includes('por partes'));
});

test('admite mensajes directos sin acceder a interaction.guild', async () => {
    const { command, peticiones } = cargarComando();
    await command.execute(interaccion('Hola', null));
    assert.equal(peticiones.length, 1);
});

test('rechaza entradas vacías o excesivas sin consumir peticiones', async () => {
    const { command, peticiones } = cargarComando();
    for (const entrada of ['   ', 'x'.repeat(1001)]) {
        const i = interaccion(entrada);
        await command.execute(i);
        assert.equal(i.respuestas[0].tipo, 'reply');
        assert.equal(i.respuestas[0].flags, discord.MessageFlags.Ephemeral);
    }
    assert.equal(peticiones.length, 0);
});

test('configuración ausente o IDs inválidos devuelven un error genérico privado', async () => {
    for (const env of [{ GEMINI_API_KEY: '' }, { GEMINI_CHAT_MODELS: 'Gemini 2.5 Flash-Lite' }]) {
        const { command, peticiones } = cargarComando(undefined, env);
        const i = interaccion();
        await command.execute(i);
        assert.equal(peticiones.length, 0);
        assert.equal(i.respuestas[0].flags, discord.MessageFlags.Ephemeral);
        assert.ok(!i.respuestas[0].content.includes('GEMINI'));
    }
});

test('usa el respaldo ante un modelo no disponible y respeta los IDs configurados', async () => {
    const { command, peticiones } = cargarComando(async config => {
        if (config.model === 'gemini-prueba-a') throw Object.assign(new Error('dato privado'), { status: 404 });
        return normalResponse('Listo.');
    }, { GEMINI_CHAT_MODELS: 'gemini-prueba-a,gemini-prueba-a,gemini-prueba-b' });
    const i = interaccion();
    await command.execute(i);
    assert.deepEqual(peticiones.map(p => p.config.model), ['gemini-prueba-a', 'gemini-prueba-b']);
    assert.equal(i.respuestas.at(-1).content, '**Vita:** Listo.');
});

test('no reintenta errores de credenciales ni registra detalles privados del proveedor', async () => {
    const { command, peticiones, avisos } = cargarComando(async () => {
        throw Object.assign(new Error('token=secreto; mensaje=privado'), { status: 403 });
    });
    const i = interaccion();
    await command.execute(i);
    assert.equal(peticiones.length, 1);
    assert.ok(!JSON.stringify([avisos, i.respuestas]).includes('secreto'));
    assert.ok(!JSON.stringify([avisos, i.respuestas]).includes('mensaje=privado'));
});

test('permite usar un cuarto modelo de respaldo ante fallos transitorios', async () => {
    const { command, peticiones } = cargarComando(async () => {
        throw Object.assign(new Error('servicio ocupado'), { status: 503 });
    }, { GEMINI_CHAT_MODELS: 'gemini-a,gemini-b,gemini-c,gemini-d' });
    const i = interaccion();
    await command.execute(i);
    assert.equal(peticiones.length, 4);
    assert.ok(i.respuestas.at(-1).content.includes('inténtalo'));
});

test('un bloqueo de seguridad no se intenta eludir cambiando de modelo', async () => {
    for (const response of [
        { promptFeedback: { blockReason: 'SAFETY' } },
        { candidates: [{ finishReason: 'SAFETY' }] },
    ]) {
        const { command, peticiones } = cargarComando(async () => ({ response }));
        const i = interaccion();
        await command.execute(i);
        assert.equal(peticiones.length, 1);
        assert.ok(i.respuestas.at(-1).content.includes('alternativa segura'));
    }
});

test('bloquea peticiones simultáneas del mismo servidor aun después del cooldown', async () => {
    let resolver;
    const { command, peticiones, avanzar } = cargarComando(() => new Promise(resolve => { resolver = resolve; }));
    const primera = command.execute(interaccion());
    await new Promise(setImmediate);
    avanzar(6000);
    const segunda = interaccion('Otra pregunta', 'servidor-a', 'usuario-b');
    await command.execute(segunda);
    assert.equal(peticiones.length, 1);
    assert.equal(segunda.respuestas[0].tipo, 'reply');
    resolver(normalResponse('Listo.'));
    await primera;
    const tercera = command.execute(interaccion('Continuar', 'servidor-a'));
    await new Promise(setImmediate);
    assert.equal(peticiones.length, 2);
    resolver(normalResponse('Seguimos.'));
    await tercera;
});

test('aísla las solicitudes de distintos servidores y usuarios en DM sin compartir historial', async () => {
    const { command, peticiones } = cargarComando();
    await command.execute(interaccion('Mensaje A', 'servidor-a'));
    await command.execute(interaccion('Mensaje B', 'servidor-b'));
    await command.execute(interaccion('Mensaje C', null, 'usuario-c'));
    await command.execute(interaccion('Mensaje D', null, 'usuario-d'));
    assert.deepEqual(peticiones.map(p => p.mensaje), ['Mensaje A', 'Mensaje B', 'Mensaje C', 'Mensaje D']);
});

test('el cooldown sigue activo tras una respuesta rápida y expira sin retener la entrada', async () => {
    const { command, peticiones, avanzar } = cargarComando();
    await command.execute(interaccion());
    await command.execute(interaccion());
    assert.equal(peticiones.length, 1);
    avanzar(5001);
    await command.execute(interaccion());
    assert.equal(peticiones.length, 2);
});

test('serializa el comando con los límites de entrada para Discord', () => {
    const { command } = cargarComando();
    const data = command.data.toJSON();
    assert.equal(data.name, 'chatconvita');
    assert.equal(data.options[0].max_length, 1000);
    assert.equal(data.options[0].min_length, 1);
});
