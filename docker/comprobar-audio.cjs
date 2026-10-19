const fs = require('node:fs');
const { parseEnv } = require('node:util');
async function comprobar() {
    const env = parseEnv(fs.readFileSync('/run/secrets/audio_entorno', 'utf8'));
    const response = await fetch('http://127.0.0.1:3001/health', {
        headers: { authorization: `Bearer ${env.AUDIO_SHARED_TOKEN}` },
        signal: AbortSignal.timeout(4000),
    });
    if (!response.ok || (await response.json()).apiVersion !== 2) throw Error();
}
comprobar().catch(() => { process.exitCode = 1; });
