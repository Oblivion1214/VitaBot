const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { EventEmitter } = require('node:events');
const discord = require('discord.js');
const tick = () => new Promise(resolve => setImmediate(resolve));
function fixture(options = {}) {
    let config = { idioma: 'es', _setupCompleto: !!options.complete };
    let dmCount = 0, leaves = 0;
    const timers = [], edits = [], responses = [];
    const collector = new EventEmitter(); collector.ended = false;
    collector.stop = reason => {
        if (collector.ended) return;
        collector.ended = true;
        collector.endPromise = Promise.all(collector.listeners('end').map(fn => fn([], reason)));
    };
    const message = { id: 'panel', edit: async payload => { edits.push(payload); }, createMessageComponentCollector: () => collector };
    const permissions = { has: () => true };
    const logChannel = { id: 'logs', name: 'audit', type: discord.ChannelType.GuildText, position: 1,
        permissionsFor: () => permissions, send: async () => message };
    const guild = { id: 'guild', name: 'Test guild', ownerId: 'owner', available: true, preferredLocale: 'es-MX',
        members: { me: { id: 'bot', permissions } }, roles: { everyone: { id: 'everyone' } },
        channels: { cache: new discord.Collection([['logs', logChannel]]) }, systemChannel: logChannel,
        fetchOwner: async () => ({ id: 'owner', send: async () => { dmCount++; return message; } }),
        leave: async () => { leaves++; },
    };
    const client = new EventEmitter(); client.guilds = { cache: new discord.Collection([[guild.id, guild]]) };
    const logger = {
        obtenerConfigServidor: () => ({ ...config }),
        actualizarConfigServidor: (_, update) => { if (options.saveFailure) throw Error('save failed'); config = { ...config, ...update }; },
        registrarMensajeSetup: () => {}, log: async () => {},
        obtenerCanalLog: options.getLog || (async () => logChannel),
    };
    const sandbox = { module: { exports: {} }, console: { log() {}, error() {}, warn() {} },
        require: name => name === 'discord.js' ? discord : name === './identidadEjecucion'
            ? { esServidorPermitido: () => options.permitido !== false } : logger,
        setTimeout(fn, ms) { const timer = { fn, ms, cleared: false, unref() {} }; timers.push(timer); return timer; },
        clearTimeout(timer) { if (timer) timer.cleared = true; },
    };
    vm.runInNewContext(fs.readFileSync(path.join(__dirname, '../utils/guildSetup.js'), 'utf8'), sandbox);
    const api = sandbox.module.exports; api.registrarGuildCreate(client);
    const join = () => client.listeners('guildCreate')[0](guild);
    const interaction = customId => ({ customId, user: { id: 'owner', tag: 'owner' },
        deferred: false, replied: false,
        async deferUpdate() { this.deferred = true; responses.push({ deferred: true }); },
        async update(payload) { this.replied = true; responses.push(payload); },
        async editReply(payload) { responses.push(payload); },
        async reply(payload) { this.replied = true; responses.push(payload); },
    });
    return { join, client, guild, collector, message, timers, edits, responses, logChannel, interaction,
        api, get config() { return config; }, acceptViaConfig: () => { config._setupCompleto = true; },
        get dmCount() { return dmCount; }, get leaves() { return leaves; },
        collect: item => collector.listeners('collect')[0](item),
        timeout: () => timers.find(timer => timer.ms === 600000),
        releaseDelay: async () => { await tick(); const timer = timers.find(timer => timer.ms === 1500); assert.ok(timer); timer.fn(); },
    };
}
test('una confirmación previa evita reenviar paneles y programar otra salida', async () => {
    const f = fixture({ complete: true }); await f.join();
    assert.equal(f.dmCount, 0); assert.equal(f.timers.length, 0);
});
test('dos eventos simultáneos de unión crean un único panel y temporizador', async () => {
    const f = fixture(); await Promise.all([f.join(), f.join()]);
    assert.equal(f.dmCount, 1); assert.equal(f.timers.filter(timer => timer.ms === 600000).length, 1);
});
test('confirmación recibida mientras el timeout avisa impide abandonar el servidor', async () => {
    const f = fixture(); await f.join();
    const expiry = f.timeout().fn(); await tick();
    await f.collect(f.interaction('confirm_setup_guild'));
    await f.releaseDelay(); await expiry;
    assert.equal(f.config._setupCompleto, true); assert.equal(f.leaves, 0);
});
test('/config completado durante el aviso también cancela la salida en curso', async () => {
    const f = fixture(); await f.join();
    const expiry = f.timeout().fn(); await tick(); f.acceptViaConfig();
    await f.releaseDelay(); await expiry; assert.equal(f.leaves, 0);
});
test('sin confirmación se conserva la retirada anunciada a los diez minutos', async () => {
    const f = fixture(); await f.join();
    const expiry = f.timeout().fn(); f.collector.stop('time');
    await f.releaseDelay(); await expiry;
    assert.equal(f.leaves, 1); assert.equal(f.api.setupCollectors.has('guild'), false);
});
test('creación lenta del canal reconoce la interacción antes de la API y bloquea el timeout', async () => {
    let complete;
    const f = fixture({ getLog: () => new Promise(resolve => { complete = resolve; }) }); await f.join();
    const item = f.interaction('confirm_setup_guild'), pending = f.collect(item); await tick();
    assert.equal(item.deferred, true); await f.timeout().fn(); assert.equal(f.leaves, 0);
    complete(f.logChannel); await pending; assert.equal(f.config._setupCompleto, true);
});
test('fallo de persistencia muestra error y nunca anuncia una confirmación guardada', async () => {
    const f = fixture({ saveFailure: true }); await f.join();
    await f.collect(f.interaction('confirm_setup_guild'));
    assert.equal(f.config._setupCompleto, false); assert.equal(f.collector.ended, true);
    assert.ok(f.responses.some(response => response.content?.includes('No pude completar')));
    assert.ok(!f.responses.some(response => response.content?.includes('Sincronización Completada')));
    await f.timeout().fn(); assert.equal(f.leaves, 0);
});
test('un panel anterior no permite cancelar una unión ya confirmada por /config', async () => {
    const f = fixture(); await f.join(); f.acceptViaConfig();
    await f.collect(f.interaction('cancel_setup_guild'));
    assert.equal(f.leaves, 0); assert.ok(f.responses.some(response => response.content?.includes('ya fue confirmada')));
});
test('salir del servidor invalida la sesión y sus callbacks tardíos', async () => {
    const f = fixture(); await f.join();
    f.client.emit('guildDelete', f.guild); await f.collector.endPromise;
    await f.timeout().fn(); assert.equal(f.leaves, 0); assert.equal(f.timeout().cleared, true);
});
