const fs = require('node:fs');
const path = require('node:path');

function terminar() {
    try { fs.writeSync(2, '[Contenedor] No se pudo iniciar el servicio; revisa su configuración privada.\n'); } catch {}
    process.exit(1);
}

try {
    process.umask(0o077);
    const servicio = process.argv[2];
    if (!['bot', 'audio'].includes(servicio)) throw Error();
    process.loadEnvFile(`/run/secrets/${servicio}_entorno`);
    if (servicio === 'bot') {
        require('../index.js');
    } else {
        process.prependListener('uncaughtException', terminar);
        process.prependListener('unhandledRejection', terminar);
        // yt-dlp actualiza el cookie jar. Solo escribe una copia efímera y privada.
        const temporal = '/tmp/vitabot';
        fs.mkdirSync(temporal, { recursive: true, mode: 0o700 });
        const cookies = path.join(temporal, 'youtube-cookie.txt');
        fs.copyFileSync('/run/secrets/youtube_cookies', cookies);
        fs.chmodSync(cookies, 0o600);
        process.env.YOUTUBE_COOKIES_PATH = cookies;
        process.env.AUDIO_ENV_FILE = '/run/secrets/audio_entorno';
        require('../audio/servidor').iniciarServidorAudio();
    }
} catch { terminar(); }
