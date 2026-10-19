const { spawn } = require('node:child_process');
const { ErrorAudio } = require('./protocolo');

function ejecutarJson(binary, args, { signal, timeout = 30_000, spawnImpl = spawn } = {}) {
    return new Promise((resolve, reject) => {
        if (signal?.aborted) return reject(new ErrorAudio('Solicitud cancelada.', 499));
        const proc = spawnImpl(binary, args, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
        const chunks = [];
        let size = 0, settled = false;
        const finish = (error, value) => {
            if (settled) return;
            settled = true; clearTimeout(timer); signal?.removeEventListener('abort', abort);
            if (error) { proc.kill(); reject(error); } else resolve(value);
        };
        const abort = () => finish(new ErrorAudio('Solicitud cancelada.', 499));
        const timer = setTimeout(() => finish(new ErrorAudio('La búsqueda tardó demasiado.', 504)), timeout);
        signal?.addEventListener('abort', abort, { once: true });
        proc.stdout.on('data', data => {
            size += data.length;
            if (size > 8 * 1024 * 1024) return finish(new ErrorAudio('La lista excede el tamaño permitido.', 413));
            if (!settled) chunks.push(data);
        });
        // No guardar ni publicar stderr: puede contener datos de sesión y URLs temporales.
        proc.stderr.resume();
        proc.once('error', () => finish(new ErrorAudio('No se pudo iniciar el extractor.')));
        proc.once('close', code => {
            if (code !== 0) return finish(new ErrorAudio('YouTube no permitió resolver esta búsqueda.'));
            try { finish(null, JSON.parse(Buffer.concat(chunks).toString('utf8'))); } catch { finish(new ErrorAudio('El extractor devolvió una respuesta inválida.')); }
        });
    });
}

function transmitirOpus({ response, tools, inputArgs, bitrate, signal, inputStream, spawnImpl = spawn, onDone = () => {} }) {
    let ended = false, started = false;
    let downloader, encoder;
    const cleanup = () => {
        if (ended) return;
        ended = true; clearTimeout(startup); clearTimeout(lifetime);
        signal?.removeEventListener('abort', cancel);
        encoder?.stdout.unpipe(response);
        if (encoder) downloader?.stdout.unpipe(encoder.stdin);
        inputStream?.destroy(); downloader?.kill(); encoder?.kill(); onDone();
    };
    const fail = () => {
        if (ended) return;
        if (!response.headersSent) {
            response.writeHead(502, { 'Content-Type': 'application/json' });
            response.end(JSON.stringify({ error: 'No se pudo producir el audio en la PC.' }));
        } else response.destroy();
        cleanup();
    };
    const cancel = () => { response.destroy(); cleanup(); };
    const startup = setTimeout(fail, 30_000);
    const lifetime = setTimeout(cancel, 6 * 60 * 60 * 1000).unref();
    response.once('close', cleanup);
    signal?.addEventListener('abort', cancel, { once: true });
    if (signal?.aborted) { cancel(); return cleanup; }
    try {
        encoder = spawnImpl(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', 'pipe:0', '-vn',
            '-c:a', 'libopus', '-b:a', `${bitrate}k`, '-ar', '48000', '-ac', '2',
            '-compression_level', '5', '-frame_duration', '20', '-f', 'opus', 'pipe:1'],
        { windowsHide: true, stdio: ['pipe', 'pipe', 'pipe'] });
        encoder.once('error', fail); encoder.stderr.resume(); encoder.stdin.on('error', () => {});
        encoder.stdout.once('data', () => {
            if (ended || response.destroyed) return;
            started = true; clearTimeout(startup);
            response.writeHead(200, { 'Content-Type': 'audio/ogg', 'Cache-Control': 'no-store', 'X-Audio-Bitrate': String(bitrate) });
        });
        encoder.stdout.on('error', fail);
        encoder.stdout.pipe(response, { end: false }); // Backpressure HTTP -> FFmpeg -> yt-dlp.
        encoder.stdout.once('end', () => { if (ended) return; if (!started) fail(); else response.end(); });
        encoder.once('close', code => { if (!started || (code && !ended)) fail(); });
        if (inputStream) {
            inputStream.once('error', fail); inputStream.pipe(encoder.stdin);
        } else {
            downloader = spawnImpl(tools.ytDlp, inputArgs, { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'] });
            downloader.once('error', fail); downloader.stderr.resume(); downloader.stdout.on('error', fail);
            downloader.stdout.pipe(encoder.stdin);
            downloader.once('close', code => { if (code && !ended) fail(); });
        }
    } catch { fail(); }
    return cleanup;
}
module.exports = { ejecutarJson, transmitirOpus };
