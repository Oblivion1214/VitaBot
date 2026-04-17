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
        return await iniciarReproduccion(resultado, interaction, canalVoz, player);
    },
};

// FUNCIÓN AUXILIAR REFORZADA Y UNIFICADA
async function iniciarReproduccion(entidadAReproducir, interaction, canalVoz, player) {
    try {
        // 1. DISPARAR LA REPRODUCCIÓNñ
        const { queue, track } = await player.play(canalVoz, entidadAReproducir, {
            nodeOptions: {
                // Sincronización de ID para el motor de audio adaptativo
                metadata: { canal: interaction.channel, guildId: interaction.guildId },
                leaveOnEmpty: true,
                leaveOnEmptyCooldown: 5000,
                leaveOnEnd: true,
                volume: 40, 
                selfDeaf: true
            }
        });

        // 2. LÓGICA DE DETECCIÓN (Evita el crash de .length)
        const esPlaylist = entidadAReproducir.playlist || false;
        // Calculamos la cantidad de forma segura
        const cantidadPistas = esPlaylist ? entidadAReproducir.tracks.length : 1;
        const nombreAMostrar = esPlaylist ? `la playlist **${entidadAReproducir.playlist.title}**` : `**${track.title}**`;

        // 3. AUDITORÍA SANITIZADA
        await log(interaction.guild, {
            categoria: 'musica',
            titulo: esPlaylist ? 'Colección Cargada' : 'Pista Cargada',
            descripcion: `${nombreAMostrar} ha sido inyectada en los circuitos de Graf Eisen.`,
            campos: [
                { name: '🎤 Autor/Canal', value: esPlaylist ? entidadAReproducir.playlist.author.name : track.author, inline: true },
                { name: '🔢 Cantidad', value: `${cantidadPistas} pistas`, inline: true },
                { name: '📶 Calidad', value: `Adaptativa (${canalVoz.bitrate / 1000}kbps)`, inline: true }
            ],
            usuario: interaction.user,
        });

        // 4. RESPUESTA FINAL AL USUARIO
        await interaction.editReply(`✅ ${nombreAMostrar} añadida a la cola. ¡Disfruta del audio Hi-Fi!`);

    } catch (error) {
        // Usamos el sanitizador para proteger las rutas de tu Windows Server
        const errorLimpio = sanitizeErrorMessage(error.message);
        console.error("[Error de Audio]:", errorLimpio);

        await log(interaction.guild, {
            categoria: 'sistema',
            titulo: 'Fallo de Ingestión',
            descripcion: 'Graf Eisen no pudo procesar la fuente de audio.',
            error: errorLimpio,
            usuario: interaction.user
        }).catch(() => null);

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply('❌ ¡Graf Eisen ha tenido un fallo técnico! No pude procesar la música.');
        }
    }
}