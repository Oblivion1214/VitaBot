const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { timingSafeEqual } = require('node:crypto');
const { Readable, Transform } = require('node:stream');
const { obtenerHerramientasAudio, argumentosYtDlp } = require('../utils/herramientasAudio');
const { ErrorAudio, interpretarConsulta, obtenerUrlVideo, normalizarCancion } = require('./protocolo');
const { ejecutarJson, transmitirOpus } = require('./procesos');

async function leerCuerpo(request) {
    let size = 0;
    const chunks = [];
    for await (const chunk of request) {
        size += chunk.length;
        if (size > 8192) throw new ErrorAudio('Solicitud demasiado grande.', 413);
        chunks.push(chunk);
    }
    try { return JSON.parse(Buffer.concat(chunks).toString('utf8')); } catch { throw new ErrorAudio('JSON inválido.', 400); }
}
function autorizar(request, token) {
    const provided = Buffer.from(request.headers.authorization || '');
    const expected = Buffer.from(`Bearer ${token}`);
    return provided.length === expected.length && timingSafeEqual(provided, expected);
}
function sendJson(response, status, value) {
    if (response.destroyed || response.writableEnded) return;
    response.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    response.end(JSON.stringify(value));
}
async function spotifyQuery(url, fetchImpl, signal) {
    const response = await fetchImpl(url, { signal, redirect: 'error', headers: { 'User-Agent': 'Mozilla/5.0' } });
    if (!response.ok) throw new ErrorAudio('Spotify no permitió leer esta canción.');
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > 1024 * 1024) throw new ErrorAudio('Respuesta de Spotify demasiado grande.');
        chunks.push(Buffer.from(chunk));
    }
    const html = Buffer.concat(chunks).toString('utf8');
    const decode = text => text.replace(/&amp;/g, '&').replace(/&quot;/g, '"').replace(/&#39;/g, "'");
    const title = html.match(/<meta\s+property="og:title"\s+content="([^"]+)"/i)?.[1];
    const description = html.match(/<meta\s+property="og:description"\s+content="([^"]+)"/i)?.[1] || '';
    if (!title) throw new ErrorAudio('No se encontró el título de Spotify.');
    return `ytsearch1:${decode(title)} ${decode(description.split('·')[1] || '')} audio`;
}

function crearServidorAudio({ token, tools, cookiesPath, maxStreams = 3, maxResolvers = 2,
    fetchImpl = fetch, resolveJson = ejecutarJson, startStream = transmitirOpus } = {}) {
    if (typeof token !== 'string' || token.length < 32) throw new Error('Configura AUDIO_SHARED_TOKEN con al menos 32 caracteres.');
    const jobs = new Set();
    let resolving = 0;
    const common = () => ['--ignore-config', ...argumentosYtDlp(tools), '--no-warnings', '--socket-timeout', '10', '--retries', '1',
        ...(cookiesPath && fs.existsSync(cookiesPath) ? ['--cookies', cookiesPath] : ['--no-cookies'])];
    const server = http.createServer(async (request, response) => {
        if (!autorizar(request, token)) return sendJson(response, 401, { error: 'Acceso no autorizado.' });
        const controller = new AbortController();
        response.once('close', () => controller.abort());
        try {
            const url = new URL(request.url, 'http://servidor');
            if (request.method === 'GET' && url.pathname === '/health') {
                return sendJson(response, 200, { status: 'ok', apiVersion: 2, activeStreams: jobs.size, resolving });
            }
            if (request.method === 'POST' && url.pathname === '/v1/resolve') {
                if (resolving >= maxResolvers) throw new ErrorAudio('La PC está resolviendo otras búsquedas. Intenta de nuevo.', 429);
                resolving++;
                const timer = setTimeout(() => controller.abort(), 30_000);
                try {
                    const query = interpretarConsulta((await leerCuerpo(request)).query);
                    const target = query.type === 'spotify' ? await spotifyQuery(query.value, fetchImpl, controller.signal) : query.value;
                    const result = await resolveJson(tools.ytDlp, [...common(), '--dump-single-json', '--flat-playlist', '--playlist-end', '100', target], { signal: controller.signal });
                    const entries = result.entries || [result];
                    const tracks = entries.filter(Boolean).slice(0, 100).flatMap(entry => {
                        try { return [normalizarCancion(entry)]; } catch { return []; }
                    });
                    return sendJson(response, 200, { tracks, selection: query.type === 'search', playlist: query.type === 'playlist' });
                } finally { clearTimeout(timer); resolving--; }
            }
            if (!((request.method === 'GET' && url.pathname === '/v1/stream') || (request.method === 'POST' && url.pathname === '/v1/tts'))) {
                return sendJson(response, 404, { error: 'Ruta no disponible.' });
            }
            if (jobs.size >= maxStreams) throw new ErrorAudio('La PC alcanzó el límite de audio simultáneo.', 429);
            const job = { cancel: () => controller.abort() };
            jobs.add(job);
            let transferred = false;
            try {
                const bitrate = Math.max(32, Math.min(128, Number(url.searchParams.get('bitrate')) || 128));
                let inputArgs, inputStream;
                if (url.pathname === '/v1/stream') {
                    const target = obtenerUrlVideo(url.searchParams.get('url'));
                    inputArgs = [...common(), '--no-playlist', '--format', 'bestaudio', '-o', '-', target];
                } else {
                    const { text, lang = 'es' } = await leerCuerpo(request);
                    if (typeof text !== 'string' || !text.trim() || text.length > 200 || !['es', 'en'].includes(lang)) throw new ErrorAudio('Mensaje de voz inválido.', 400);
                    const tts = new URL('https://translate.google.com/translate_tts');
                    tts.search = new URLSearchParams({ ie: 'UTF-8', q: text, tl: lang, total: '1', idx: '0', textlen: String(text.length), client: 'tw-ob', prev: 'input', ttsspeed: '1' }).toString();
                    const timer = setTimeout(() => controller.abort(), 15_000);
                    let audio;
                    try { audio = await fetchImpl(tts, { signal: controller.signal, redirect: 'error', headers: { 'User-Agent': 'Mozilla/5.0' } }); }
                    finally { clearTimeout(timer); }
                    if (!audio.ok || !audio.body) throw new ErrorAudio('El servicio de voz no está disponible.');
                    let size = 0;
                    const upstream = Readable.fromWeb(audio.body, { highWaterMark: 64 * 1024 });
                    inputStream = new Transform({ transform(chunk, encoding, done) {
                        size += chunk.length;
                        done(size > 2 * 1024 * 1024 ? new ErrorAudio('Respuesta de voz demasiado grande.') : null, chunk);
                    } });
                    upstream.on('error', error => inputStream.destroy(error));
                    inputStream.once('close', () => upstream.destroy());
                    upstream.pipe(inputStream);
                }
                job.cancel = startStream({ response, tools, inputArgs, inputStream, bitrate, signal: controller.signal, onDone: () => jobs.delete(job) });
                transferred = true;
            } finally { if (!transferred) jobs.delete(job); }
        } catch (error) {
            if (!response.headersSent) sendJson(response, error instanceof ErrorAudio ? error.status : 502,
                { error: error instanceof ErrorAudio ? error.message : 'El servidor de audio no pudo completar la solicitud.' });
            else response.destroy();
        }
    });
    server.requestTimeout = 15_000;
    server.headersTimeout = 10_000;
    server.on('clientError', (_, socket) => socket.destroy());
    server.closeJobs = () => { for (const job of jobs) job.cancel(); };
    return server;
}

function iniciarServidorAudio() {
    const envFile = process.env.AUDIO_ENV_FILE || path.resolve(__dirname, '../.env.audio');
    if (fs.existsSync(envFile)) process.loadEnvFile(envFile);
    const server = crearServidorAudio({ token: process.env.AUDIO_SHARED_TOKEN, tools: obtenerHerramientasAudio(),
        cookiesPath: process.env.YOUTUBE_COOKIES_PATH || path.resolve(__dirname, '../config/youtube-cookie.txt'),
        maxStreams: Math.max(1, Math.min(10, Math.floor(Number(process.env.AUDIO_MAX_STREAMS) || 3))),
        maxResolvers: Math.max(1, Math.min(10, Math.floor(Number(process.env.AUDIO_MAX_RESOLVERS) || 2))) });
    const port = Number(process.env.AUDIO_PORT || 3001);
    server.listen(port, process.env.AUDIO_BIND_HOST || '127.0.0.1', () => console.log(`[Audio Worker v2] Listo en puerto ${port}. Sin cliente de Discord.`));
    const shutdown = () => { server.closeJobs(); server.close(() => process.exit(0)); setTimeout(() => process.exit(1), 5000).unref(); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    if (process.send) {
        process.on('message', message => { if (message?.type === 'shutdown') shutdown(); });
        process.once('disconnect', shutdown);
    }
    return server;
}
if (require.main === module) iniciarServidorAudio();
module.exports = { crearServidorAudio, autorizar, leerCuerpo, iniciarServidorAudio };
