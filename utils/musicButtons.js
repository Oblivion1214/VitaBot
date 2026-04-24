// utils/musicButtons.js — VitaBot
// Manejador de botones de música Híbrido: Controla tanto la VM como la PC Local

const { EmbedBuilder, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { limpiarParaLyrics } = require('./musicPlayer');

/**
 * Procesa todas las interacciones de botones con prefijo "musica_".
 * @param {import('discord.js').ButtonInteraction} interaction
 * @param {import('discord-player').Player} player
 */
async function manejarBotonesMusica(interaction, player) {
    const queue = player.nodes.get(interaction.guildId);
    const botChannel = interaction.guild.members.me?.voice?.channelId;

    // 1. Verificación global: Si no hay cola y el bot no está en voz, el botón es un zombi
    if (!queue && !botChannel) {
        return interaction.reply({
            content: '❌ No hay música activa en este momento.',
            flags: MessageFlags.Ephemeral
        });
    }

    const esPaginacion = interaction.customId.startsWith('musica_queue_page_');

    // ─────────────────────────────────────────────
    // MODO 1: MÁQUINA VIRTUAL (Fallback activo)
    // ─────────────────────────────────────────────
    if (queue && queue.isPlaying()) {
        
        // Validación de sesión para botones viejos
        if (!esPaginacion && queue.metadata?.ultimoMensaje && interaction.message.id !== queue.metadata.ultimoMensaje.id) {
            return interaction.reply({
                content: '⚠️ Este panel de control es de una canción antigua. Usa el mensaje más reciente.',
                flags: MessageFlags.Ephemeral
            });
        }

        try {
            // ── ⏯️ PAUSA / REANUDAR (VM) ──
            if (interaction.customId === 'musica_pausa') {
                queue.node.setPaused(!queue.node.isPaused());
                return interaction.reply({
                    content: queue.node.isPaused() ? '⏸️ Música pausada (VM).' : '▶️ Música reanudada (VM).',
                    flags: MessageFlags.Ephemeral
                });
            }

            // ── ⏭️ SALTAR PISTA (VM) ──
            if (interaction.customId === 'musica_salto') {
                queue.node.skip();
                return interaction.reply({ content: '⏭️ Saltando a la siguiente pista (VM).', flags: MessageFlags.Ephemeral });
            }

            // ── ⏹️ DETENER Y LIMPIAR (VM) ──
            if (interaction.customId === 'musica_stop') {
                if (queue.metadata?.ultimoMensaje) {
                    await queue.metadata.ultimoMensaje.edit({ components: [] }).catch(() => null);
                }
                queue.delete();
                return interaction.reply({ content: '🛑 Sesión finalizada (VM).', flags: MessageFlags.Ephemeral });
            }

            // ── 🔀 MEZCLAR COLA (VM) ──
            if (interaction.customId === 'musica_shuffle') {
                if (queue.tracks.size < 2) {
                    return interaction.reply({ content: '⚠️ No hay suficientes canciones en la cola para mezclar.', flags: MessageFlags.Ephemeral });
                }
                queue.tracks.shuffle();
                return interaction.reply({ content: '🔀 Cola mezclada con éxito (VM).', flags: MessageFlags.Ephemeral });
            }

            // ── 📜 VER COLA PAGINADA (VM) ──
            if (interaction.customId === 'musica_queue' || esPaginacion) {
                const currentTrack = queue.currentTrack;
                const tracks = queue.tracks.toArray();

                const TRACKS_POR_PAGINA = 10;
                const totalPaginas = Math.max(1, Math.ceil(tracks.length / TRACKS_POR_PAGINA));

                let paginaActual = parseInt(interaction.customId.replace('musica_queue_page_', '')) || 0;
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
                        { name: '▶️ Reproduciendo Ahora', value: `**[${currentTrack.title.replace(/[\[\]]/g, '')}](${currentTrack.url})**\nAutor: \`${currentTrack.author}\``, inline: false },
                        { name: `⏭️ Próximas Canciones (página ${paginaActual + 1}/${totalPaginas})`, value: listado || '_No hay más canciones en la cola._', inline: false }
                    )
                    .setFooter({ text: `Total: ${tracks.length} canciones | ${queue.durationFormatted || 'calculando...'} restantes` })
                    .setTimestamp();

                const componentes = [];
                if (totalPaginas > 1) {
                    componentes.push(new ActionRowBuilder().addComponents(
                        new ButtonBuilder().setCustomId(`musica_queue_page_${paginaActual - 1}`).setEmoji('◀️').setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(paginaActual === 0),
                        new ButtonBuilder().setCustomId(`musica_queue_page_${paginaActual + 1}`).setEmoji('▶️').setLabel('Siguiente').setStyle(ButtonStyle.Secondary).setDisabled(paginaActual >= totalPaginas - 1)
                    ));
                }

                if (esPaginacion) {
                    await interaction.deferUpdate();
                    return interaction.editReply({ embeds: [queueEmbed], components: componentes });
                }
                return interaction.reply({ embeds: [queueEmbed], components: componentes, flags: MessageFlags.Ephemeral });
            }

            // ── 🎤 VER LETRAS (VM) ──
            if (interaction.customId === 'musica_lyrics') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const currentTrack = queue.currentTrack;
                const tituloLimpio = limpiarParaLyrics(currentTrack.title, currentTrack.author);

                try {
                    const searches = await interaction.client.genius.songs.search(`${tituloLimpio} ${currentTrack.author}`);
                    const firstSong = searches[0];
                    if (!firstSong) return interaction.editReply(`❌ No encontré letras para: **${tituloLimpio}**.`);

                    const lyrics = await firstSong.lyrics();
                    const lyricsEmbed = new EmbedBuilder()
                        .setTitle(`🎤 Letras: ${firstSong.title}`)
                        .setAuthor({ name: firstSong.artist.name })
                        .setThumbnail(currentTrack.thumbnail)
                        .setDescription(lyrics.length > 4096 ? lyrics.substring(0, 4090) + '...' : lyrics)
                        .setColor('#FF9900')
                        .setFooter({ text: 'Powered by Genius API & VitaBot 🔨' });

                    return interaction.editReply({ embeds: [lyricsEmbed] });
                } catch (geniusError) {
                    console.error('[Genius API Error VM]:', geniusError.message);
                    return interaction.editReply('❌ El servidor de Genius rechazó la búsqueda o falló (Error 403). Intenta más tarde.');
                }
            }

        } catch (e) {
            console.error('[Botones VM Error]:', e.message);
            // 🌟 MANEJO SEGURO DE ERRORES:
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: '❌ Ocurrió un error al procesar el botón en la VM.' });
            } else {
                return interaction.reply({ content: '❌ Ocurrió un error al procesar el botón en la VM.', flags: MessageFlags.Ephemeral });
            }
        }
    } 
    
    // ─────────────────────────────────────────────
    // MODO 2: PC LOCAL (Músculo Hi-Fi)
    // ─────────────────────────────────────────────
    else if (botChannel) {
        try {
            // ── ⏯️ PAUSA / REANUDAR (PC) ──
            if (interaction.customId === 'musica_pausa') {
                const status = await fetch(`http://100.127.221.32:3000/api/control?action=status`).then(r => r.json());
                if (status.error) return interaction.reply({ content: '❌ La PC no tiene música activa.', flags: MessageFlags.Ephemeral });
                
                const action = status.isPaused ? 'resume' : 'pause';
                await fetch(`http://100.127.221.32:3000/api/control?action=${action}`);
                return interaction.reply({ content: status.isPaused ? '▶️ Música reanudada (PC).' : '⏸️ Música pausada (PC).', flags: MessageFlags.Ephemeral });
            }

            // ── ⏭️ SALTAR PISTA (PC) ──
            if (interaction.customId === 'musica_salto') {
                await fetch(`http://100.127.221.32:3000/api/control?action=skip`);
                return interaction.reply({ content: '⏭️ Saltando a la siguiente canción (PC).', flags: MessageFlags.Ephemeral });
            }

            // ── ⏹️ DETENER Y LIMPIAR (PC) ──
            if (interaction.customId === 'musica_stop') {
                await fetch(`http://100.127.221.32:3000/api/control?action=stop`);
                // Modificamos el panel principal para quitarle los botones
                if (interaction.message) await interaction.message.edit({ components: [] }).catch(()=>null);
                return interaction.reply({ content: '🛑 Música detenida y cola limpiada (PC).', flags: MessageFlags.Ephemeral });
            }

            // ── 🔀 MEZCLAR COLA (PC) ──
            if (interaction.customId === 'musica_shuffle') {
                return interaction.reply({ content: '⚠️ La mezcla (shuffle) aún no está disponible en el motor de PC Local.', flags: MessageFlags.Ephemeral });
            }

            // ── 📜 VER COLA (PC) ──
            if (interaction.customId === 'musica_queue' || esPaginacion) {
                const colaData = await fetch(`http://100.127.221.32:3000/api/control?action=queue`).then(r => r.json());
                
                if (colaData.error || !colaData.currentTrack) {
                    return interaction.reply({ content: '❌ La PC no está reproduciendo nada.', flags: MessageFlags.Ephemeral });
                }

                // Mostramos las primeras 15 canciones de la cola de la PC
                let listado = colaData.tracks.slice(0, 15).map((t, i) => `**${i + 1}.** [${t.title.substring(0, 60)}](${t.url}) - \`${t.duration}\``).join('\n');
                
                const queueEmbed = new EmbedBuilder()
                    .setTitle(`🎼 Cola de Reproducción — PC Local`)
                    .setColor('#00C853')
                    .addFields(
                        { name: '▶️ Reproduciendo Ahora', value: `**[${colaData.currentTrack.title}](${colaData.currentTrack.url})**\nAutor: \`${colaData.currentTrack.author}\``, inline: false },
                        { name: `⏭️ Próximas Canciones (${colaData.tracks.length} en cola)`, value: listado || '_No hay más canciones._', inline: false }
                    )
                    .setFooter({ text: 'Nota: El motor Hi-Fi muestra un resumen de la cola sin paginación.' })
                    .setTimestamp();

                return interaction.reply({ embeds: [queueEmbed], flags: MessageFlags.Ephemeral });
            }

            // ── 🎤 VER LETRAS (PC) ──
            if (interaction.customId === 'musica_lyrics') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });
                const status = await fetch(`http://100.127.221.32:3000/api/control?action=status`).then(r => r.json());
                
                if (status.error) return interaction.editReply('❌ No hay datos de la canción en la PC.');

                const tituloLimpio = limpiarParaLyrics(status.title, status.author);
                
                // 🌟 Aislamos la consulta a Genius en su propio try-catch para atrapar el Error 403
                try {
                    const searches = await interaction.client.genius.songs.search(`${tituloLimpio} ${status.author}`);
                    
                    if (!searches[0]) return interaction.editReply(`❌ No encontré letras para: **${tituloLimpio}**.`);
                    const lyrics = await searches[0].lyrics();
                    
                    const lyricsEmbed = new EmbedBuilder()
                        .setTitle(`🎤 Letras: ${searches[0].title}`)
                        .setAuthor({ name: searches[0].artist.name })
                        .setDescription(lyrics.length > 4096 ? lyrics.substring(0, 4090) + '...' : lyrics)
                        .setColor('#00C853')
                        .setFooter({ text: 'Powered by Genius API & VitaBot 🏠' });

                    return interaction.editReply({ embeds: [lyricsEmbed] });
                } catch (geniusError) {
                    console.error('[Genius API Error PC]:', geniusError.message);
                    return interaction.editReply('❌ El servidor de Genius rechazó la búsqueda o falló (Error 403). Intenta más tarde.');
                }
            }

        } catch (e) {
            console.error('[Botones PC Error]:', e.message);
            // 🌟 MANEJO SEGURO DE ERRORES: Verificamos si ya deferimos la respuesta
            if (interaction.deferred || interaction.replied) {
                return interaction.editReply({ content: '❌ Error de comunicación remota con la PC local.' });
            } else {
                return interaction.reply({ content: '❌ Error de comunicación remota con la PC local.', flags: MessageFlags.Ephemeral });
            }
        }
    }
}

module.exports = { manejarBotonesMusica };