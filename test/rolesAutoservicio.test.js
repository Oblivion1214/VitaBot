const test = require('node:test');
const assert = require('node:assert/strict');
const { PermissionsBitField, PermissionFlagsBits: P } = require('discord.js');
const { validarRolAutoservicio, manejarRolAutoservicio } = require('../utils/rolesAutoservicio');
const permissions = bits => new PermissionsBitField(bits);
function fixture() {
    const events = [];
    const bot = { permissions: permissions(P.ManageRoles), roles: { highest: { position: 10 } } };
    const creator = { id: 'creator', permissions: permissions(P.ManageRoles), roles: { highest: { position: 8 } } };
    const role = { id: 'role', name: 'Comunidad', permissions: permissions(P.ViewChannel), managed: false,
        comparePositionTo: other => 2 - other.position };
    const member = { roles: { cache: new Set(), add: async id => events.push(id), remove: async id => events.push('-' + id) } };
    const guild = { id: 'guild', ownerId: 'owner', channels: { cache: new Map(), fetch: async () => {} }, roles: { fetch: async () => role }, members: {
        fetchMe: async () => bot, fetch: async ({ user }) => user === 'creator' ? creator : member } };
    const interaction = { guild, guildId: guild.id, channelId: 'channel', user: { id: 'member' }, client: { user: { id: 'bot' } },
        message: { id: 'panel', author: { id: 'bot' } }, customId: 'dar_rol_role',
        deferReply: async () => {}, editReply: async payload => events.push(payload) };
    const panel = { guildId: 'guild', channelId: 'channel', creatorId: 'creator', roleId: 'role' };
    return { events, guild, role, bot, creator, member, interaction, panel, store: { getPanel: () => panel } };
}
test('bloquea roles administradores, moderadores, integraciones y everyone', () => {
    const f = fixture();
    for (const bit of [P.Administrator, P.ManageRoles, P.ManageChannels, P.ManageWebhooks, P.MentionEveryone, P.ModerateMembers, P.KickMembers]) {
        f.role.permissions = permissions(bit); assert.throws(() => validarRolAutoservicio(f.guild, f.role, f.bot, f.creator), /roles de uso normal/);
    }
    f.role.permissions = permissions(0n); f.role.managed = true;
    assert.throws(() => validarRolAutoservicio(f.guild, f.role, f.bot, f.creator));
    f.role.managed = false; f.role.id = 'guild'; assert.throws(() => validarRolAutoservicio(f.guild, f.role, f.bot, f.creator));
});
test('comprueba permiso y jerarquía del creador y del bot', () => {
    for (const who of ['bot', 'creator']) {
        const f = fixture(); f[who].roles.highest.position = 1;
        assert.throws(() => validarRolAutoservicio(f.guild, f.role, f.bot, f.creator), /jerarquía/);
        f[who].roles.highest.position = 10; f[who].permissions = permissions(0n);
        assert.throws(() => validarRolAutoservicio(f.guild, f.role, f.bot, f.creator), /permisos/);
    }
});
test('un overwrite de canal tampoco puede convertir el rol en moderador', async () => {
    const f = fixture();
    f.guild.channels.cache.set('secret', { permissionOverwrites: { cache: new Map([['role', { allow: permissions(P.ManageMessages) }]]) } });
    await manejarRolAutoservicio(f.interaction, f.store);
    assert.ok(!f.events.includes('role'));
});
test('un miembro normal puede añadir y quitar un rol autorizado', async () => {
    const f = fixture(); await manejarRolAutoservicio(f.interaction, f.store);
    assert.equal(f.events[0], 'role');
    f.member.roles.cache.add('role'); await manejarRolAutoservicio(f.interaction, f.store);
    assert.ok(f.events.includes('-role'));
});
test('revalida los permisos del rol y del creador después de publicar el panel', async () => {
    for (const mutate of [f => f.role.permissions = permissions(P.Administrator), f => f.creator.permissions = permissions(0n)]) {
        const f = fixture(); mutate(f); await manejarRolAutoservicio(f.interaction, f.store);
        assert.ok(!f.events.includes('role'));
    }
});
test('rechaza paneles antiguos, ajenos, copiados y sin servidor', async () => {
    for (const mutate of [f => f.panel.guildId = 'other', f => f.panel.channelId = 'other', f => f.panel.roleId = 'other',
        f => f.store.getPanel = () => null, f => f.interaction.message.author.id = 'other', f => f.interaction.guild = null]) {
        const f = fixture(); mutate(f); await manejarRolAutoservicio(f.interaction, f.store); assert.ok(!f.events.includes('role'));
    }
});
