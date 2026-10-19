const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

function cargar({ env = {}, encontrados = {}, archivos = [], platform = 'win32' } = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../utils/herramientasAudio.js'), 'utf8');
    const sandbox = {
        module: { exports: {} }, process: { platform, env, execPath: 'C:\\Node JS\\node.exe' },
        require(nombre) {
            if (nombre === 'node:fs') return { existsSync: ruta => archivos.includes(ruta) };
            if (nombre === 'node:path') return platform === 'win32' ? path.win32 : path.posix;
            if (nombre === 'node:os') return { homedir: () => 'C:\\Usuario' };
            if (nombre === 'node:child_process') return { execFileSync: (_, [binario], opciones) => {
                assert.equal(opciones.windowsHide, true);
                if (!encontrados[binario]) throw new Error('No encontrado');
                return encontrados[binario];
            } };
            if (nombre === 'ffmpeg-static') return 'C:\\paquetes\\ffmpeg.exe';
            if (nombre === 'youtube-dl-exec') return { constants: { YOUTUBE_DL_PATH: 'C:\\paquetes\\yt-dlp.exe' } };
            throw new Error(`Dependencia inesperada: ${nombre}`);
        },
    };
    vm.runInNewContext(source, sandbox);
    return sandbox.module.exports;
}

test('las rutas explícitas de audio tienen prioridad y admiten espacios', () => {
    const ffmpeg = 'C:\\Mis herramientas\\ffmpeg.exe';
    const ytDlp = 'C:\\Mis herramientas\\yt-dlp.exe';
    const tools = cargar({ env: { FFMPEG_PATH: ffmpeg, YTDLP_PATH: ytDlp }, archivos: [ffmpeg, ytDlp] });
    assert.equal(tools.obtenerHerramientasAudio().ffmpeg, ffmpeg);
    assert.equal(tools.obtenerHerramientasAudio().ytDlp, ytDlp);
});

test('una ruta explícita errónea falla sin ignorar la configuración', () => {
    const tools = cargar({ env: { FFMPEG_PATH: 'C:\\no-existe.exe' } });
    assert.throws(() => tools.obtenerHerramientasAudio(), /FFMPEG_PATH apunta/);
});

test('prefiere los ejecutables de PATH a las copias empaquetadas', () => {
    const tools = cargar({
        encontrados: { ffmpeg: 'C:\\sistema\\ffmpeg.exe\r\n', 'yt-dlp': 'C:\\sistema\\yt-dlp.exe\r\n' },
        archivos: ['C:\\sistema\\ffmpeg.exe', 'C:\\sistema\\yt-dlp.exe', 'C:\\paquetes\\ffmpeg.exe'],
    });
    assert.equal(tools.obtenerHerramientasAudio().ffmpeg, 'C:\\sistema\\ffmpeg.exe');
});

test('la VM no descarga ni usa ejecutables empaquetados en node_modules', () => {
    const tools = cargar({ archivos: ['C:\\paquetes\\ffmpeg.exe', 'C:\\paquetes\\yt-dlp.exe'] });
    assert.throws(() => tools.obtenerHerramientasAudio(), /No se encontró ffmpeg/);
});

test('informa herramientas ausentes sin ejecutar comandos de instalación', () => {
    assert.throws(() => cargar().obtenerHerramientasAudio(), /No se encontró ffmpeg/);
});

test('pasa el runtime de YouTube y FFmpeg como argumentos separados, sin shell', () => {
    const tools = cargar();
    const args = tools.argumentosYtDlp({ node: 'C:\\Node JS\\node.exe', ffmpeg: 'C:\\Mis herramientas\\ffmpeg.exe' });
    assert.equal(args[0], '--js-runtimes');
    assert.equal(args[1], 'node:C:\\Node JS\\node.exe');
    assert.equal(args[2], '--ffmpeg-location');
    assert.equal(args[3], 'C:\\Mis herramientas\\ffmpeg.exe');
});

test('resuelve las herramientas del PATH en Linux', () => {
    const tools = cargar({ platform: 'linux', encontrados: { ffmpeg: '/usr/bin/ffmpeg', 'yt-dlp': '/usr/local/bin/yt-dlp' }, archivos: ['/usr/bin/ffmpeg', '/usr/local/bin/yt-dlp'] });
    assert.equal(tools.obtenerHerramientasAudio().ffmpeg, '/usr/bin/ffmpeg');
});

