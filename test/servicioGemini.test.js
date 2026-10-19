const test = require('node:test');
const assert = require('node:assert/strict');
const { crearServicioGemini } = require('../utils/servicioGemini');
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
