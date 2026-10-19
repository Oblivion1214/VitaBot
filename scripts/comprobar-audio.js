// Diagnóstico local sin iniciar Discord, consumir APIs ni leer cookies.
const { execFileSync } = require('node:child_process');
const { obtenerHerramientasAudio, argumentosYtDlp } = require('../utils/herramientasAudio');

function version(ejecutable, argumentos) {
    return execFileSync(ejecutable, argumentos, {
        encoding: 'utf8', windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'],
    }).trim().split(/\r?\n/)[0];
}

try {
    require('dotenv').config({ quiet: true });
    const herramientas = obtenerHerramientasAudio();
    console.log(`Node: ${process.version}`);
    console.log(`FFmpeg: ${version(herramientas.ffmpeg, ['-version'])}`);
    console.log(`yt-dlp: ${version(herramientas.ytDlp, ['--version'])}`);
    // Comprueba que el FFmpeg elegido tenga el codificador que usa el bot.
    execFileSync(herramientas.ffmpeg, [
        '-hide_banner', '-loglevel', 'error', '-f', 'lavfi', '-i', 'anullsrc=r=48000:cl=stereo',
        '-t', '0.1', '-c:a', 'libopus', '-f', 'opus', 'pipe:1',
    ], { windowsHide: true, timeout: 15000, stdio: ['ignore', 'pipe', 'pipe'] });
    console.log('Codificación Opus: OK');
    console.log(`Runtime de YouTube: ${argumentosYtDlp(herramientas)[1]}`);
    console.log('Worker sin dependencias npm. La VM retransmite Ogg/Opus sin codificarlo.');
} catch (error) {
    console.error(`Diagnóstico de audio fallido: ${error.message}`);
    process.exitCode = 1;
}
