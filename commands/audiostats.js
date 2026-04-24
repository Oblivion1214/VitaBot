// commands/audiostats.js — Monitor de Audio Hi-Fi / Fallback
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('audiostats')
        .setDescription('Muestra las métricas técnicas del flujo de audio actual.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);
        const botChannel = interaction.guild.members.me?.voice?.channelId;
        const canalVoz = interaction.guild.members.me?.voice?.channel;

        // 1. Verificación de estado global
        if (!queue && !botChannel) {
            return interaction.reply({ 
                content: '❌ No hay flujo de audio activo para analizar.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        // 2. MODO MÁQUINA VIRTUAL (Fallback activo)
        if (queue && queue.isPlaying()) {
            const track = queue.currentTrack;
            const channelBitrate = canalVoz ? canalVoz.bitrate / 1000 : 96;
            const voicePing = queue.connection?.ping?.udp ?? 0;
            const progress = queue.node.createProgressBar();
            const outputBitrate = Math.min(channelBitrate, 256);

            const statsEmbed = new EmbedBuilder()
                .setTitle('📊 Monitor de Audio - Graf Eisen (VM Fallback)')
                .setColor(channelBitrate >= 96 ? '#00FF00' : '#E67E22') 
                .setThumbnail(track.thumbnail)
                .addFields(
                    { name: '🎵 Pista Actual', value: `**[${track.title}](${track.url})**\n${progress}`, inline: false },
                    { name: '📥 Fuente', value: '`Highest (Opus/WebM)`', inline: true },
                    { name: '📤 Salida', value: `\`${outputBitrate} kbps (Adaptativo)\``, inline: true },
                    { name: '🎧 Canal', value: `\`${channelBitrate} kbps\``, inline: true },
                    { name: '📶 Latencia UDP', value: `\`${voicePing}ms\``, inline: true },
                    { name: '⚙️ Motor de Audio', value: '`VM Linux (discord-player)`', inline: true }
                )
                .setFooter({ text: `VitaBot — Protocolo de Supervivencia 🔨` })
                .setTimestamp();

            return interaction.reply({ embeds: [statsEmbed] });
        } 
        // 3. MODO PC LOCAL (Alta Fidelidad)
        else if (botChannel) {
            try {
                // Hacemos ping a la PC para pedirle sus métricas
                const response = await fetch(`http://100.127.221.32:3000/api/control?action=status`);
                const status = await response.json();

                if (status.error) throw new Error(status.error);

                // Calcular el tiempo activo a partir de los milisegundos
                const channelBitrate = canalVoz ? canalVoz.bitrate / 1000 : 96;
                const progress = queue.node.createProgressBar();
                const outputBitrate = Math.min(channelBitrate, 256);
                
                const statsEmbed = new EmbedBuilder()
                    .setTitle('📊 Monitor de Audio - Graf Eisen (Hi-Fi)')
                    .setColor('#00FF00')
                    .addFields(
                        { name: '🎵 Pista Actual', value: `**[${status.title}](${status.url})**\n${progress}`, inline: false },
                        { name: '📥 Fuente', value: '`Opus (Windows local)`', inline: true },
                        { name: '📤 Salida', value: `\`${outputBitrate} kbps (Adaptativo)\``, inline: true },
                        { name: '🎧 Canal', value: `\`${channelBitrate} kbps\``, inline: true },
                        { name: '⚙️ Motor de Audio', value: '`Tailscale Directo (PC)`', inline: true }
                    )
                    .setFooter({ text: `VitaBot — Protocolo de Alta Fidelidad 🔨` })
                    .setTimestamp();

                return interaction.reply({ embeds: [statsEmbed] });

            } catch (error) {
                return interaction.reply({ 
                    content: '❌ Error de telemetría: No me pude comunicar con el servidor de la PC local.', 
                    flags: MessageFlags.Ephemeral 
                });
            }
        }
    },
};