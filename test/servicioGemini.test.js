const test = require('node:test');
const assert = require('node:assert/strict');
const { crearServicioGemini, obtenerModelos } = require('../utils/servicioGemini');
test('SDK nuevo usa configuración compartida sin herramientas, reintentos o continuaciones implícitas', async () => {
    const calls = []; let clientOptions;
    const service = crearServicioGemini({ env: { GEMINI_API_KEY: 'fake' }, clientFactory: options => {
        clientOptions = options; return { models: { generateContent: async call => { calls.push(call); return { text: 'Listo', candidates: [{ finishReason: 'STOP' }] }; } } };
    } });
    assert.equal((await service.generate({ scope: 'guild', contents: 'private' })).text, 'Listo');
    assert.equal(clientOptions.vertexai, false);
    assert.equal(calls[0].config.httpOptions.retryOptions.attempts, 1);
    assert.equal(calls[0].config.automaticContinuation, false);
    assert.equal(calls[0].config.tools, undefined);
    assert.equal(calls[0].contents, 'private');
});
test('un 429 detiene intentos y aplica enfriamiento común al chat y análisis', async () => {
    let calls = 0, now = 100;
    const service = crearServicioGemini({ env: { GEMINI_API_KEY: 'fake' }, now: () => now,
        clientFactory: () => ({ models: { generateContent: async () => { calls++; throw { status: 429 }; } } }) });
    await service.generate({ scope: 'a', contents: 'x' });
    await service.generate({ scope: 'b', kind: 'analysis', contents: 'x' }); assert.equal(calls, 1);
    now += 30_001; await service.generate({ scope: 'b', contents: 'x' }); assert.equal(calls, 2);
});
test('el presupuesto total impide intentar modelos después de agotar tiempo', async () => {
    let now = 0, calls = 0;
    const service = crearServicioGemini({ env: { GEMINI_API_KEY: 'fake' }, now: () => now, totalMs: 20,
        clientFactory: () => ({ models: { generateContent: async () => { calls++; now += 25; throw { status: 503 }; } } }) });
    assert.equal((await service.generate({ scope: 'a', contents: 'x' })).status, 'unavailable'); assert.equal(calls, 1);
});

function preparar(generar, opciones = {}) {
    const llamadas = [], registros = [];
    const servicio = crearServicioGemini({ env: { GEMINI_API_KEY: 'clave-ficticia', GEMINI_CHAT_MODELS: 'gemini-a,gemini-b', ...opciones.env },
        registrar: datos => registros.push(datos),
        clientFactory: () => ({ models: { generateContent: async solicitud => { llamadas.push(solicitud.model); return generar(solicitud); } } }),
        ...Object.fromEntries(Object.entries(opciones).filter(([clave]) => clave !== 'env')),
    });
    return { servicio, llamadas, registros };
}
function errorCuota(modelo, extra = {}) {
    return Object.assign(new Error(JSON.stringify({ error: {
        message: 'clave-ficticia; mensaje privado; proyecto secreto',
        details: [{ '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
            { quotaDimensions: { model: modelo }, quotaId: 'GenerateRequestsPerMinutePerProjectPerModel' },
        ] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '62s' }],
        ...extra,
    } })), { status: 429 });
}

test('ofrece cinco modelos y acepta hasta ocho IDs válidos sin duplicados, incluidos modelos antiguos configurados', () => {
    assert.equal(obtenerModelos({}, 'chat').length, 5);
    const lista = 'gemini-2.5-flash,gemini-2.5-flash,NO VALIDO,' + Array.from({ length: 10 }, (_, i) => `gemini-${i}`).join(',');
    const modelos = obtenerModelos({ GEMINI_CHAT_MODELS: lista }, 'chat');
    assert.equal(modelos.length, 8);
    assert.equal(modelos[0], 'gemini-2.5-flash');
    assert.equal(new Set(modelos).size, 8);
    assert.deepEqual(obtenerModelos({ GEMINI_CHAT_MODELS: lista, GEMINI_ANALYSIS_MODELS: 'gemini-analisis' }, 'analysis'), ['gemini-analisis']);
});

test('un modelo con cuota agotada permite otro modelo y respeta RetryInfo en chat y análisis', async () => {
    let ahora = 100, cuota = true;
    const f = preparar(async ({ model }) => {
        if (model === 'gemini-a' && cuota) throw errorCuota('gemini-a');
        return { text: 'Listo' };
    }, { now: () => ahora });
    assert.equal((await f.servicio.generate({ scope: 'a', contents: 'mensaje privado' })).text, 'Listo');
    ahora += 60_000; cuota = false;
    await f.servicio.generate({ scope: 'b', kind: 'analysis', contents: 'x' });
    assert.deepEqual(f.llamadas, ['gemini-a', 'gemini-b', 'gemini-b']);
    ahora += 2001;
    await f.servicio.generate({ scope: 'c', contents: 'x' });
    assert.equal(f.llamadas.at(-1), 'gemini-a');
    assert.doesNotMatch(JSON.stringify(f.registros), /clave-ficticia|mensaje privado|proyecto secreto/);
    assert.ok(f.registros.some(r => r.motivo === 'cuota_modelo'));
    assert.ok(f.registros.some(r => r.motivo === 'respaldo_activado'));
});

test('una cuota global mezclada con otra de modelo detiene los respaldos y respeta la espera indicada', async () => {
    let ahora = 100;
    const f = preparar(async () => { throw errorCuota('gemini-a', { details: [
        { '@type': 'type.googleapis.com/google.rpc.QuotaFailure', violations: [
            { quotaDimensions: { model: 'gemini-a' } }, { quotaDimensions: {} },
        ] }, { '@type': 'type.googleapis.com/google.rpc.RetryInfo', retryDelay: '120s' },
    ] }); }, { now: () => ahora });
    await f.servicio.generate({ scope: 'a', contents: 'x' });
    ahora += 60_000;
    await f.servicio.generate({ scope: 'b', contents: 'x' });
    assert.equal(f.llamadas.length, 1);
    ahora += 60_001;
    await f.servicio.generate({ scope: 'c', contents: 'x' });
    assert.equal(f.llamadas.length, 2);
});

test('un 404 se recuerda durante una hora y no bloquea al respaldo', async () => {
    let ahora = 100;
    const f = preparar(async ({ model }) => {
        if (model === 'gemini-a') throw { status: 404 };
        return { text: 'Listo' };
    }, { now: () => ahora });
    await f.servicio.generate({ scope: 'a', contents: 'x' });
    await f.servicio.generate({ scope: 'b', contents: 'x' });
    assert.deepEqual(f.llamadas, ['gemini-a', 'gemini-b', 'gemini-b']);
    ahora += 3_600_001;
    await f.servicio.generate({ scope: 'c', contents: 'x' });
    assert.deepEqual(f.llamadas.slice(-2), ['gemini-a', 'gemini-b']);
});

test('fallos de red, tiempo agotado y respuesta vacía prueban el siguiente modelo', async () => {
    for (const fallo of [new DOMException('dato privado', 'TimeoutError'),
        new TypeError('fetch failed', { cause: { code: 'ECONNRESET' } }), null]) {
        const f = preparar(async ({ model }) => {
            if (model === 'gemini-a') { if (fallo) throw fallo; return { text: '' }; }
            return { text: 'Listo' };
        });
        assert.equal((await f.servicio.generate({ scope: 'a', contents: 'x' })).text, 'Listo');
        assert.deepEqual(f.llamadas, ['gemini-a', 'gemini-b']);
        assert.doesNotMatch(JSON.stringify(f.registros), /dato privado|fetch failed/);
    }
});

test('los diagnósticos se limitan a uno por motivo y minuto y un logger roto no afecta al respaldo', async () => {
    const f = preparar(async ({ model }) => {
        if (model === 'gemini-a') throw { status: 503, message: 'secreto' };
        return { text: 'Listo' };
    });
    for (let i = 0; i < 3; i++) await f.servicio.generate({ scope: String(i), contents: 'x' });
    assert.equal(f.registros.filter(r => r.motivo === 'respaldo_activado').length, 1);
    const roto = preparar(async ({ model }) => {
        if (model === 'gemini-a') throw { status: 503 };
        return { text: 'Listo' };
    }, { registrar() { throw Error('fallo'); } });
    assert.equal((await roto.servicio.generate({ scope: 'a', contents: 'x' })).text, 'Listo');
    assert.equal(roto.llamadas.length, 2);
});

test('un límite local genera un diagnóstico genérico sin llamar al proveedor', async () => {
    const { ErrorServicioOcupado } = require('../utils/politicaSolicitudes');
    const f = preparar(async () => ({ text: 'Listo' }), { policy: { run: async () => { throw new ErrorServicioOcupado(); } } });
    assert.equal((await f.servicio.generate({ scope: 'servidor-privado', contents: 'secreto' })).status, 'unavailable');
    assert.equal(f.llamadas.length, 0);
    assert.equal(f.registros[0].motivo, 'limite_local');
    assert.doesNotMatch(JSON.stringify(f.registros), /servidor-privado|secreto/);
});

test('las reglas de diversión del chat no desactivan el análisis técnico de enlaces', async () => {
    const instrucciones = [];
    const servicio = crearServicioGemini({ env: { GEMINI_API_KEY: 'fake' },
        clientFactory: () => ({ models: { generateContent: async solicitud => {
            instrucciones.push(solicitud.config.systemInstruction);
            return { text: 'Listo' };
        } } }),
    });
    await servicio.generate({ scope: 'chat', contents: 'Hola' });
    await servicio.generate({ scope: 'analisis', kind: 'analysis', contents: 'Resultados técnicos de prueba' });
    assert.match(instrucciones[0], /CHARLA Y DIVERSIÓN/);
    assert.doesNotMatch(instrucciones[1], /CHARLA Y DIVERSIÓN|LÍMITES DEL CHAT/);
    assert.match(instrucciones[1], /Para analizar enlaces/);
    assert.match(instrucciones[1], /PRIVACIDAD Y CONFIDENCIALIDAD/);
});
