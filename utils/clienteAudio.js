const { Readable } = require('node:stream');
const { normalizarCancion, ErrorAudio } = require('../audio/protocolo');

async function leerJson(response, maxBytes) {
    let size = 0;
    const chunks = [];
    for await (const chunk of response.body) {
        size += chunk.length;
        if (size > maxBytes) throw new ErrorAudio('Respuesta de audio demasiado grande.');
        chunks.push(Buffer.from(chunk));
    }
    return JSON.parse(Buffer.concat(chunks).toString('utf8'));
}

class ClienteAudio {
    constructor({ baseUrl = process.env.PC_AUDIO_URL, token = process.env.AUDIO_SHARED_TOKEN, fetchImpl = fetch } = {}) {
        if (!baseUrl || !token || token.length < 32) throw new Error('Configura PC_AUDIO_URL y AUDIO_SHARED_TOKEN para el servidor de audio.');
        const url = new URL(baseUrl);
        if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password) throw new Error('PC_AUDIO_URL inválida.');
        this.baseUrl = url.origin; this.token = token; this.fetch = fetchImpl;
    }
    async request(route, { json, signal, stream = false, timeout = 35_000 } = {}) {
        const controller = new AbortController();
        const abort = () => controller.abort();
        if (signal?.aborted) abort();
        signal?.addEventListener('abort', abort, { once: true });
        let timedOut = false;
        const timer = setTimeout(() => { timedOut = true; abort(); }, timeout);
        let transferred = false;
        try {
            const response = await this.fetch(new URL(route, this.baseUrl), {
                method: json === undefined ? 'GET' : 'POST', redirect: 'error', signal: controller.signal,
                headers: { Authorization: `Bearer ${this.token}`, ...(json === undefined ? {} : { 'Content-Type': 'application/json' }) },
                body: json === undefined ? undefined : JSON.stringify(json),
            });
            if (!response.ok) {
                const { status } = response;
                if (status === 401) throw new ErrorAudio('El bot no pudo autenticarse con el servidor de audio.', status);
                if (response.headers.get('content-type')?.startsWith('application/json')) {
                    const details = await leerJson(response, 4096).catch(() => null);
                    if (controller.signal.aborted) throw controller.signal.reason;
                    if (typeof details?.error === 'string' && details.error.trim() && details.error.length <= 250) {
                        throw new ErrorAudio(details.error, status);
                    }
                }
                throw new ErrorAudio(status === 429 ? 'El servidor de audio está ocupado. Intenta de nuevo.' :
                    `El servidor de audio respondió con un error (HTTP ${status}).`, status);
            }
            if (!stream) return await leerJson(response, 512 * 1024);
            if (!response.body || !response.headers.get('content-type')?.startsWith('audio/ogg')) { await response.body?.cancel(); throw new ErrorAudio('La PC no devolvió audio Opus.'); }
            const body = Readable.fromWeb(response.body, { highWaterMark: 64 * 1024 });
            const close = () => { signal?.removeEventListener('abort', abort); controller.abort(); body.destroy(); };
            body.once('close', () => { signal?.removeEventListener('abort', abort); controller.abort(); });
            transferred = true;
            return { stream: body, close, bitrate: Number(response.headers.get('x-audio-bitrate')) || 128 };
        } catch (error) {
            controller.abort();
            if (error instanceof ErrorAudio) throw error;
            if (signal?.aborted) throw new ErrorAudio('Solicitud cancelada.', 499);
            if (timedOut) throw new ErrorAudio('El servidor de audio tardó demasiado en responder.', 504);
            throw new ErrorAudio('No pude comunicarme con el servidor de audio.');
        } finally {
            clearTimeout(timer);
            if (!transferred) signal?.removeEventListener('abort', abort);
        }
    }
    async resolve(query, signal) {
        const result = await this.request('/v1/resolve', { json: { query }, signal });
        if (!Array.isArray(result.tracks) || result.tracks.length > 100) throw new ErrorAudio('Lista de audio inválida.');
        return { ...result, tracks: result.tracks.map(normalizarCancion) };
    }
    open(track, bitrate, signal) {
        return this.request(`/v1/stream?${new URLSearchParams({ url: track.url, bitrate: String(bitrate) })}`, { stream: true, signal });
    }
    speak(text, bitrate, signal) { return this.request(`/v1/tts?bitrate=${bitrate}`, { stream: true, json: { text, lang: 'es' }, signal }); }
    health() { return this.request('/health', { timeout: 5000 }); }
}
module.exports = { ClienteAudio };
