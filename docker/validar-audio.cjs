// Ejecutar dentro del contenedor de audio: solo imprime resultados agregados.
const fs = require('node:fs');
const { parseEnv } = require('node:util');
async function validar() {
    const env = parseEnv(fs.readFileSync('/run/secrets/audio_entorno', 'utf8'));
    const base = 'http://127.0.0.1:3001';
    const headers = { Authorization: `Bearer ${env.AUDIO_SHARED_TOKEN}` };
    const pedir = (ruta, json) => fetch(base + ruta, {
        method: json ? 'POST' : 'GET', headers: { ...headers, ...(json ? { 'Content-Type': 'application/json' } : {}) },
        ...(json ? { body: JSON.stringify(json) } : {}), signal: AbortSignal.timeout(45000),
    });
    const ajeno = await fetch(base + '/health');
    if (ajeno.status !== 401) throw Error();
    await ajeno.body?.cancel();
    const inicial = await (await pedir('/health')).json();
    if (inicial.apiVersion !== 2) throw Error();
    const url = 'https://www.youtube.com/watch?v=jNQXAC9IVRw';
    const resuelto = await pedir('/v1/resolve', { query: url });
    if (!resuelto.ok || !(await resuelto.json()).tracks?.length) throw Error();
    const resultado = { api: 2, autenticacion: true, busqueda: true };
    for (const [nombre, ruta, json] of [
        ['youtube', '/v1/stream?url=' + encodeURIComponent(url)],
        ['voz', '/v1/tts', { text: 'Prueba de voz de Vita', lang: 'es' }],
    ]) {
        const respuesta = await pedir(ruta, json);
        if (!respuesta.ok || !respuesta.headers.get('content-type')?.startsWith('audio/ogg')) throw Error();
        const chunks = []; let total = 0;
        for await (const chunk of respuesta.body) {
            total += chunk.length;
            if (total > 1024 * 1024) throw Error();
            chunks.push(Buffer.from(chunk));
        }
        const audio = Buffer.concat(chunks);
        if (total < 100 || audio.toString('ascii', 0, 4) !== 'OggS' || !audio.includes(Buffer.from('OpusHead'))) throw Error();
        resultado[nombre] = { bytes: total, opus: true };
    }
    const final = await (await pedir('/health')).json();
    if (final.activeStreams !== 0 || final.resolving !== 0) throw Error();
    resultado.trabajosRestantes = 0;
    resultado.credencialesDiscordAccesibles = fs.existsSync('/run/secrets/bot_entorno') || !!process.env.TOKEN;
    if (resultado.credencialesDiscordAccesibles) throw Error();
    console.log(JSON.stringify(resultado));
}
validar().catch(() => {
    console.error('La comprobación de audio no terminó correctamente; no se muestran respuestas ni datos de sesión.');
    process.exitCode = 1;
});
