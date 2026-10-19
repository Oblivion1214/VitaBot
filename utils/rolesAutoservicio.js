const { PermissionFlagsBits: P, MessageFlags } = require('discord.js');
const { almacenSeguridad } = require('./almacenSeguridad');

// Only ordinary chat/voice capabilities may be distributed by self-service menus.
const ordinaryPermissions = ['ViewChannel', 'SendMessages', 'ReadMessageHistory', 'AddReactions', 'EmbedLinks',
    'AttachFiles', 'UseExternalEmojis', 'UseExternalStickers', 'UseApplicationCommands', 'Connect', 'Speak',
    'Stream', 'UseVAD', 'ChangeNickname', 'SendMessagesInThreads', 'CreatePublicThreads', 'CreatePrivateThreads',
    'UseSoundboard', 'UseExternalSounds', 'SendVoiceMessages', 'SendPolls'];
const allowed = ordinaryPermissions.reduce((mask, name) => mask | (P[name] || 0n), 0n);
function validarRolAutoservicio(guild, role, bot, creator) {
    if (!role || role.id === guild.id || role.managed || (role.permissions.bitfield & ~allowed) !== 0n) {
        throw Error('Solo puedo entregar roles de uso normal, sin permisos de administración o moderación.');
    }
    if (!bot.permissions.has(P.ManageRoles) || role.comparePositionTo(bot.roles.highest) >= 0 ||
        !creator.permissions.has(P.ManageRoles) ||
        (creator.id !== guild.ownerId && role.comparePositionTo(creator.roles.highest) >= 0)) {
        throw Error('Faltan permisos o el rol supera la jerarquía autorizada.');
    }
    for (const channel of guild.channels.cache.values()) {
        const overwrite = channel.permissionOverwrites?.cache.get(role.id);
        if (overwrite && (overwrite.allow.bitfield & ~allowed) !== 0n) {
            throw Error('Solo puedo entregar roles sin permisos de moderación en los canales.');
        }
    }
}
async function obtenerContextoRol(guild, roleId, creatorId) {
    const [role, bot, creator] = await Promise.all([
        guild.roles.fetch(roleId, { force: true }), guild.members.fetchMe({ force: true }),
        guild.members.fetch({ user: creatorId, force: true }),
    ]);
    // Fetch permissions as well as memberships: cached role bits may be stale after an edit.
    await Promise.all([guild.roles.fetch(), guild.channels.fetch()]);
    validarRolAutoservicio(guild, role, bot, creator); return { role, bot, creator };
}
const busy = new Set();
async function manejarRolAutoservicio(interaction, store = almacenSeguridad) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const key = `${interaction.guildId}:${interaction.user.id}`;
    if (busy.has(key)) return interaction.editReply('Espera a que termine tu cambio de rol.');
    busy.add(key);
    try {
        if (!interaction.guild || interaction.message?.author?.id !== interaction.client.user.id) throw Error('Panel no válido.');
        const panel = store.getPanel(interaction.message.id);
        const roleId = interaction.customId.slice('dar_rol_'.length);
        if (!panel || panel.guildId !== interaction.guildId || panel.channelId !== interaction.channelId || panel.roleId !== roleId) {
            throw Error('Este panel no está autorizado o expiró. Un administrador debe recrearlo con /roles.');
        }
        const { role } = await obtenerContextoRol(interaction.guild, roleId, panel.creatorId);
        const member = await interaction.guild.members.fetch({ user: interaction.user.id, force: true });
        if (member.roles.cache.has(roleId)) await member.roles.remove(roleId, 'Menú de autoservicio autorizado');
        else await member.roles.add(roleId, 'Menú de autoservicio autorizado');
        await interaction.editReply({ content: `✅ Rol actualizado: ${role.name}`, allowedMentions: { parse: [] } });
    } catch (error) {
        await interaction.editReply({ content: error.message?.startsWith('Este panel') || error.message?.startsWith('Solo puedo') ||
            error.message?.startsWith('Faltan permisos') ? error.message : 'No pude cambiar el rol. Revisa los permisos y recrea el panel si es antiguo.',
            allowedMentions: { parse: [] } });
    } finally { busy.delete(key); }
}
module.exports = { validarRolAutoservicio, obtenerContextoRol, manejarRolAutoservicio };
