// utils/musicButtons.js — VitaBot
// Manejador de botones de música: pausa, salto, stop, shuffle, cola y letras

const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { limpiarParaLyrics } = require('./musicPlayer');

/**
 * Procesa todas las interacciones de botones con prefijo "musica_".
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {import('discord-player').Player} player
 */
async function manejarBotonesMusica(interaction, player) {
    const queue = player.nodes.get(interaction.guildId);

    // Sin cola activa, el botón es un zombi
    if (!queue) {
        return interaction.reply({
            content: '❌ No hay música activa en este momento.',
            flags: MessageFlags.Ephemeral
        });
    }

    // Validación de sesión: evita que botones viejos afecten la sesión actual.
    // ⚠️ Los botones de paginación (musica_queue_page_) están EXENTOS:
    //    vienen del embed efímero de la cola, no del embed de "Reproduciendo Ahora",
    //    por lo que su message.id nunca coincidirá con ultimoMensaje.id.
    const esPaginacion = interaction.customId.startsWith('musica_queue_page_');
    if (!esPaginacion && queue.metadata?.ultimoMensaje && interaction.message.id !== queue.metadata.ultimoMensaje.id) {
        return interaction.reply({
            content: '⚠️ Este panel de control es de una canción antigua. Usa el mensaje más reciente.',
            flags: MessageFlags.Ephemeral
        });
    }

    try {
        // ── ⏯️ PAUSA / REANUDAR ──
        if (interaction.customId === 'musica_pausa') {
            queue.node.setPaused(!queue.node.isPaused());
            return interaction.reply({
                content: queue.node.isPaused() ? '⏸️ Música pausada.' : '▶️ Música reanudada.',
                flags: MessageFlags.Ephemeral
            });
        }

        // ── ⏭️ SALTAR PISTA ──
        if (interaction.customId === 'musica_salto') {
            queue.node.skip();
            return interaction.reply({
                content: '⏭️ Saltando a la siguiente pista.',
                flags: MessageFlags.Ephemeral
            });
        }

        // ── ⏹️ DETENER Y LIMPIAR ──
        if (interaction.customId === 'musica_stop') {
            if (queue.metadata?.ultimoMensaje) {
                await queue.metadata.ultimoMensaje.edit({ components: [] }).catch(() => null);
            }
            queue.delete();
            return interaction.reply({
                content: '🛑 Sesión finalizada.',
                flags: MessageFlags.Ephemeral
            });
        }

        // ── 🔀 MEZCLAR COLA ──
        if (interaction.customId === 'musica_shuffle') {
            if (queue.tracks.size < 2) {
                return interaction.reply({
                    content: '⚠️ No hay suficientes canciones en la cola para mezclar.',
                    flags: MessageFlags.Ephemeral
                });
            }
            queue.tracks.shuffle();
            return interaction.reply({
                content: '🔀 **Modo aleatorio:** La cola de reproducción ha sido mezclada con éxito.',
                flags: MessageFlags.Ephemeral
            });
        }

        // ── 📜 VER COLA (CON PAGINACIÓN) ──
        if (interaction.customId === 'musica_queue' || interaction.customId.startsWith('musica_queue_page_')) {
            const currentTrack = queue.currentTrack;
            const tracks = queue.tracks.toArray();

            const TRACKS_POR_PAGINA = 10;
            const totalPaginas = Math.max(1, Math.ceil(tracks.length / TRACKS_POR_PAGINA));

            // Extraer página actual del customId (musica_queue_page_2) o usar 0
            let paginaActual = 0;
            if (interaction.customId.startsWith('musica_queue_page_')) {
                paginaActual = parseInt(interaction.customId.replace('musica_queue_page_', '')) || 0;
            }
            paginaActual = Math.max(0, Math.min(paginaActual, totalPaginas - 1));

            const inicio = paginaActual * TRACKS_POR_PAGINA;
            const tracksPagina = tracks.slice(inicio, inicio + TRACKS_POR_PAGINA);

            let listado = tracksPagina.map((track, i) => {
                const tituloSeguro = track.title.replace(/[\[\]]/g, '');
                const tituloRecortado = tituloSeguro.length > 70 ? tituloSeguro.substring(0, 67) + '...' : tituloSeguro;
                return `**${inicio + i + 1}.** [${tituloRecortado}](${track.url}) - \`${track.duration}\``;
            }).join('\n');

            if (listado.length > 1000) listado = listado.substring(0, 997) + '...';

            const queueEmbed = new EmbedBuilder()
                .setTitle(`🎼 Cola de Reproducción — ${interaction.guild.name}`)
                .setColor('#FF9900')
                .setThumbnail(currentTrack.thumbnail)
                .addFields(
                    {
                        name: '▶️ Reproduciendo Ahora',
                        value: `**[${currentTrack.title.replace(/[\[\]]/g, '')}](${currentTrack.url})**\nAutor: \`${currentTrack.author}\``,
                        inline: false
                    },
                    {
                        name: `⏭️ Próximas Canciones (página ${paginaActual + 1}/${totalPaginas})`,
                        value: listado || '_No hay más canciones en la cola._',
                        inline: false
                    }
                )
                .setFooter({
                    text: `Total: ${tracks.length} canciones | ${queue.durationFormatted || 'calculando...'} restantes`
                })
                .setTimestamp();

            // Botones de paginación — solo se muestran si hay más de una página
            const componentes = [];
            if (totalPaginas > 1) {
                const filaPaginacion = new ActionRowBuilder().addComponents(
                    new ButtonBuilder()
                        .setCustomId(`musica_queue_page_${paginaActual - 1}`)
                        .setEmoji('◀️')
                        .setLabel('Anterior')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(paginaActual === 0),
                    new ButtonBuilder()
                        .setCustomId(`musica_queue_page_${paginaActual + 1}`)
                        .setEmoji('▶️')
                        .setLabel('Siguiente')
                        .setStyle(ButtonStyle.Secondary)
                        .setDisabled(paginaActual >= totalPaginas - 1)
                );
                componentes.push(filaPaginacion);
            }

            // Paginación: deferUpdate() + editReply() en lugar de update().
            // interaction.update() solo funciona en mensajes normales, NO en efímeros.
            // deferUpdate() le dice a Discord "recibí el clic" sin responder todavía,
            // y luego editReply() actualiza el mensaje efímero con el nuevo contenido.
            if (interaction.customId.startsWith('musica_queue_page_')) {
                await interaction.deferUpdate();
                return interaction.editReply({ embeds: [queueEmbed], components: componentes });
            }
            return interaction.reply({ embeds: [queueEmbed], components: componentes, flags: MessageFlags.Ephemeral });
        }

        // ── 🎤 VER LETRAS ──
        if (interaction.customId === 'musica_lyrics') {
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });

            try {
                const currentTrack = queue.currentTrack;
                const tituloLimpio = limpiarParaLyrics(currentTrack.title, currentTrack.author);

                console.log(`[Genius] Buscando: ${tituloLimpio} - ${currentTrack.author}`);
                const searches = await interaction.client.genius.songs.search(
                    `${tituloLimpio} ${currentTrack.author}`
                );

                const firstSong = searches[0];
                if (!firstSong) {
                    return interaction.editReply(`❌ No encontré letras para: **${tituloLimpio}**.`);
                }

                const lyrics = await firstSong.lyrics();

                const lyricsEmbed = new EmbedBuilder()
                    .setTitle(`🎤 Letras: ${firstSong.title}`)
                    .setAuthor({ name: firstSong.artist.name })
                    .setThumbnail(currentTrack.thumbnail)
                    .setDescription(lyrics.length > 4096 ? lyrics.substring(0, 4090) + '...' : lyrics)
                    .setColor('#FF9900')
                    .setFooter({ text: 'Powered by Genius API & VitaBot 🔨' });

                return interaction.editReply({ embeds: [lyricsEmbed] });

            } catch (e) {
                console.error('[Genius Error]:', e.message);
                return interaction.editReply('❌ No se pudo obtener la letra en este momento.');
            }
        }

    } catch (e) {
        console.error('[Button Error]:', e.message);
    }
}

module.exports = { manejarBotonesMusica };