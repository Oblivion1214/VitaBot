// commands/play.js — Sistema de Selección de Alta Fidelidad
const http = require('http'); // ⬅️ AÑADE ESTA LÍNEA AQUÍ
const { 
    SlashCommandBuilder, 
    MessageFlags, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    EmbedBuilder 
} = require('discord.js');
const { useMainPlayer } = require('discord-player');
const { log, sanitizeErrorMessage } = require('../utils/logger');
const decirCmd = require('./decir.js'); // Importamos para gestionar conexiones TTS y evitar conflictos

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
            // Filtramos tracks sin URL válida para evitar opciones rotas en el menú
            const topTracks = resultado.tracks
                .filter(t => t.url && t.url.startsWith('http'))
                .slice(0, 10);

            if (!topTracks.length) {
                return interaction.editReply(`❌ No encontré resultados válidos para: **${busqueda}**.`);
            }

            const menu = new StringSelectMenuBuilder()
                .setCustomId('musica_select')
                .setPlaceholder('🎵 Elige la pista correcta para Graf Eisen...')
                .addOptions(topTracks.map((t, i) => ({
                    label: `${i + 1}. ${t.title.substring(0, 80)}`,
                    description: `${t.author.substring(0, 40)} | Duración: ${t.duration}`,
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
                // Pasamos el track directamente — iniciarReproduccion detecta que es un Track
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

// ─────────────────────────────────────────────────────────────────
// EL ENRUTADOR INTELIGENTE (Decide si usar PC o VM Fallback)
// ─────────────────────────────────────────────────────────────────
async function iniciarReproduccion(entidadAReproducir, interaction, canalVoz, player) {
    try {
        // 1. Extraer datos de lo que vamos a reproducir (Track o Playlist)
        const esPlaylist = !!(entidadAReproducir?.playlist);
        let urlParaPC = '';
        let trackTitle = '';
        let trackAuthor = '';
        let cantidadPistas = 1;

        if (esPlaylist) {
            urlParaPC = entidadAReproducir.playlist.url;
            trackTitle = entidadAReproducir.playlist.title;
            trackAuthor = entidadAReproducir.playlist.author?.name || 'YouTube';
            cantidadPistas = entidadAReproducir.tracks?.length || 1;
        } else if (entidadAReproducir.tracks && entidadAReproducir.tracks.length > 0) {
            urlParaPC = entidadAReproducir.tracks[0].url;
            trackTitle = entidadAReproducir.tracks[0].title;
            trackAuthor = entidadAReproducir.tracks[0].author;
        } else if (entidadAReproducir.url) {
            urlParaPC = entidadAReproducir.url;
            trackTitle = entidadAReproducir.title;
            trackAuthor = entidadAReproducir.author;
        }

        const nombreAMostrar = esPlaylist ? `la playlist **${trackTitle}**` : `**${trackTitle}**`;

        // 🌟 2. INTENTO PRINCIPAL: DELEGAR A LA PC LOCAL (Hi-Fi)
        // Le enviamos a la PC el título y el autor en la orden HTTP
        const pcOrdenUrl = `http://100.127.221.32:3000/api/play?url=${encodeURIComponent(urlParaPC)}&guildId=${interaction.guildId}&voiceId=${canalVoz.id}&bitrate=128&title=${encodeURIComponent(trackTitle)}&author=${encodeURIComponent(trackAuthor)}`;

        try {
            await _mandarOrdenAPC(pcOrdenUrl, 3000);

            // 🌟 FIX VISUAL: Construimos el Panel Bonito nosotros mismos
            let thumbnail = '';
            if (esPlaylist) thumbnail = entidadAReproducir.playlist.thumbnail;
            else if (entidadAReproducir.tracks && entidadAReproducir.tracks.length > 0) thumbnail = entidadAReproducir.tracks[0].thumbnail;
            else thumbnail = entidadAReproducir.thumbnail;

            const embed = new EmbedBuilder()
                .setTitle('🎵 Reproduciendo Ahora')
                .setDescription(`**[${trackTitle}](${urlParaPC})**\nAutor: ${trackAuthor}`)
                .setFooter({ text: `Motor: 🏠 PC Local (Lavalink Dedicado)` })
                .setColor('#00C853');

            if (thumbnail) embed.setThumbnail(thumbnail);

            await interaction.editReply({ content: '', embeds: [embed] });

            await log(interaction.guild, {
                categoria: 'musica',
                titulo: esPlaylist ? 'Colección Delegada a PC' : 'Pista Delegada a PC',
                descripcion: `${nombreAMostrar} procesada por la PC Local.`,
                campos: [
                    { name: '🎤 Autor', value: trackAuthor, inline: true },
                    { name: '💻 Motor', value: 'Windows (Dedicado)', inline: true }
                ],
                usuario: interaction.user,
            });

            return; // Termina la ejecución

        } catch (errorPing) {
            // 🌟 3. FALLA LA PC -> MODO VM FALLBACK (Supervivencia)
            console.warn(`[Router] ⚠️ PC no disponible. Activando Fallback. Razón: ${errorPing.message}`);
            
            await interaction.editReply(`⚠️ **[Fallback]** El servidor principal no responde. Reproduciendo ${nombreAMostrar} desde la VM (Modo Supervivencia a 32kbps)...`);

            // Arrancamos el discord-player en la VM
            const { queue, track } = await player.play(canalVoz, entidadAReproducir, {
                nodeOptions: {
                    metadata: { canal: interaction.channel, guildId: interaction.guildId },
                    leaveOnEmpty: true,
                    leaveOnEmptyCooldown: 5000,
                    leaveOnEnd: true,
                    volume: 40,
                    selfDeaf: true
                }
            });

            // Auditoría de Fallback
            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: '⚠️ VM Fallback Activado',
                descripcion: `Se usó la Máquina Virtual porque la PC no contestó.`,
                campos: [
                    { name: '🎵 Pista', value: track.title, inline: true },
                    { name: '📶 Calidad', value: `Reducida`, inline: true }
                ],
                usuario: interaction.user,
            });
        }

    } catch (errorCritico) {
        const errorLimpio = sanitizeErrorMessage(errorCritico.message);
        console.error('[Error de Audio]:', errorLimpio);

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply('❌ ¡Fallo crítico global! Ni la PC ni la VM pudieron reproducir la canción.');
        }
    }
}

// ─────────────────────────────────────────────────────────────────
// FUNCIÓN AUXILIAR PARA HABLAR CON LA PC POR TAILSCALE
// ─────────────────────────────────────────────────────────────────
function _mandarOrdenAPC(url, timeoutMs) {
    return new Promise((resolve, reject) => {
        const req = http.get(url, (res) => {
            if (res.statusCode === 200) resolve();
            else reject(new Error(`HTTP Status ${res.statusCode}`));
        });

        req.setTimeout(timeoutMs, () => {
            req.destroy();
            reject(new Error('Timeout de Tailscale'));
        });

        req.on('error', (err) => reject(err));
    });
}