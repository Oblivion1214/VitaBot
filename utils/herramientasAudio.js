const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

function buscarEnPath(nombre) {
    try {
        const buscador = process.platform === 'win32' ? 'where.exe' : 'which';
        return execFileSync(buscador, [nombre], {
            encoding: 'utf8', windowsHide: true, stdio: ['ignore', 'pipe', 'ignore'], timeout: 3000,
        }).trim().split(/\r?\n/).find(candidato => fs.existsSync(candidato));
    } catch {
        return undefined;
    }
}

function resolverEjecutable(variable, nombre) {
    const configurado = process.env[variable];
    if (configurado) {
        const ruta = path.resolve(configurado);
        if (!fs.existsSync(ruta)) throw new Error(`${variable} apunta a un ejecutable inexistente.`);
        return ruta;
    }
    const encontrado = buscarEnPath(nombre);
    if (encontrado) return encontrado;

    // WinGet actualiza el PATH para nuevas terminales; también funciona desde una sesión ya abierta.
    if (process.platform === 'win32') {
        const localAppData = process.env.LOCALAPPDATA || path.join(os.homedir(), 'AppData', 'Local');
        const enlace = path.join(localAppData, 'Microsoft', 'WinGet', 'Links', `${nombre}.exe`);
        if (fs.existsSync(enlace)) return enlace;
    }
    throw new Error(`No se encontró ${nombre}. Instálalo o configura ${variable}.`);
}

function obtenerHerramientasAudio() {
    const ffmpeg = resolverEjecutable('FFMPEG_PATH', 'ffmpeg');
    const ytDlp = resolverEjecutable('YTDLP_PATH', 'yt-dlp');
    return { ffmpeg, ytDlp, node: process.execPath };
}

function argumentosYtDlp(herramientas) {
    return ['--js-runtimes', `node:${herramientas.node}`, '--ffmpeg-location', herramientas.ffmpeg];
}

module.exports = { obtenerHerramientasAudio, argumentosYtDlp };
