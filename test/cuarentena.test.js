const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { PermissionFlagsBits: P } = require('discord.js');
const { crearAlmacenSeguridad } = require('../utils/almacenSeguridad');
const { ejecutarCuarentena, manejarBotonCuarentena } = require('../utils/cuarentena');
function fixture(t) {
    const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vita-quarantine-'));
    t.after(() => { assert.equal(path.dirname(root), os.tmpdir()); fs.rmSync(root, { recursive: true, force: true }); });
    const file = path.join(root, 'state.json'), store = crearAlmacenSeguridad(file);
    const events = [], all = { has: () => true }, none = { has: () => false };
    const bot = { id: 'bot' }, member = { id: 'moderator' }, everyone = { id: 'guild' };
    const panel = { id: 'panel', edit: async payload => events.push({ event: 'panel-edit', payload }) };
    let present = true;
    const log = { id: 'log', guildId: 'guild', permissionsFor: who => who === everyone ? none : all,
        send: async payload => { events.push({ event: 'panel', payload }); return panel; } };
    const original = { id: 'channel', permissionsFor: () => all, messages: { fetch: async () => {
        if (!present) throw Object.assign(Error('missing'), { code: 10008 }); return message;
    } }, send: async payload => { events.push({ event: 'restore', payload }); return { id: 'restored' }; } };
    const guild = { id: 'guild', roles: { everyone, fetch: async () => {} }, members: { fetchMe: async () => bot, fetch: async () => member },
        channels: { fetch: async id => id === 'log' ? log : original } };
    const message = { id: 'original', channelId: 'channel', channel: original, guild, content: 'Texto completo @everyone https://danger.example/',
        editedTimestamp: null, attachments: new Map(), author: { id: 'author', tag: 'Nombre' }, delete: async () => {
            events.push({ event: 'delete', durable: JSON.parse(fs.readFileSync(file, 'utf8')) }); present = false;
        } };
    const dependencies = { store, getLog: async () => log, getConfig: () => ({ activo: true, categorias: { seguridad: true } }) };
    const interaction = { guild, guildId: 'guild', channelId: 'log', channel: log, user: { id: 'moderator' }, client: { user: { id: 'bot' } },
        message: { ...panel, author: { id: 'bot' } }, deferReply: async () => {}, editReply: async payload => events.push({ event: 'reply', payload }) };
    function record() { return Object.values(JSON.parse(fs.readFileSync(file, 'utf8')).cases)[0]; }
    async function prepare() { await ejecutarCuarentena(message, { motivo: 'Confirmación de prueba' }, dependencies); interaction.customId = 'approve_link_' + record().id; }
    return { root, file, store, events, log, original, guild, message, dependencies, interaction, record, prepare };
}
test('guarda texto completo y entrega el panel antes de borrar', async t => {
    const f = fixture(t); f.message.content = '🔨'.repeat(1800);
    assert.equal(await ejecutarCuarentena(f.message, { motivo: 'prueba' }, f.dependencies), true);
    assert.equal(f.events[0].event, 'panel');
    const deletion = f.events.find(e => e.event === 'delete');
    assert.equal(Object.values(deletion.durable.cases)[0].content, f.message.content);
    assert.equal(Object.values(deletion.durable.cases)[0].panelMessageId, 'panel');
    assert.equal(f.record().status, 'pending');
});
test('conserva el original si no hay registro privado, entrega o persistencia', async t => {
    for (const mode of ['noLog', 'publicLog', 'sendFails', 'diskFails', 'disabled']) {
        const f = fixture(t);
        if (mode === 'noLog') f.dependencies.getLog = async () => null;
        if (mode === 'publicLog') f.log.permissionsFor = () => ({ has: () => true });
        if (mode === 'sendFails') f.log.send = async () => { throw Error('offline'); };
        if (mode === 'diskFails') f.dependencies.store = { createCase() { throw Error('disk'); } };
        if (mode === 'disabled') f.dependencies.getConfig = () => ({ activo: false });
        assert.equal(await ejecutarCuarentena(f.message, { motivo: 'prueba' }, f.dependencies), false, mode);
        assert.ok(!f.events.some(e => e.event === 'delete'), mode);
    }
});
test('no borra adjuntos ni mensajes modificados después de analizar', async t => {
    for (const mode of ['attachments', 'edited']) {
        const f = fixture(t);
        if (mode === 'attachments') f.message.attachments.set('file', {});
        else f.original.messages.fetch = async () => ({ ...f.message, content: 'Nuevo texto' });
        await ejecutarCuarentena(f.message, {}, f.dependencies);
        assert.ok(!f.events.some(e => e.event === 'delete'));
    }
});
test('un panel persistente restaura tras reiniciar sin menciones y sin depender del embed', async t => {
    const f = fixture(t); await f.prepare();
    f.interaction.message.embeds = [{ fields: [{ name: '📝 Contenido Original', value: 'contenido falsificado' }] }];
    await manejarBotonCuarentena(f.interaction, crearAlmacenSeguridad(f.file));
    const restore = f.events.find(e => e.event === 'restore');
    assert.ok(restore.payload.content.includes(f.message.content));
    assert.deepEqual(restore.payload.allowedMentions, { parse: [] });
    assert.equal(f.record().status, 'restored');
});
test('restaura mensajes largos como archivo UTF-8 sin recortar caracteres', async t => {
    const f = fixture(t); f.message.content = '🔨'.repeat(1800); await f.prepare();
    await manejarBotonCuarentena(f.interaction, f.store);
    const restore = f.events.find(e => e.event === 'restore');
    assert.equal(restore.payload.files[0].attachment.toString('utf8'), f.message.content);
    assert.ok(restore.payload.content.length < 2000);
});
test('solo entrega el original al moderador mediante una respuesta privada', async t => {
    const f = fixture(t); await f.prepare(); f.interaction.customId = 'view_link_' + f.record().id;
    let deferred; f.interaction.deferReply = async payload => { deferred = payload; };
    await manejarBotonCuarentena(f.interaction, f.store);
    const response = f.events.at(-1).payload;
    assert.equal(response.files[0].attachment.toString('utf8'), f.message.content);
    assert.equal(deferred.flags, 64);
    assert.equal(f.record().status, 'pending');
    assert.ok(!f.events.some(e => e.event === 'restore'));
});
test('bloquea usuarios sin permisos, paneles copiados, antiguos, extranjeros y expirados', async t => {
    for (const mode of ['permissions', 'copied', 'guild', 'channel', 'author', 'old', 'expired']) {
        const f = fixture(t); await f.prepare();
        if (mode === 'permissions') f.original.permissionsFor = () => ({ has: () => false });
        if (mode === 'copied') f.interaction.message.id = 'copied';
        if (mode === 'guild') f.interaction.guildId = 'other';
        if (mode === 'channel') f.interaction.channelId = 'other';
        if (mode === 'author') f.interaction.message.author.id = 'other';
        if (mode === 'old') f.interaction.customId = 'approve_link_123456789';
        if (mode === 'expired') f.store.patchCase(f.record().id, { expiresAt: 1 });
        await manejarBotonCuarentena(f.interaction, f.store);
        assert.ok(!f.events.some(e => e.event === 'restore'), mode);
    }
});
test('dos decisiones concurrentes y clics posteriores no duplican la restauración', async t => {
    const f = fixture(t); await f.prepare();
    await Promise.all([manejarBotonCuarentena(f.interaction, f.store), manejarBotonCuarentena(f.interaction, f.store)]);
    await manejarBotonCuarentena(f.interaction, f.store);
    assert.equal(f.events.filter(e => e.event === 'restore').length, 1);
});
test('la denegación autorizada se conserva y no restaura', async t => {
    const f = fixture(t); await f.prepare(); f.interaction.customId = 'deny_link_' + f.record().id;
    await manejarBotonCuarentena(f.interaction, f.store);
    assert.equal(f.record().status, 'denied'); assert.ok(!f.events.some(e => e.event === 'restore'));
});
test('si falla el borrado no restaura una copia mientras el original exista', async t => {
    const f = fixture(t); f.message.delete = async () => { throw Error('missing permission'); };
    await f.prepare(); await manejarBotonCuarentena(f.interaction, f.store);
    assert.ok(!f.events.some(e => e.event === 'restore'));
});
test('recupera la copia durable si se borró pero falló la confirmación en disco', async t => {
    const f = fixture(t), originalTransition = f.store.transitionCase;
    f.store.transitionCase = (id, expected, patch) => { if (patch.status === 'pending') throw Error('disk'); return originalTransition(id, expected, patch); };
    await f.prepare(); assert.equal(f.record().status, 'deleting');
    await manejarBotonCuarentena(f.interaction, crearAlmacenSeguridad(f.file));
    assert.equal(f.record().status, 'restored');
});
test('un envío ambiguo no se reintenta y duplica automáticamente', async t => {
    const f = fixture(t); await f.prepare();
    f.original.send = async () => { throw Error('network timeout'); };
    await manejarBotonCuarentena(f.interaction, f.store);
    assert.equal(f.record().status, 'restoring');
    f.original.send = async () => { throw Error('should not retry'); };
    await manejarBotonCuarentena(f.interaction, f.store);
    assert.equal(f.record().status, 'restoring');
    f.interaction.customId = 'view_link_' + f.record().id;
    await manejarBotonCuarentena(f.interaction, f.store);
    assert.equal(f.events.at(-1).payload.files[0].attachment.toString('utf8'), f.message.content);
});
