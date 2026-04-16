// commands/clear.js — Sistema de Limpieza con Auditoría Sanitizada
const { SlashCommandBuilder, PermissionFlagsBits, MessageFlags, EmbedBuilder } = require('discord.js');
const { log, sanitizeErrorMessage } = require('../utils/logger'); //

module.exports = {
    cooldown: 10,
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
        // Usamos la propiedad channel directamente de la interacción
        const canal = interaction.channel; 

        // 1. VALIDACIÓN DE CANAL: Evita el error 'reading bulkDelete of null'
        // Esto es crítico si el bot no tiene el scope 'bot' correctamente configurado
        if (!canal || typeof canal.bulkDelete !== 'function') {
            return interaction.reply({
                content: '❌ Error técnico: No puedo acceder a las funciones de limpieza en este canal.',
                flags: MessageFlags.Ephemeral
            }).catch(() => null);
        }

        try {
            // 2. EJECUCIÓN DE LIMPIEZA
            // El flag 'true' filtra mensajes de más de 14 días (límite de la API de Discord)
            const borrados = await canal.bulkDelete(cantidad, true);

            // 3. RESPUESTA AL USUARIO
            await interaction.reply({
                content: `✅ Limpieza ejecutada. Se borraron **${borrados.size}** mensajes correctamente.`,
                flags: MessageFlags.Ephemeral
            });

            // 4. LOG DE CANAL (Público/Moderación)
            const logEmbed = new EmbedBuilder()
                .setTitle('🧹 Limpieza de Canal')
                .setDescription(`Se han eliminado **${borrados.size}** mensajes de este canal.`)
                .addFields(
                    { name: 'Moderador', value: interaction.user.tag, inline: true },
                    { name: 'Cantidad solicitada', value: `${cantidad}`, inline: true }
                )
                .setColor('#5865F2')
                .setTimestamp()
                .setFooter({ text: 'VitaBot Shield 🔨' });

            // Enviamos el aviso al canal, fallando silenciosamente si no hay permisos
            await canal.send({ embeds: [logEmbed] }).catch(() => null);

            // 5. LOG DE AUDITORÍA PRIVADO (Usa logger.js)
            await log(interaction.guild, {
                categoria: 'moderacion',
                titulo: 'Limpieza de canal ejecutada',
                descripcion: `Acción de limpieza realizada en el canal <#${canal.id}>.`,
                campos: [
                    { name: '🗑️ Mensajes borrados', value: `${borrados.size}`, inline: true },
                    { name: '📋 Cantidad solicitada', value: `${cantidad}`, inline: true },
                    { name: '📌 ID Canal', value: `\`${canal.id}\``, inline: true },
                ],
                usuario: interaction.user,
            });

        } catch (error) {
            console.error('[Clear Error]:', error);

            // Reporte de error al sistema de auditoría con sanitización de rutas
            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Error en limpieza de canal',
                descripcion: `Fallo al intentar ejecutar bulkDelete en el servidor.`,
                usuario: interaction.user,
                error: sanitizeErrorMessage(error.message), //
            }).catch(() => null);

            const errorResponse = {
                content: '🚨 Hubo un error al intentar ejecutar la limpieza. Verifica mis permisos (Gestionar Mensajes).',
                flags: MessageFlags.Ephemeral
            };

            // Manejo seguro de respuestas para evitar "Unknown Interaction"
            if (interaction.replied || interaction.deferred) {
                await interaction.followUp(errorResponse).catch(() => null);
            } else {
                await interaction.reply(errorResponse).catch(() => null);
            }
        }
    },
};