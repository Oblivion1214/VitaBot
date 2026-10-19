const { apps } = require('./ecosistema.config.cjs');
module.exports = {
    apps: [{ ...apps[0], name: 'vitabot-pruebas', cwd: __dirname, args: ['--pruebas'],
        env: { BOT_ENV: 'test' }, max_memory_restart: '180M' }],
};
