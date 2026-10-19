// Verifica el transporte real sin iniciar un segundo cliente de Discord.
const fs = require('node:fs');
const { ClienteAudio } = require('../utils/clienteAudio');
async function probarAudio({ youtube = false, tts = false, relay = false } = {}) {
    if (fs.existsSync('.env')) process.loadEnvFile('.env');
    const client = new ClienteAudio();
    const before = await client.health();
    if (before.apiVersion !== 2) throw Error('Versión de audio incompatible.');
    const unauthorized = await fetch(new URL('/health', client.baseUrl));
    if (unauthorized.status !== 401) throw Error('Health sin protección.');
    await unauthorized.body?.cancel();
    const report = { authenticatedHealth: true, unauthorizedStatus: unauthorized.status };
    if (youtube) {
        const result = await client.resolve('https://www.youtube.com/watch?v=jNQXAC9IVRw');
        if (!result.tracks.length) throw Error('No hay resultados de prueba.');
        const source = await client.open(result.tracks[0], 64);
        source.stream.on('error', () => {});
        let bytes = 0;
        try {
            for await (const chunk of source.stream) {
                if (!bytes && chunk.subarray(0, 4).toString() !== 'OggS') throw Error('Audio sin cabecera Ogg.');
                bytes += chunk.length;
                if (bytes >= 16000) break;
            }
        } finally { source.close(); }
        if (!bytes) throw Error('No llegaron datos de audio.');
        report.youtube = { resolved: true, ogg: true, bytes, cancelled: true };
    }
    if (tts) {
        const source = await client.speak('Prueba de voz de Vita.', 64);
        let bytes = 0;
        try {
            for await (const chunk of source.stream) {
                if (!bytes && chunk.subarray(0, 4).toString() !== 'OggS') throw Error('Voz sin cabecera Ogg.');
                bytes += chunk.length;
                if (bytes > 1024 * 1024) throw Error('La prueba de voz excedió el límite.');
            }
        } finally { source.close(); }
        if (!bytes) throw Error('No llegó la voz.');
        report.tts = { ogg: true, bytes };
    }
    if (relay) {
        const voice = require('@discordjs/voice');
        const source = await client.speak('Vita está lista.', 64);
        const resource = voice.createAudioResource(source.stream, { inputType: voice.StreamType.OggOpus, inlineVolume: false });
        let packets = 0;
        try { for await (const packet of resource.playStream) { if (packet.length) packets++; } }
        finally { source.close(); }
        if (!packets || resource.edges.some(edge => /encoder|ffmpeg/i.test(edge.type))) throw Error('La ruta Opus requiere conversión inesperada.');
        report.relay = { packets, transforms: resource.edges.map(edge => edge.type), encodingRequired: false };
    }
    // Dar tiempo al cierre TCP para cancelar los procesos del otro host.
    let after;
    for (let i = 0; i < 20; i++) {
        after = await client.health();
        if (after.activeStreams === before.activeStreams && after.resolving === before.resolving) break;
        await new Promise(resolve => setTimeout(resolve, 100));
    }
    report.after = after;
    if (after.activeStreams > before.activeStreams || after.resolving > before.resolving) throw Error('Quedaron trabajos de prueba activos.');
    console.log(JSON.stringify(report));
    return report;
}
if (require.main === module) {
    const { values } = require('node:util').parseArgs({ options: { youtube: { type: 'boolean' }, tts: { type: 'boolean' }, relay: { type: 'boolean' } } });
    probarAudio(values).catch(error => { console.error(error.message); process.exitCode = 1; });
}
module.exports = { probarAudio };
