const fs = require('node:fs');
const path = require('node:path');
const net = require('node:net');
const { fork, execFile } = require('node:child_process');
const { createHash } = require('node:crypto');
const { agregarRegistro } = require('../utils/registroLimitado');

function crearSupervisor({ spawn, probe, kill, log = () => {}, now = Date.now,
    schedule = setTimeout, cancel = clearTimeout, every = setInterval, cancelEvery = clearInterval } = {}) {
    let child = null, retry = null, force = null, stopped = false, started = 0, failures = 0, unhealthy = 0, checking = false;
    function launch() {
        if (stopped) return;
        started = now(); unhealthy = 0;
        let current;
        try { current = child = spawn(); }
        catch { log('No se pudo lanzar el worker; se reintentará.\n'); retry = schedule(launch, 30_000); return; }
        const exited = () => {
            if (child !== current) return;
            child = null; if (force) cancel(force); force = null;
            if (stopped) return;
            if (now() - started > 60_000) failures = 0;
            const delay = Math.min(30_000, 1000 * 2 ** Math.min(failures++, 5));
            log('Worker detenido; reintento en ' + delay + ' ms.\n');
            retry = schedule(launch, delay);
        };
        current.once('exit', exited); current.once('error', exited);
        log('Worker iniciado.\n');
    }
    function stopChild() {
        const current = child; if (!current || force) return;
        try { current.send({ type: 'shutdown' }, () => {}); } catch { /* Force-stop below if IPC is unavailable. */ }
        force = schedule(() => { if (child === current) kill(current); }, 6000);
    }
    async function check() {
        if (stopped || checking || !child || now() - started < 15_000) return;
        checking = true; const current = child;
        try { await probe(); if (child === current) unhealthy = 0; }
        catch { if (child === current && ++unhealthy >= 2) { log('Dos comprobaciones fallidas; reinicio del worker.\n'); stopChild(); } }
        finally { checking = false; }
    }
    launch(); const timer = every(check, 30_000);
    return {
        check,
        close() { stopped = true; if (retry) cancel(retry); cancelEvery(timer); stopChild(); },
    };
}
async function iniciarSupervisor() {
    if (process.platform !== 'win32') throw Error('Este arranque está previsto para la PC con Windows.');
    const root = fs.realpathSync(path.resolve(__dirname, '..'));
    const envFile = path.join(root, '.env.audio'); process.loadEnvFile(envFile);
    const token = process.env.AUDIO_SHARED_TOKEN;
    if (!token || token.length < 32) throw Error('Falta la configuración privada de audio.');
    const dir = path.join(root, '.cache/audio-service'); fs.mkdirSync(dir, { recursive: true });
    const logfile = path.join(dir, 'service.log');
    const log = value => { try { agregarRegistro(logfile, new Date().toISOString() + ' ' + value); } catch { /* Keep the audio worker alive on log errors. */ } };
    const lock = net.createServer(socket => socket.end());
    const pipe = '\\\\.\\pipe\\vitabot-audio-' + createHash('sha256').update(root.toLowerCase()).digest('hex').slice(0, 16);
    await new Promise((resolve, reject) => { lock.once('error', reject); lock.listen(pipe, resolve); });
    try { fs.writeFileSync(path.join(dir, 'supervisor.pid'), String(process.pid)); } catch { log('No se pudo guardar el PID del supervisor.\n'); }
    const host = process.env.AUDIO_BIND_HOST || '127.0.0.1';
    const base = `http://${host.includes(':') ? '[' + host + ']' : host}:${process.env.AUDIO_PORT || 3001}`;
    const supervisor = crearSupervisor({
        log,
        spawn() {
            const child = fork(path.join(root, 'audio/servidor.js'), [], { cwd: root, windowsHide: true, stdio: ['ignore', 'pipe', 'pipe', 'ipc'] });
            try { fs.writeFileSync(path.join(root, '.cache/audio-worker-v2.pid'), String(child.pid || '')); }
            catch { log('No se pudo guardar el PID del worker.\n'); }
            child.stdout.on('data', log); child.stderr.on('data', log);
            return child;
        },
        async probe() {
            const response = await fetch(base + '/health', { headers: { Authorization: 'Bearer ' + token }, redirect: 'error', signal: AbortSignal.timeout(5000) });
            if (!response.ok) { await response.body?.cancel(); throw Error('Health falló'); }
            const data = await response.json(); if (data.status !== 'ok' || data.apiVersion !== 2) throw Error('Health inválido');
        },
        kill(child) { execFile('taskkill.exe', ['/PID', String(child.pid), '/T', '/F'], { windowsHide: true }, () => {}); },
    });
    const shutdown = () => { supervisor.close(); lock.close(); setTimeout(() => process.exit(0), 7000); };
    process.once('SIGTERM', shutdown); process.once('SIGINT', shutdown);
    return supervisor;
}
if (require.main === module) iniciarSupervisor().catch(error => {
    if (error.code !== 'EADDRINUSE') console.error('[Audio] No se pudo iniciar el supervisor. Revisa la configuración local.');
    process.exitCode = error.code === 'EADDRINUSE' ? 0 : 1;
});
module.exports = { crearSupervisor, iniciarSupervisor };
