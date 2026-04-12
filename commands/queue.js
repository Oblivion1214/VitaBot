const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Muestra la lista de canciones próximas en la cola.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);

        // 1. Verificación de existencia de música
        if (!queue || !queue.isPlaying()) {
            return interaction.reply({ 
                content: '❌ No hay música reproduciéndose actualmente.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        // 2. Obtener la canción actual y la lista de canciones (primeras 10 para no saturar)
        const currentTrack = queue.currentTrack;
        const tracks = queue.tracks.toArray(); // Convierte la cola a un Array manejable
        const nextSongs = tracks.slice(0, 10); // Tomamos solo las primeras 10

        // 3. Formatear la lista de canciones
        const listado = nextSongs.map((track, i) => {
            return `**${i + 1}.** [${track.title}](${track.url}) - \`${track.duration}\``;
        }).join('\n');

        // 4. Construir el Embed con estética de alta fidelidad
        const queueEmbed = new EmbedBuilder()
            .setTitle(`🎼 Cola de Reproducción - ${interaction.guild.name}`)
            .setColor('#FF9900')
            .setThumbnail(currentTrack.thumbnail)
            .addFields(
                { 
                    name: '▶️ Reproduciendo Ahora', 
                    value: `**[${currentTrack.title}](${currentTrack.url})**\nAutor: \`${currentTrack.author}\` | Pedida por: ${currentTrack.requestedBy}`, 
                    inline: false 
                },
                { 
                    name: '⏭️ Próximas Canciones', 
                    value: listado || '_No hay más canciones en la cola._', 
                    inline: false 
                }
            )
            .setFooter({ 
                text: `Total de canciones: ${tracks.length} | Tiempo total: ${queue.durationFormatted}` 
            })
            .setTimestamp();

        // 5. Si hay más de 10 canciones, avisamos en el footer
        if (tracks.length > 10) {
            queueEmbed.setFooter({ 
                text: `+${tracks.length - 10} canciones más... | Tiempo total: ${queue.durationFormatted} 🔨` 
            });
        }

        return interaction.reply({ embeds: [queueEmbed] });
    },
};