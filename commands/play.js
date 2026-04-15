// commands/play.js — Sistema de Selección de Alta Fidelidad
const { 
    SlashCommandBuilder, 
    MessageFlags, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    EmbedBuilder 
} = require('discord.js');
const { useMainPlayer } = require('discord-player');
const { log, sanitizeErrorMessage } = require('../utils/logger');
const decirCmd = require('./decir.js'); //

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('play')
        .setDescription('Añade música a la cola con calidad 320kbps')
        .addStringOption(option =>
            option.setName('cancion')
                .setDescription('Nombre de la canción o enlace (YT/Spotify/YTMusic)')
                .setRequired(true)
        ),

    async execute(interaction) {
        const player = useMainPlayer();
        const canalVoz = interaction.member.voice.channel;

        // 1. BLOQUEOS DE SEGURIDAD
        if (decirCmd.enEjecucion.has(interaction.guildId)) {
            return interaction.reply({
                content: '⏳ **Vita está hablando:** No me interrumpas mientras recito, espera a que termine.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!canalVoz) {
            return interaction.reply({
                content: '❌ ¡Bájate de esa nube! Únete a un canal de voz si quieres que Graf Eisen suene.',
                flags: MessageFlags.Ephemeral
            });
        }

        const botChannel = interaction.guild.members.me.voice.channelId;
        if (botChannel && interaction.member.voice.channelId !== botChannel) {
            return interaction.reply({
                content: `⚠️ **Conflicto:** Ya estoy en <#${botChannel}>. No puedo estar en dos sitios a la vez.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply();
        const busqueda = interaction.options.getString('cancion');

        // Limpieza de conexiones ociosas de TTS
        if (decirCmd.conexionesTTS.has(interaction.guildId)) {
            const tts = decirCmd.conexionesTTS.get(interaction.guildId);
            clearTimeout(tts.timeout);
            tts.connection.destroy();
            decirCmd.conexionesTTS.delete(interaction.guildId);
        }

        // 2. BÚSQUEDA TÉCNICA
        const resultado = await player.search(busqueda, { requestedBy: interaction.user });

        if (!resultado || !resultado.tracks.length) {
            return interaction.editReply(`❌ No encontré nada para: **${busqueda}**. ¡Asegúrate de escribirlo bien!`);
        }

        // 3. LÓGICA DE MENÚ (Solo si es búsqueda por texto)
        if (!busqueda.startsWith('http')) {
            const topTracks = resultado.tracks.slice(0, 10); // Máximo 10 para el menú

            const menu = new StringSelectMenuBuilder()
                .setCustomId('musica_select')
                .setPlaceholder('🎵 Elige la pista correcta para Graf Eisen...')
                .addOptions(topTracks.map((t, i) => ({
                    label: `${i + 1}. ${t.title.substring(0, 80)}`,
                    description: `${t.author} | Duración: ${t.duration}`,
                    value: t.url,
                })));

            const fila = new ActionRowBuilder().addComponents(menu);
            
            const msg = await interaction.editReply({
                content: `🔍 **Resultados para:** \`${busqueda}\`\nSelecciona una opción del menú de abajo. Tienes 30 segundos.`,
                components: [fila]
            });

            const collector = msg.createMessageComponentCollector({
                filter: i => i.user.id === interaction.user.id,
                time: 30000
            });

            collector.on('collect', async i => {
                const trackElegida = topTracks.find(t => t.url === i.values[0]);
                
                await i.update({ content: `⌛ Procesando: **${trackElegida.title}**...`, components: [] });
                
                return await iniciarReproduccion(trackElegida, interaction, canalVoz, player);
            });

            collector.on('end', (collected, reason) => {
                if (reason === 'time' && collected.size === 0) {
                    interaction.editReply({ content: '❌ Se acabó el tiempo. Si no te decides, no hay música.', components: [] }).catch(() => null);
                }
            });

            return;
        }

        // 4. REPRODUCCIÓN DIRECTA (Si es un link)
        return await iniciarReproduccion(resultado.tracks[0], interaction, canalVoz, player);
    },
};

// FUNCIÓN AUXILIAR PARA DISPARAR EL STREAM
async function iniciarReproduccion(track, interaction, canalVoz, player) {
    try {
        const { queue } = await player.play(canalVoz, track, {
            nodeOptions: {
                metadata: { canal: interaction.channel },
                leaveOnEmpty: true,
                leaveOnEmptyCooldown: 5000,
                leaveOnEnd: true,
                volume: 50, // Calidad controlada 
                selfDeaf: true
            }
        });

        await log(interaction.guild, {
            categoria: 'musica',
            titulo: 'Pista añadida al Laboratorio',
            descripcion: `**[${track.title}](${track.url})** ha sido cargada correctamente.`,
            campos: [
                { name: '🎤 Autor', value: track.author, inline: true },
                { name: '⏱️ Duración', value: track.duration, inline: true }
            ],
            usuario: interaction.user,
        });

        await interaction.editReply(`✅ **${track.title}** añadida a la cola. ¡Disfruta del Hi-Fi!`);

    } catch (error) {
        console.error("Error al reproducir:", error);
        await interaction.editReply('❌ ¡Graf Eisen ha tenido un fallo técnico! No pude procesar esa canción.');
    }
}