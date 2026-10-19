const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { obtenerSesionActiva, responderError } = require('../utils/interfazMusica');
const { formatearDuracion } = require('../audio/protocolo');
module.exports = {
    data: new SlashCommandBuilder().setName('audiostats').setDescription('Muestra el estado del audio actual.'),
    async execute(interaction) {
        try {
            const session = obtenerSesionActiva(interaction);
            const current = session.current;
            const embed = new EmbedBuilder().setTitle('🔊 Estado del audio').setColor('#C62828')
                .addFields(
                    { name: 'Estado', value: current?.started ? session.player.state.status : current ? 'Preparando audio' : 'En espera', inline: true },
                    { name: 'Formato de envío', value: `Opus · 48 kHz · estéreo · objetivo ${session.bitrate} kbps`, inline: true },
                    { name: 'Reproducción', value: formatearDuracion((current?.resource?.playbackDuration || 0) / 1000), inline: true },
                    { name: 'Cola', value: `${session.tracks.length} canciones pendientes`, inline: true })
                .setFooter({ text: 'La tasa indicada es el objetivo del codificador, no una medición de la fuente.' });
            return await interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        } catch (error) { return responderError(interaction, error); }
    },
};
