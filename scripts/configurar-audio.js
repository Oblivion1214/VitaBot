// Ejecutar localmente en cada host. Nunca imprime ni transfiere credenciales.
const fs = require('node:fs');
const path = require('node:path');
const { parseEnv } = require('node:util');
const { createHmac } = require('node:crypto');

function configurarAudio({ root = process.cwd(), url, worker = false, bind = '127.0.0.1' }) {
    const endpoint = new URL(url);
    if (!['http:', 'https:'].includes(endpoint.protocol) || endpoint.username || endpoint.password || endpoint.pathname !== '/') throw new Error('URL de audio inválida.');
    const file = path.join(root, '.env');
    let text = fs.readFileSync(file, 'utf8');
    const env = parseEnv(text);
    if (!env.TOKEN) throw new Error('Falta TOKEN en el entorno del bot.');
    // La clave está separada por propósito; el worker no necesita el token de Discord.
    const token = createHmac('sha256', env.TOKEN).update('VitaBot audio-worker auth v2').digest('hex');
    for (const [key, value] of Object.entries({ PC_AUDIO_URL: endpoint.origin, AUDIO_SHARED_TOKEN: token })) {
        const line = `${key}=${value}`;
        text = new RegExp(`^${key}=.*$`, 'm').test(text) ? text.replace(new RegExp(`^${key}=.*$`, 'm'), line) : `${text.trimEnd()}\n${line}\n`;
    }
    fs.writeFileSync(file, text, { mode: 0o600 });
    if (worker) {
        if (!/^[\w.:-]+$/.test(bind)) throw new Error('Dirección local inválida.');
        const settings = { AUDIO_BIND_HOST: bind, AUDIO_PORT: endpoint.port || (endpoint.protocol === 'https:' ? '443' : '80'),
            AUDIO_SHARED_TOKEN: token, AUDIO_MAX_STREAMS: '3' };
        fs.writeFileSync(path.join(root, '.env.audio'), Object.entries(settings).map(([key, value]) => `${key}=${value}`).join('\n') + '\n', { mode: 0o600 });
    }
}
if (require.main === module) {
    const { values } = require('node:util').parseArgs({ options: { root: { type: 'string' }, url: { type: 'string' }, worker: { type: 'boolean' }, bind: { type: 'string' } } });
    configurarAudio(values);
    console.log('Configuración v2 guardada. Credenciales ocultas.');
}
module.exports = { configurarAudio };
