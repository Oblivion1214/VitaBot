// commands/auditoria.js
const { 
    SlashCommandBuilder, PermissionFlagsBits, MessageFlags, 
    EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { obtenerConfigServidor, actualizarConfigServidor } = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('auditoria')
        .setDescription('Configura qué comandos se registran en el canal de auditoría')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        const config = obtenerConfigServidor(interaction.guild.id);

        // Menú de selección de categorías
        const menu = new StringSelectMenuBuilder()
            .setCustomId('auditoria_categorias')
            .setPlaceholder('Selecciona las categorías a auditar...')
            .setMinValues(0)
            .setMaxValues(4)
            .addOptions([
                {
                    label: '🎵 Música',
                    description: 'Audita comandos: play, stop',
                    value: 'musica',
                    default: config.categorias.musica,
                },
                {
                    label: '🛡️ Moderación',
                    description: 'Audita comandos: clear, roles',
                    value: 'moderacion',
                    default: config.categorias.moderacion,
                },
                {
                    label: '⚙️ General',
                    description: 'Audita comandos: ping, gacha, ppt, bola8, chatconvita',
                    value: 'general',
                    default: config.categorias.general,
                },
                {
                    label: '🚨 Sistema',
                    description: 'Audita errores críticos del bot',
                    value: 'sistema',
                    default: config.categorias.sistema,
                },
            ]);

        // Botón para activar/desactivar toda la auditoría
        const btnToggle = new ButtonBuilder()
            .setCustomId('auditoria_toggle')
            .setLabel(config.activo ? '🔴 Desactivar toda la auditoría' : '🟢 Activar toda la auditoría')
            .setStyle(config.activo ? ButtonStyle.Danger : ButtonStyle.Success);

        const btnGuardar = new ButtonBuilder()
            .setCustomId('auditoria_guardar')
            .setLabel('💾 Guardar cambios')
            .setStyle(ButtonStyle.Primary);

        const filaMenu = new ActionRowBuilder().addComponents(menu);
        const filaBotones = new ActionRowBuilder().addComponents(btnToggle, btnGuardar);

        const embed = construirEmbed(config);

        await interaction.reply({
            embeds: [embed],
            components: [filaMenu, filaBotones],
            flags: MessageFlags.Ephemeral
        });

        // Recolector para las interacciones del panel
        const collector = interaction.channel.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 120000 // 2 minutos
        });

        let categoriasSeleccionadas = Object.entries(config.categorias)
            .filter(([, v]) => v)
            .map(([k]) => k);

        collector.on('collect', async i => {
            if (i.customId === 'auditoria_categorias') {
                categoriasSeleccionadas = i.values;
                await i.deferUpdate();

            } else if (i.customId === 'auditoria_toggle') {
                config.activo = !config.activo;
                actualizarConfigServidor(interaction.guild.id, { activo: config.activo });

                btnToggle.setLabel(config.activo ? '🔴 Desactivar toda la auditoría' : '🟢 Activar toda la auditoría');
                btnToggle.setStyle(config.activo ? ButtonStyle.Danger : ButtonStyle.Success);

                await i.update({
                    embeds: [construirEmbed(obtenerConfigServidor(interaction.guild.id))],
                    components: [filaMenu, filaBotones],
                });

            } else if (i.customId === 'auditoria_guardar') {
                // Guardamos las categorías seleccionadas
                const nuevasCategorias = {
                    musica: categoriasSeleccionadas.includes('musica'),
                    moderacion: categoriasSeleccionadas.includes('moderacion'),
                    general: categoriasSeleccionadas.includes('general'),
                    sistema: categoriasSeleccionadas.includes('sistema'),
                };

                actualizarConfigServidor(interaction.guild.id, { categorias: nuevasCategorias });
                const configActualizada = obtenerConfigServidor(interaction.guild.id);

                await i.update({
                    embeds: [construirEmbed(configActualizada)],
                    components: [filaMenu, filaBotones],
                });

                await i.followUp({
                    content: '✅ Configuración de auditoría guardada correctamente.',
                    flags: MessageFlags.Ephemeral
                });
            }
        });

        collector.on('end', () => {
            // Desactivamos los componentes al terminar
            menu.setDisabled(true);
            btnToggle.setDisabled(true);
            btnGuardar.setDisabled(true);
            interaction.editReply({ components: [filaMenu, filaBotones] }).catch(() => null);
        });
    },
};

function construirEmbed(config) {
    const estado = config.activo ? '🟢 Activa' : '🔴 Desactivada';

    const campos = [
        { name: '🎵 Música', value: config.categorias.musica ? '✅ Auditando' : '❌ Ignorando', inline: true },
        { name: '🛡️ Moderación', value: config.categorias.moderacion ? '✅ Auditando' : '❌ Ignorando', inline: true },
        { name: '⚙️ General', value: config.categorias.general ? '✅ Auditando' : '❌ Ignorando', inline: true },
        { name: '🚨 Sistema', value: config.categorias.sistema ? '✅ Auditando' : '❌ Ignorando', inline: true },
    ];

    return new EmbedBuilder()
        .setTitle('⚙️ Configuración de Auditoría')
        .setDescription(`**Estado general:** ${estado}\n\nSelecciona las categorías que deseas auditar en el menú de abajo y presiona **Guardar cambios**.`)
        .addFields(campos)
        .setColor(config.activo ? '#57F287' : '#ED4245')
        .setTimestamp()
        .setFooter({ text: 'VitaBot Logger 🔨 — Este panel expira en 2 minutos' });
}