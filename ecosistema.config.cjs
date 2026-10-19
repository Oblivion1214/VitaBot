const pruebas = require('node:fs').existsSync(require('node:path').join(__dirname, '.vitabot-pruebas'));
module.exports = {
    apps: [{
        name: pruebas ? 'vitabot-pruebas' : 'vitabot',
        cwd: __dirname,
        script: 'index.js',
        args: pruebas ? ['--pruebas'] : [],
        ...(pruebas ? { env: { BOT_ENV: 'test' }, max_memory_restart: '180M' } : {}),
        instances: 1,
        exec_mode: 'fork',
        autorestart: true,
        node_args: ['--unhandled-rejections=strict'],
        // Evitar ciclos rápidos si falla el arranque y permitir el cierre normal de 3 s.
        exp_backoff_restart_delay: 1000,
        min_uptime: '10s',
        max_restarts: 10,
        kill_timeout: 5000,
    }],
};
