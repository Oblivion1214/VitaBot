// commands/play.js — Sistema de Selección de Alta Fidelidad y Enrutamiento Híbrido
const { 
    SlashCommandBuilder, 
    MessageFlags, 
    ActionRowBuilder, 
    StringSelectMenuBuilder, 
    EmbedBuilder 
} = require('discord.js');
const { useMainPlayer } = require('discord-player');
const { log, sanitizeErrorMessage } = require('../utils/logger');
const decirCmd = require('./decir.js'); 

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
                // Pasamos el track directamente
                return await iniciarReproduccion(trackElegida, interaction, canalVoz, player);
            });

            collector.on('end', (collected, reason) => {
                if (reason === 'time' && collected.size === 0) {
                    interaction.editReply({ content: '❌ Se acabó el tiempo. Si no te decides, no hay música.', components: [] }).catch(() => null);
                }
            });

            return;
        }

        // 4. REPRODUCCIÓN DIRECTA (Si es un link de YouTube o Spotify)
        return await iniciarReproduccion(resultado, interaction, canalVoz, player);
    },
};

// ─────────────────────────────────────────────────────────────────
// EL ENRUTADOR INTELIGENTE (Decide si usar PC o VM Fallback)
// ─────────────────────────────────────────────────────────────────
async function iniciarReproduccion(entidadAReproducir, interaction, canalVoz, player) {
    try {
        // 1. Extraer y empaquetar los datos de lo que vamos a reproducir (Track o Playlist)
        const esPlaylist = !!(entidadAReproducir?.playlist);
        let tracksParaEnviar = [];
        let trackTitle = '';
        let trackAuthor = '';

        if (esPlaylist) {
            trackTitle = entidadAReproducir.playlist.title;
            trackAuthor = entidadAReproducir.playlist.author?.name || 'YouTube';
            tracksParaEnviar = entidadAReproducir.tracks.map(t => ({ 
                url: t.url, title: t.title, author: t.author, duration: t.duration, thumbnail: t.thumbnail 
            }));
        } else if (entidadAReproducir.tracks && entidadAReproducir.tracks.length > 0) {
            // Resultado de búsqueda o link directo (solo el primero)
            const t = entidadAReproducir.tracks[0];
            trackTitle = t.title;
            trackAuthor = t.author;
            tracksParaEnviar = [{ url: t.url, title: t.title, author: t.author, duration: t.duration, thumbnail: t.thumbnail }];
        } else if (entidadAReproducir.url) {
            // Objeto Track directo (viene del menú de selección)
            trackTitle = entidadAReproducir.title;
            trackAuthor = entidadAReproducir.author;
            tracksParaEnviar = [{ 
                url: entidadAReproducir.url, title: entidadAReproducir.title, 
                author: entidadAReproducir.author, duration: entidadAReproducir.duration, 
                thumbnail: entidadAReproducir.thumbnail 
            }];
        }

        const nombreAMostrar = esPlaylist ? `la playlist **${trackTitle}**` : `**${trackTitle}**`;

        // 🌟 2. INTENTO PRINCIPAL: DELEGAR A LA PC LOCAL (Hi-Fi) vía Paquete JSON
        const payload = {
            guildId: interaction.guildId,
            voiceId: canalVoz.id,
            textChannelId: interaction.channel.id,
            tracks: tracksParaEnviar
        };

        try {
            // Petición HTTP a la PC local (Máximo 4 segundos de paciencia)
            const controller = new AbortController();
            const timeout = setTimeout(() => controller.abort(), 4000);

            const respuesta = await fetch(`http://100.127.221.32:3000/api/play`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(payload),
                signal: controller.signal
            });
            clearTimeout(timeout);

            if (!respuesta.ok) throw new Error(`Status ${respuesta.status}`);

            // ── ÉXITO EN LA PC: Armamos el panel bonito en la VM ──
            const primeraCancion = tracksParaEnviar[0];
            const embed = new EmbedBuilder()
                .setTitle(esPlaylist ? `💿 Playlist Añadida: ${trackTitle}` : '🎵 Añadido a la Cola')
                .setDescription(`**[${primeraCancion.title}](${primeraCancion.url})**\nAutor: ${primeraCancion.author}\n${esPlaylist ? `*Y ${tracksParaEnviar.length - 1} pistas más...*` : ''}`)
                .setFooter({ text: `Motor: 🏠 PC Local (Hi-Fi)` })
                .setColor('#00C853');

            if (primeraCancion.thumbnail) embed.setThumbnail(primeraCancion.thumbnail);

            await interaction.editReply({ content: '', embeds: [embed] });

            // Auditoría de éxito en la PC
            await log(interaction.guild, {
                categoria: 'musica',
                titulo: esPlaylist ? 'Colección Delegada a PC' : 'Pista Delegada a PC',
                descripcion: `${nombreAMostrar} procesada por la PC Local.`,
                campos: [
                    { name: '🎤 Pistas', value: `${tracksParaEnviar.length}`, inline: true },
                    { name: '💻 Motor', value: 'Windows (Tailscale)', inline: true }
                ],
                usuario: interaction.user,
            });

            return; // Terminamos aquí, la PC pone la música.

        } catch (errorPing) {
            // 🌟 3. FALLA LA PC -> MODO VM FALLBACK (Supervivencia a 32-64kbps)
            console.warn(`[Router] ⚠️ PC no disponible. Activando Fallback. Razón: ${errorPing.message}`);
            
            await interaction.editReply({ content: `⚠️ **[Fallback]** El servidor de musica no responde. Reproduciendo ${nombreAMostrar} desde la VM (Modo Emergencia Activado)...\n Si el audio dura mas de 2 minutos, se pueden experimentar problemas de calidad. Se aconseja no reproducir audios de mas de 2 minutos de duracion.`, embeds: [] });

            // Ejecuta el motor original de la VM
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
                    { name: '🎵 Pista/Playlist', value: trackTitle, inline: true },
                    { name: '📶 Calidad', value: `Reducida`, inline: true }
                ],
                usuario: interaction.user,
            });
        }

    } catch (errorCritico) {
        const errorLimpio = sanitizeErrorMessage(errorCritico.message);
        console.error('[Error de Audio]:', errorLimpio);

        await log(interaction.guild, {
            categoria: 'sistema',
            titulo: 'Fallo de Ingestión',
            descripcion: 'Graf Eisen no pudo procesar la fuente de audio en ningún motor.',
            error: errorLimpio,
            usuario: interaction.user
        }).catch(() => null);

        if (interaction.deferred || interaction.replied) {
            await interaction.editReply({ content: '❌ ¡Fallo crítico global! Ni la PC ni la VM pudieron reproducir la canción.', embeds: [] });
        }
    }
}