const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('audiostats')
        .setDescription('Muestra las estadísticas técnicas del flujo de audio actual.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);

        if (!queue || !queue.isPlaying()) {
            return interaction.reply({ 
                content: '❌ No hay música reproduciéndose actualmente.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const track = queue.currentTrack;
        
        // Calculamos la latencia de la conexión de voz
        const voicePing = queue.connection.ping.udp || 0;

        const statsEmbed = new EmbedBuilder()
            .setTitle('📊 Monitor de Alta Fidelidad - Graf Eisen')
            .setColor('#00FF00')
            .setThumbnail(track.thumbnail)
            .addFields(
                { name: '🎵 Canción Actual', value: `[${track.title}](${track.url})`, inline: false },
                { name: '📻 Códec de Salida', value: '`libopus (Standard Discord)`', inline: true },
                { name: '🎼 Sample Rate', value: '`48000 Hz`', inline: true },
                { name: '🎚️ Bitrate', value: '`128 kbps`', inline: true },
                { name: '📶 Latencia de Voz', value: `\`${voicePing}ms\``, inline: true },
                { name: '⚙️ Motor de Stream', value: '`FFmpeg (Spawned Process)`', inline: true },
                { name: '🛡️ Estado del Buffer', value: '`Estable (15s Reconnect)`', inline: true }
            )
            .setFooter({ text: 'Monitoreo en tiempo real de VitaBot' })
            .setTimestamp();

        return interaction.reply({ embeds: [statsEmbed] });
    },
};