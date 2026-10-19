const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, PermissionFlagsBits: P } = require('discord.js');
const { almacenSeguridad } = require('./almacenSeguridad');
const { obtenerCanalLog, obtenerConfigServidor } = require('./logger');
const activeMessages = new Set(), activeDecisions = new Set();
function buttons(id) {
    return [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`view_link_${id}`).setLabel('Ver mensaje').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId(`approve_link_${id}`).setLabel('Aprobar y restaurar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deny_link_${id}`).setLabel('Confirmar eliminación').setStyle(ButtonStyle.Danger),
    )];
}
function puedeConservar(message) {
    return typeof message.content === 'string' && message.content.length > 0 && message.content.length <= 4000 &&
        !message.attachments?.size && !message.stickers?.size && !message.poll && !message.messageSnapshots?.size && !message.system;
}
async function currentMessage(channel, id) {
    try { return await channel.messages.fetch({ message: id, force: true }); }
    catch (error) { if (Number(error.code) === 10008) return null; throw error; }
}
async function ejecutarCuarentena(message, report, dependencies = {}) {
    const store = dependencies.store || almacenSeguridad;
    const getLog = dependencies.getLog || obtenerCanalLog;
    const getConfig = dependencies.getConfig || obtenerConfigServidor;
    if (!message.guild || activeMessages.has(message.id)) return false;
    activeMessages.add(message.id);
    let record, panel;
    try {
        const config = getConfig(message.guild.id);
        if (!config.activo || !config.categorias?.seguridad) return false;
        const channel = await getLog(message.guild);
        const bot = await message.guild.members.fetchMe({ force: true });
        if (!channel || channel.guildId !== message.guild.id ||
            channel.permissionsFor(message.guild.roles.everyone)?.has(P.ViewChannel) !== false ||
            !channel.permissionsFor(bot)?.has([P.ViewChannel, P.SendMessages, P.EmbedLinks, P.ReadMessageHistory])) return false;

        const fresh = await currentMessage(message.channel, message.id);
        if (!fresh || fresh.content !== message.content || fresh.editedTimestamp !== message.editedTimestamp || !puedeConservar(fresh) ||
            !message.channel.permissionsFor(bot)?.has([P.ViewChannel, P.ManageMessages, P.ReadMessageHistory])) {
            await channel.send({ content: '⚠️ Enlace sospechoso: el mensaje se conserva para revisión manual porque cambió o contiene elementos que no puedo restaurar íntegramente.',
                allowedMentions: { parse: [] } });
            return false;
        }
        record = store.createCase({ guildId: message.guild.id, channelId: message.channelId, originalMessageId: message.id,
            authorId: message.author.id, authorName: (message.author.tag || message.author.username || 'Usuario').slice(0, 100),
            content: fresh.content, editedTimestamp: fresh.editedTimestamp, reason: String(report.motivo || 'Amenaza detectada').slice(0, 300) });
        panel = await channel.send({ embeds: [new EmbedBuilder().setTitle('🛡️ Revisión de enlace')
            .setDescription('Se ha detectado un enlace sospechoso. Solo un moderador autorizado puede decidir. La copia recuperable se conserva durante 7 días.')
            .addFields({ name: 'Caso', value: record.id }, { name: 'Canal original', value: `<#${record.channelId}>` },
                { name: 'Motivo', value: record.reason })
            .setColor('#FFA500')], components: buttons(record.id), allowedMentions: { parse: [] } });
        store.transitionCase(record.id, 'prepared', { panelMessageId: panel.id, panelChannelId: channel.id, status: 'deleting' });
        // Check again after delivery: never remove a changed message using an older snapshot.
        const beforeDelete = await currentMessage(message.channel, message.id);
        if (!beforeDelete || beforeDelete.content !== record.content || beforeDelete.editedTimestamp !== record.editedTimestamp || !puedeConservar(beforeDelete)) {
            throw Error('El mensaje cambió durante la revisión.');
        }
        await beforeDelete.delete();
        // If this write fails, the durable 'deleting' record can be recovered after proving the original is absent.
        store.transitionCase(record.id, 'deleting', { status: 'pending' });
        return true;
    } catch {
        console.warn('[Cuarentena] Operación incompleta; se conserva el registro recuperable y no se repite el borrado.');
        if (panel && record) {
            // Leave its bound panel available: the handler verifies whether deletion actually happened.
            await panel.edit({ content: '⚠️ Operación incompleta. Revisa el mensaje original antes de decidir.', allowedMentions: { parse: [] } }).catch(() => null);
        }
        return false;
    } finally { activeMessages.delete(message.id); }
}
async function manejarBotonCuarentena(interaction, store = almacenSeguridad) {
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const match = /^(approve|deny|view)_link_([a-f0-9-]{36})$/.exec(interaction.customId);
    const id = match?.[2];
    if (!id || !interaction.guild || interaction.message?.author?.id !== interaction.client.user.id) {
        return interaction.editReply('Panel antiguo o no válido. No se ejecutó ninguna acción.');
    }
    if (activeDecisions.has(id)) return interaction.editReply('Este caso ya se está procesando.');
    activeDecisions.add(id);
    try {
        let record = store.getCase(id);
        if (!record || record.guildId !== interaction.guildId || record.panelMessageId !== interaction.message.id ||
            record.panelChannelId !== interaction.channelId) throw Error('Panel no autorizado, cerrado o expirado.');
        const [member, channel, reviewChannel] = await Promise.all([
            interaction.guild.members.fetch({ user: interaction.user.id, force: true }),
            interaction.guild.channels.fetch(record.channelId, { force: true }),
            interaction.guild.channels.fetch(record.panelChannelId, { force: true }),
            interaction.guild.roles.fetch(),
        ]);
        if (!channel || !channel.permissionsFor(member)?.has([P.ViewChannel, P.ManageMessages]) ||
            !reviewChannel?.permissionsFor(member)?.has([P.ViewChannel, P.ReadMessageHistory])) {
            throw Error('Necesitas Gestionar mensajes en el canal original y acceso al canal de revisión.');
        }
        if (record.status === 'deleting') {
            if (await currentMessage(channel, record.originalMessageId)) throw Error('El original sigue presente; no se restaurará una copia duplicada.');
            record = store.transitionCase(id, 'deleting', { status: 'pending' });
        }
        if (match[1] === 'view') {
            return interaction.editReply({ content: 'Copia original para revisión. Abrir este archivo de texto no confirma que sus enlaces sean seguros.',
                files: [{ attachment: Buffer.from(record.content, 'utf8'), name: 'mensaje-en-revision.txt' }], allowedMentions: { parse: [] } });
        }
        if (record.status !== 'pending') throw Error('Este caso ya tiene una decisión o requiere revisar una restauración incompleta.');
        if (match[1] === 'deny') {
            store.transitionCase(id, 'pending', { status: 'denied', decidedBy: member.id });
        } else {
            const bot = await interaction.guild.members.fetchMe({ force: true });
            if (!channel.permissionsFor(bot)?.has([P.ViewChannel, P.SendMessages]) ||
                (record.content.length > 1800 && !channel.permissionsFor(bot)?.has(P.AttachFiles))) {
                throw Error('Faltan permisos para restaurar el mensaje completo.');
            }
            store.transitionCase(id, 'pending', { status: 'restoring', decidedBy: member.id });
            const payload = { allowedMentions: { parse: [] }, content: `✅ Mensaje restaurado de ${record.authorName}:` };
            if (record.content.length <= 1800) payload.content += `\n${record.content}`;
            else payload.files = [{ attachment: Buffer.from(record.content, 'utf8'), name: 'mensaje-original.txt' }];
            const restored = await channel.send(payload);
            store.transitionCase(id, 'restoring', { status: 'restored', restoredMessageId: restored.id });
        }
        await interaction.message.edit({ content: match[1] === 'deny' ? '🛡️ Eliminación confirmada por un moderador.' : '✅ Mensaje restaurado por un moderador.', components: [], allowedMentions: { parse: [] } });
        await interaction.editReply('✅ Decisión guardada.');
    } catch (error) {
        const known = ['Panel no autorizado', 'Necesitas ', 'El original ', 'Este caso ', 'Faltan permisos'];
        await interaction.editReply({ content: known.some(prefix => error.message?.startsWith(prefix)) ? error.message
            : 'No pude completar la operación. La copia recuperable se conserva. Si la restauración quedó incompleta, revisa el canal antes de reintentarlo.',
            allowedMentions: { parse: [] } });
    } finally { activeDecisions.delete(id); }
}
module.exports = { ejecutarCuarentena, manejarBotonCuarentena, puedeConservar };
