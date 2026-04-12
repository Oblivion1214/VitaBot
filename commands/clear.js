// commands/clear.js
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { log } = require('../utils/logger');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('clear')
        .setDescription('Elimina mensajes y deja un registro de la limpieza.')
        .addIntegerOption(option =>
            option.setName('cantidad')
                .setDescription('Número de mensajes a borrar (1-100)')
                .setRequired(true)
                .setMinValue(1)
                .setMaxValue(100)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageMessages),

    async execute(interaction) {
        const cantidad = interaction.options.getInteger('cantidad');

        try {
            const borrados = await interaction.channel.bulkDelete(cantidad, true);

            const logEmbed = new EmbedBuilder()
                .setTitle('🧹 Limpieza de Canal')
                .setDescription(`Se han eliminado **${borrados.size}** mensajes de este canal.`)
                .addFields(
                    { name: 'Moderador', value: interaction.user.tag, inline: true },
                    { name: 'Cantidad solicitada', value: `${cantidad}`, inline: true }
                )
                .setColor('#5865F2')
                .setTimestamp()
                .setFooter({ text: 'VitaBot Logger 🔨' });

            await interaction.reply({
                content: `✅ Limpieza ejecutada. Se borraron ${borrados.size} mensajes.`,
                flags: MessageFlags.Ephemeral
            });

            await interaction.channel.send({ embeds: [logEmbed] });

            // Log de auditoría privado
            await log(interaction.guild, {
                categoria: 'moderacion',
                titulo: 'Limpieza de canal ejecutada',
                descripcion: `Se eliminaron mensajes del canal <#${interaction.channelId}>.`,
                campos: [
                    { name: '🗑️ Mensajes borrados', value: `${borrados.size}`, inline: true },
                    { name: '📋 Cantidad solicitada', value: `${cantidad}`, inline: true },
                    { name: '📌 Canal', value: `<#${interaction.channelId}>`, inline: true },
                ],
                usuario: interaction.user,
            });

        } catch (error) {
            console.error('[Clear Error]:', error);

            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Error en limpieza de canal',
                descripcion: `Ocurrió un error al intentar borrar mensajes.`,
                campos: [
                    { name: '📌 Canal', value: `<#${interaction.channelId}>`, inline: true },
                ],
                usuario: interaction.user,
                error: error.message,
            });

            const errorResponse = {
                content: '🚨 Hubo un error al intentar ejecutar la limpieza. Verifica mis permisos.',
                flags: MessageFlags.Ephemeral
            };

            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorResponse);
            } else {
                await interaction.reply(errorResponse);
            }
        }
    },
};