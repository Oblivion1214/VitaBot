// Prueba corta sin conectar a canales de Discord. Las cookies requieren una opción explícita.
const fs = require('node:fs');
const path = require('node:path');
const { spawnSync } = require('node:child_process');
const { obtenerHerramientasAudio, argumentosYtDlp } = require('../utils/herramientasAudio');

const cache = path.resolve(__dirname, '../.cache');
fs.mkdirSync(cache, { recursive: true });
const prefix = path.join(cache, `youtube-smoke-${Date.now()}`);
const result = { success: false, cookiesUsed: process.argv.includes('--use-existing-cookies') };
let stage = 'download';
try {
    const tools = obtenerHerramientasAudio();
    const args = ['--ignore-config', ...argumentosYtDlp(tools), '--no-playlist', '--no-progress',
        '--socket-timeout', '10', '--retries', '1', '--max-filesize', '5M', '-f', 'bestaudio',
        '-o', `${prefix}-source.%(ext)s`, '--print', 'after_move:filepath'];
    if (result.cookiesUsed) args.push('--cookies', path.resolve(__dirname, '../config/youtube-cookie.txt'));
    else args.push('--no-cookies');
    args.push('https://www.youtube.com/watch?v=jNQXAC9IVRw');
    const download = spawnSync(tools.ytDlp, args, { encoding: 'utf8', windowsHide: true, timeout: 45000, maxBuffer: 1024 * 1024 });
    if (download.status !== 0) {
        fs.writeFileSync(path.join(cache, 'youtube-smoke-error.log'), download.stderr || String(download.error || ''));
        throw new Error(/429/.test(download.stderr || '') ? 'YouTube devolvió HTTP 429' : 'Falló la descarga; revisar el log local privado');
    }
    const input = download.stdout.trim().split(/\r?\n/).at(-1);
    if (!input || !fs.existsSync(input)) throw new Error('No se encontró el archivo de la prueba');
    stage = 'encode';
    const output = `${prefix}.opus`;
    const encode = spawnSync(tools.ffmpeg, ['-hide_banner', '-loglevel', 'error', '-i', input,
        '-t', '5', '-vn', '-c:a', 'libopus', '-b:a', '128k', '-ar', '48000', '-ac', '2', '-f', 'opus', output],
    { encoding: 'utf8', windowsHide: true, timeout: 15000 });
    if (encode.status !== 0) throw new Error('Falló la conversión de FFmpeg a Opus');
    stage = 'probe';
    const ffprobe = path.join(path.dirname(tools.ffmpeg), process.platform === 'win32' ? 'ffprobe.exe' : 'ffprobe');
    const probe = spawnSync(ffprobe, ['-v', 'error', '-show_entries', 'format=duration:stream=codec_name,sample_rate,channels', '-of', 'json', output],
        { encoding: 'utf8', windowsHide: true, timeout: 10000 });
    if (probe.status !== 0) throw new Error('No se pudo verificar el audio con ffprobe');
    const info = JSON.parse(probe.stdout);
    result.stream = info.streams[0];
    result.durationSeconds = Number(info.format.duration);
    if (result.stream.codec_name !== 'opus' || result.stream.sample_rate !== '48000' || result.durationSeconds < 4.9) {
        throw new Error('El audio no tiene el formato esperado');
    }
    result.success = true;
    result.outputFile = output;
} catch (error) {
    result.stage = stage;
    result.error = error.message;
    process.exitCode = 1;
}
fs.writeFileSync(path.join(cache, 'youtube-smoke-result.json'), JSON.stringify(result, null, 2));
console.log(JSON.stringify(result));
