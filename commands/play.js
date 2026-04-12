// commands/play.js
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { useMainPlayer } = require('discord-player');
const { log } = require('../utils/logger');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Añade una canción a la cola')
        .addStringOption(option =>
            option.setName('cancion')
                .setDescription('Nombre de la canción o enlace de YouTube/Spotify')
                .setRequired(true)
        ),

    async execute(interaction) {
        const player = useMainPlayer();
        const canalVoz = interaction.member.voice.channel;

        if (!canalVoz) {
            return interaction.reply({
                content: '❌ ¡Debes unirte a un canal de voz primero!',
                flags: MessageFlags.Ephemeral
            });
        }

        // VALIDACIÓN: Si el bot ya está ocupado en otro canal
        const botChannel = interaction.guild.members.me.voice.channelId;
        if (botChannel && interaction.member.voice.channelId !== botChannel) {
            return interaction.reply({
                content: `⚠️ **Conflicto de canal:** Ya estoy operando en <#${botChannel}>. Únete ahí para pedir música.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply();
        const busqueda = interaction.options.getString('cancion');

        const resultado = await player.search(busqueda, { requestedBy: interaction.user });
        console.log('[play] Resultado búsqueda:', resultado?.tracks?.length, 'tracks');

        if (!resultado || !resultado.tracks.length) {
            await log(interaction.guild, {
                categoria: 'musica',
                titulo: 'Búsqueda sin resultados',
                descripcion: `No se encontró ningún resultado para la búsqueda.`,
                campos: [
                    { name: '🔍 Búsqueda', value: busqueda, inline: false },
                    { name: '📢 Canal de voz', value: canalVoz.name, inline: true },
                ],
                usuario: interaction.user,
            });
            return interaction.editReply(`❌ No encontré nada para: **${busqueda}**`);
        }

        try {
            const { track } = await player.play(canalVoz, resultado, {
                nodeOptions: {
                    metadata: { canal: interaction.channel },
                    leaveOnEmpty: true,
                    leaveOnEmptyCooldown: 5000,
                    leaveOnEnd: false,
                    volume: 80,
                    selfDeaf: true
                }
            });

            await log(interaction.guild, {
                categoria: 'musica',
                titulo: 'Canción añadida a la cola',
                descripcion: `**[${track.title}](${track.url})** fue añadida a la cola de reproducción.`,
                campos: [
                    { name: '🎤 Artista', value: track.author, inline: true },
                    { name: '⏱️ Duración', value: track.duration, inline: true },
                    { name: '📢 Canal de voz', value: canalVoz.name, inline: true },
                ],
                usuario: interaction.user,
            });

            await interaction.editReply(`✅ **${track.title}** añadida a la cola.`);

        } catch (error) {
            console.error("Error al reproducir:", error);

            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Error al reproducir',
                descripcion: `Ocurrió un error al intentar reproducir una canción.`,
                campos: [
                    { name: '🔍 Búsqueda', value: busqueda, inline: false },
                ],
                usuario: interaction.user,
                error: sanitizeErrorMessage(error.message),
            });

            await interaction.editReply('❌ No pude reproducir esa canción. Revisa la consola para más detalles.');
        }
    },
};