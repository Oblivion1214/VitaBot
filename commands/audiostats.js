// commands/audiostats.js — Monitor de Audio Hi-Fi
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('audiostats')
        .setDescription('Muestra las métricas técnicas del flujo de audio actual.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);

        // 1. Verificación de estado
        if (!queue || !queue.isPlaying()) {
            return interaction.reply({ 
                content: '❌ No hay flujo de audio activo para analizar.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        const track = queue.currentTrack;
        const canalVoz = interaction.guild.members.me.voice.channel;
        
        // 2. Extracción de datos de audio en tiempo real
        const channelBitrate = canalVoz.bitrate / 1000;
        const voicePing = queue.connection?.ping?.udp ?? 0;
        const progress = queue.node.createProgressBar();

        // El bitrate real de salida sigue la lógica adaptativa de tu motor
        const outputBitrate = Math.min(channelBitrate, 256);

        // 3. Construcción del monitor visual
        const statsEmbed = new EmbedBuilder()
            .setTitle('📊 Monitor de Audio - Graf Eisen')
            .setColor(channelBitrate >= 96 ? '#00FF00' : '#E67E22') 
            .setThumbnail(track.thumbnail)
            .addFields(
                { 
                    name: '🎵 Pista Actual', 
                    value: `**[${track.title}](${track.url})**\n${progress}`, 
                    inline: false
                },
                { 
                    name: '📥 Fuente', 
                    value: '`Highest (Opus/WebM)`', 
                    inline: true 
                },
                { 
                    name: '📤 Salida', 
                    value: `\`${outputBitrate} kbps (Adaptativo)\``, 
                    inline: true 
                },
                { 
                    name: '🎧 Canal', 
                    value: `\`${channelBitrate} kbps\``, 
                    inline: true 
                },
                { 
                    name: '📶 Latencia UDP', 
                    value: `\`${voicePing}ms\``, 
                    inline: true 
                },
                { 
                    name: '⚙️ Motor de Audio', 
                    value: '`FFmpeg libopus`', 
                    inline: true 
                }
            )
            .setFooter({ 
                text: `VitaBot — Protocolo de Alta Fidelidad 🔨`, 
                iconURL: 'https://static.zerochan.net/Vita.1024.3831090.webp'
            })
            .setTimestamp();

        return interaction.reply({ embeds: [statsEmbed] });
    },
};