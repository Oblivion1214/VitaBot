const test = require('node:test');
const assert = require('node:assert/strict');
const { crearServicioImagenes, consultarConLimite } = require('../utils/servicioImagenes');
test('omite traducción fallida, limita reintentos y entrega imagen con cancelación', async () => {
    const calls = [];
    const service = crearServicioImagenes({ env: { HF_TOKEN: 'fake' }, translateImpl: async () => { throw Error('offline'); },
        factory: () => ({ textToImage: async (input, options) => { calls.push({ input, options }); return new Blob(['pixels'], { type: 'image/png' }); } }) });
    const result = await service.generate('paisaje', 'a');
    assert.equal(result.blob.type, 'image/png'); assert.equal(calls[0].input.inputs, 'paisaje');
    assert.equal(calls[0].options.retry_on_error, false); assert.ok(calls[0].options.signal instanceof AbortSignal);
});
test('rechaza imágenes grandes y tipos inesperados sin pasar de dos intentos', async () => {
    let calls = 0;
    const service = crearServicioImagenes({ env: { HF_TOKEN: 'fake' }, translateImpl: async () => ({ text: 'x' }),
        factory: () => ({ textToImage: async () => { calls++; return new Blob(['<svg/>'], { type: 'image/svg+xml' }); } }) });
    await assert.rejects(service.generate('x', 'a')); assert.equal(calls, 2);
});
test('corta cuerpos excesivos aunque no haya Content-Length', async () => {
    const result = await consultarConLimite('https://provider.example/', {}, async () => new Response(new Uint8Array(20)), 10);
    await assert.rejects(result.arrayBuffer(), /demasiado grande/);
    await assert.rejects(consultarConLimite('https://provider.example/', {}, async () => new Response('abc', { headers: { 'content-length': '20' } }), 10), /demasiado grande/);
});
