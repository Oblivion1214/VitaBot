// commands/audiostats.js — Monitor de Alta Fidelidad para Vita Graf Eisen
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('audiostats')
        .setDescription('Muestra las estadísticas técnicas reales del flujo de audio actual.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);

        // 1. Verificación de estado
        if (!queue || !queue.isPlaying()) {
            return interaction.reply({ 
                content: '❌ No hay música activa en este momento para analizar.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const track = queue.currentTrack;
        const canalVoz = interaction.guild.members.me.voice.channel;
        
        // 2. Extracción de datos dinámicos
        // El bitrate del canal viene en bps, lo pasamos a kbps
        const channelBitrate = canalVoz.bitrate / 1000;
        const voicePing = queue.connection.ping.udp || 0;

        // 3. Configuración de salida (Basada en tu index.js)
        const outputBitrate = 320; // Forzado por FFmpeg en tu index.js

        // 4. Construcción del monitor visual
        const statsEmbed = new EmbedBuilder()
            .setTitle('📊 Monitor de Alta Fidelidad - Graf Eisen')
            // Cambia a verde si el canal soporta al menos 96kbps (Standard Hi-Fi)
            .setColor(channelBitrate >= 96 ? '#00FF00' : '#E67E22') 
            .setThumbnail(track.thumbnail)
            .addFields(
                { 
                    name: '🎵 Fuente de Audio', 
                    value: `**${track.title}**\n*Vía: ${track.author}*`, 
                    inline: false 
                },
                { 
                    name: '📥 Captura del Host', 
                    value: '`highestaudio (Opus/WebM)`', 
                    inline: true 
                },
                { 
                    name: '📤 Stream de Salida', 
                    value: `\`${outputBitrate} kbps (CBR)\``, 
                    inline: true 
                },
                { 
                    name: '🎧 Límite del Canal', 
                    value: `\`${channelBitrate} kbps\``, 
                    inline: true 
                },
                { 
                    name: '📶 Latencia (UDP)', 
                    value: `\`${voicePing}ms\``, 
                    inline: true 
                },
                { 
                    name: '⚙️ Motor de Audio', 
                    value: '`FFmpeg libopus`', 
                    inline: true 
                },
                { 
                    name: '🛡️ Estado del Buffer', 
                    value: '`32MB (HighWaterMark)`', 
                    inline: true 
                }
            )
            .setFooter({ 
                text: `Host: Windows Server 2025 | RAM: 31GB | Ubicación: Toluca/Metepec` 
            }) //
            .setTimestamp();

        return interaction.reply({ embeds: [statsEmbed] });
    },
};