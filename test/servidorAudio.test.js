const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { crearServidorAudio } = require('../audio/servidor');
const { interpretarConsulta } = require('../audio/protocolo');
const { ClienteAudio } = require('../utils/clienteAudio');
const { ejecutarJson, transmitirOpus } = require('../audio/procesos');
const token = 'x'.repeat(64);
const tools = { ytDlp: 'fake-extractor', ffmpeg: 'fake-encoder', node: process.execPath };
const video = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
async function fixture(t, options = {}) {
    const server = crearServidorAudio({ token, tools, resolveJson: async () => ({ id: 'jNQXAC9IVRw', title: 'Clip', duration: 19 }), ...options });
    await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
    t.after(() => { server.closeJobs(); server.closeAllConnections(); server.close(); });
    const baseUrl = `http://127.0.0.1:${server.address().port}`;
    const client = new ClienteAudio({ baseUrl, token });
    const post = (route, body) => fetch(`${baseUrl}${route}`, { method: 'POST', headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' }, body: JSON.stringify(body) });
    return { server, baseUrl, client, post };
}
test('solo admite URLs canónicas y rechaza destinos privados, protocolos y hosts falsos', () => {
    for (const url of ['http://127.0.0.1/secret', 'file:///private', 'https://youtube.com.evil.test/watch?v=jNQXAC9IVRw', 'https://evil@youtube.com/watch?v=jNQXAC9IVRw', 'https://youtube.com:8080/watch?v=jNQXAC9IVRw']) assert.throws(() => interpretarConsulta(url));
    assert.equal(interpretarConsulta('https://youtu.be/jNQXAC9IVRw?t=2').value, video);
    assert.equal(interpretarConsulta('Mi canción; $(algo)').value, 'ytsearch5:Mi canción; $(algo)');
});
test('health y streaming requieren autenticación, sin revelar configuración', async t => {
    const f = await fixture(t);
    for (const route of ['/health', `/v1/stream?url=${encodeURIComponent(video)}`]) {
        const response = await fetch(f.baseUrl + route); assert.equal(response.status, 401); await response.text();
    }
    assert.deepEqual(await f.client.health(), { status: 'ok', apiVersion: 2, activeStreams: 0, resolving: 0 });
});
test('búsqueda normalizada y límites enviados a yt-dlp sin shell ni datos de Discord', async t => {
    let args;
    const f = await fixture(t, { resolveJson: async (_, value) => { args = value; return { entries: [{ id: 'jNQXAC9IVRw', title: 'Clip' }, { url: 'http://127.0.0.1' }] }; } });
    const result = await f.client.resolve('algo');
    assert.equal(result.selection, true); assert.equal(result.tracks.length, 1); assert.equal(result.tracks[0].url, video);
    assert.ok(args.includes('--no-cookies')); assert.ok(args.includes('--ignore-config')); assert.ok(args.includes('--playlist-end'));
    assert.equal(args.at(-1), 'ytsearch5:algo');
});
test('rechaza JSON inválido, cuerpos grandes y enlaces internos antes de extraer', async t => {
    let calls = 0; const f = await fixture(t, { resolveJson: async () => { calls++; } });
    const bad = await fetch(f.baseUrl + '/v1/resolve', { method: 'POST', headers: { Authorization: `Bearer ${token}` }, body: '{broken' });
    assert.equal(bad.status, 400); await bad.text();
    for (const [query, expected] of [['http://127.0.0.1', 400], ['a'.repeat(9000), 413]]) {
        const response = await f.post('/v1/resolve', { query }); assert.equal(response.status, expected); await response.text();
    }
    assert.equal(calls, 0);
});
test('limita búsquedas simultáneas y libera el cupo al cancelar la solicitud', async t => {
    const f = await fixture(t, { maxResolvers: 1, resolveJson: (_, __, { signal }) => new Promise((resolve, reject) => signal.addEventListener('abort', () => reject(Error('aborted')), { once: true })) });
    const abort = new AbortController();
    const pending = f.client.resolve('test', abort.signal).catch(error => error);
    while ((await f.client.health()).resolving !== 1) await new Promise(resolve => setTimeout(resolve, 5));
    const second = await f.post('/v1/resolve', { query: 'second' }); assert.equal(second.status, 429); await second.text();
    abort.abort(); await pending;
    for (let i = 0; i < 30 && (await f.client.health()).resolving; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await f.client.health()).resolving, 0);
});
test('limita streams y libera procesos al cerrar el consumidor', async t => {
    let closed = 0;
    const f = await fixture(t, { maxStreams: 1, startStream: ({ response, signal, onDone }) => {
        response.writeHead(200, { 'Content-Type': 'audio/ogg' }); response.write(Buffer.from('OggS'));
        const cancel = () => { closed++; onDone(); }; signal.addEventListener('abort', cancel, { once: true }); return cancel;
    } });
    const stream = await f.client.open({ url: video }, 64);
    assert.equal((await f.client.health()).activeStreams, 1);
    await assert.rejects(f.client.open({ url: video }, 64), /ocupada/);
    stream.stream.on('error', () => {}); stream.close();
    for (let i = 0; i < 30 && (await f.client.health()).activeStreams; i++) await new Promise(resolve => setTimeout(resolve, 5));
    assert.equal((await f.client.health()).activeStreams, 0); assert.equal(closed, 1);
});
test('cliente rechaza redirecciones, JSON enorme y respuesta que no sea Opus', async () => {
    const client = new ClienteAudio({ baseUrl: 'http://pc:3001', token, fetchImpl: async (_, options) => {
        assert.equal(options.redirect, 'error'); assert.equal(options.headers.Authorization, `Bearer ${token}`);
        return new Response('x'.repeat(600000), { headers: { 'Content-Type': 'text/plain' } });
    } });
    await assert.rejects(client.health(), /demasiado grande/);
    await assert.rejects(client.open({ url: video }, 64), /Opus/);
});
test('cancelar la extracción mata al proceso sin filtrar stderr', async () => {
    const abort = new AbortController(); let killed = false;
    const proc = new EventEmitter(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough(); proc.kill = () => { killed = true; };
    const pending = ejecutarJson('fake', [], { signal: abort.signal, spawnImpl: () => proc }); abort.abort();
    await assert.rejects(pending, /cancelada/); assert.equal(killed, true);
});
test('fallo al iniciar FFmpeg devuelve 502 y libera el trabajo', async () => {
    const response = new PassThrough(); response.writeHead = status => { response.status = status; response.headersSent = true; };
    let done = 0;
    transmitirOpus({ response, tools, inputArgs: [], bitrate: 64, onDone: () => done++, spawnImpl: () => { throw Error('spawn failed'); } });
    assert.equal(response.status, 502); assert.equal(done, 1);
});
test('datos tardíos de FFmpeg después de cancelar no reabren ni escriben la respuesta', () => {
    const abort = new AbortController(), response = new PassThrough(), processes = [];
    let headers = 0, done = 0;
    response.writeHead = () => { headers++; };
    const spawnImpl = () => {
        const proc = new EventEmitter(); proc.stdin = new PassThrough(); proc.stdout = new PassThrough(); proc.stderr = new PassThrough();
        proc.killed = false; proc.kill = () => { proc.killed = true; }; processes.push(proc); return proc;
    };
    transmitirOpus({ response, tools, inputArgs: [], bitrate: 64, signal: abort.signal, onDone: () => done++, spawnImpl });
    abort.abort(); processes[0].stdout.write(Buffer.from('late')); processes[0].stdout.end();
    assert.equal(headers, 0); assert.equal(done, 1); assert.ok(processes.every(proc => proc.killed));
});
test('TTS no acepta texto largo ni idiomas arbitrarios y no abre procesos', async t => {
    const f = await fixture(t, { startStream: () => { throw Error('should not run'); } });
    for (const body of [{ text: 'x'.repeat(201) }, { text: 'Hola', lang: 'file:///private' }]) {
        const response = await f.post('/v1/tts', body); assert.equal(response.status, 400); await response.text();
    }
    assert.equal((await f.client.health()).activeStreams, 0);
});
