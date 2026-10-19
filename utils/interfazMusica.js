const { ActionRowBuilder, ButtonBuilder, ButtonStyle, EmbedBuilder, MessageFlags, escapeMarkdown } = require('discord.js');
const { ErrorAudio, formatearDuracion } = require('../audio/protocolo');
const { log } = require('./logger');

function obtenerCanalVoz(interaction) {
    const channel = interaction.member?.voice?.channel;
    if (!channel) throw new ErrorAudio('Únete a un canal de voz primero.', 400);
    const botChannel = interaction.guild?.members.me?.voice?.channelId;
    const session = interaction.client.music.get(interaction.guildId);
    if ((session && session.channel.id !== channel.id) || (botChannel && botChannel !== channel.id)) {
        throw new ErrorAudio('Únete al mismo canal de voz que Vita para controlar el audio.', 403);
    }
    return channel;
}
function obtenerSesionActiva(interaction) {
    obtenerCanalVoz(interaction);
    const session = interaction.client.music.get(interaction.guildId);
    if (!session) throw new ErrorAudio('No hay una sesión de audio activa.', 404);
    return session;
}
async function responderError(interaction, error) {
    const payload = { content: error instanceof ErrorAudio ? error.message : 'No pude completar la operación de audio. Intenta de nuevo.',
        components: [], embeds: [], allowedMentions: { parse: [] } };
    if (interaction.deferred || interaction.replied) return interaction.editReply(payload).catch(() => null);
    return interaction.reply({ ...payload, flags: MessageFlags.Ephemeral }).catch(() => null);
}
const crearEnlaceCancion = track => `[${escapeMarkdown(track.title).slice(0, 220)}](${track.url})`;
function crearControles(generation) {
    const row = new ActionRowBuilder().addComponents(
        ...[['pausa', '⏯️'], ['salto', '⏭️'], ['stop', '⏹️'], ['shuffle', '🔀'], ['queue', '📜']].map(([action, emoji]) =>
            new ButtonBuilder().setCustomId(`musica_${action}:${generation}`).setEmoji(emoji).setStyle(action === 'stop' ? ButtonStyle.Danger : ButtonStyle.Secondary)));
    const mostrarLetra = new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId(`musica_lyrics:${generation}`)
        .setLabel('Ver letras').setEmoji('🎤').setStyle(ButtonStyle.Secondary));
    return [row, mostrarLetra];
}
function crearMensajeReproduccion(session, owner) {
    const track = owner.track;
    const embed = new EmbedBuilder().setTitle('🎵 Reproduciendo ahora').setColor('#C62828')
        .setDescription(`${crearEnlaceCancion(track)}\n${escapeMarkdown(track.author)} · ${formatearDuracion(track.durationSeconds)}`)
        .setFooter({ text: `Opus ${session.bitrate} kbps · Cola: ${session.tracks.length}` });
    if (track.thumbnail) embed.setThumbnail(track.thumbnail);
    return { embeds: [embed], components: crearControles(owner.generation), allowedMentions: { parse: [] } };
}
function crearMensajeCola(session, page = 0) {
    const pages = Math.max(1, Math.ceil(session.tracks.length / 10));
    page = Math.max(0, Math.min(pages - 1, Number.isInteger(page) ? page : 0));
    const current = session.current;
    const listing = session.tracks.slice(page * 10, page * 10 + 10)
        .map((track, i) => `${page * 10 + i + 1}. ${crearEnlaceCancion({ ...track, title: track.title.slice(0, 60) })} · ${formatearDuracion(track.durationSeconds)}`).join('\n');
    const embed = new EmbedBuilder().setTitle('🎼 Cola de reproducción').setColor('#C62828')
        .setDescription(`${current?.track ? `▶️ ${crearEnlaceCancion(current.track)}` : current?.kind === 'tts' ? '📢 Vita está hablando.' : 'Esperando canciones.'}\n\n**Próximas canciones · ${session.tracks.length}**\n${listing || 'La cola está vacía.'}`)
        .setFooter({ text: `Página ${page + 1}/${pages}` });
    const components = pages > 1 ? [new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`musica_queue_page_${page - 1}`).setLabel('Anterior').setStyle(ButtonStyle.Secondary).setDisabled(page === 0),
        new ButtonBuilder().setCustomId(`musica_queue_page_${page + 1}`).setLabel('Siguiente').setStyle(ButtonStyle.Secondary).setDisabled(page === pages - 1))] : [];
    return { embeds: [embed], components, allowedMentions: { parse: [] } };
}
async function mostrarLetra(interaction, track) {
    if (!track) throw new ErrorAudio('No hay una canción activa.', 404);
    await interaction.deferReply({ flags: MessageFlags.Ephemeral });
    const clean = track.title.replace(/\([^)]*(?:official|video|audio|lyrics|oficial)[^)]*\)|\[[^\]]*\]/gi, '').trim();
    const searches = await interaction.client.genius.songs.search(`${clean} ${track.author}`);
    if (!searches[0]) return interaction.editReply('No encontré la letra de esta canción.');
    const song = searches[0];
    const text = await song.lyrics();
    return interaction.editReply({ embeds: [new EmbedBuilder().setTitle(`🎤 ${song.title}`.slice(0, 256))
        .setDescription((text || 'Letra no disponible.').slice(0, 4096)).setColor('#C62828').setFooter({ text: 'Genius' })], allowedMentions: { parse: [] } });
}
function vincularInterfazMusica(service) {
    // La auditoría usa la configuración del servidor y no bloquea el audio ni los paneles.
    function registrarEvento(session, titulo, descripcion, campos = []) {
        Promise.resolve().then(() => log(session.channel.guild, {
            categoria: 'musica', titulo, descripcion,
            campos: [{ name: 'Canal de voz', value: `<#${session.channel.id}>`, inline: true }, ...campos],
        })).catch(() => console.warn('[Auditoría de audio] No se pudo registrar el evento.'));
    }
    service.on('trackStart', (session, owner) => {
        registrarEvento(session, 'Reproducción iniciada', 'Vita comenzó a reproducir una canción.', [
            { name: 'Canción', value: escapeMarkdown(owner.track.title).slice(0, 220) || 'Sin título' },
        ]);
        // Serialize panel updates so an old song cannot overwrite a newer panel after a slow REST request.
        session.panelTask = (session.panelTask || Promise.resolve()).catch(() => {}).then(async () => {
            await session.panel?.edit({ components: [] }).catch(() => null);
            if (session.current !== owner || session.closed) return;
            const panel = await session.textChannel.send(crearMensajeReproduccion(session, owner));
            session.panel = panel;
            if (session.current !== owner || session.closed) await panel.edit({ components: [] }).catch(() => null);
        }).catch(() => {});
    });
    service.on('sessionStop', session => {
        registrarEvento(session, 'Sesión de audio terminada', 'Vita cerró la sesión de voz y vació la cola.');
        session.panel?.edit({ components: [] }).catch(() => null);
    });
    service.on('trackError', (session, error) => {
        registrarEvento(session, 'Error de reproducción', 'No se pudo iniciar o continuar la canción.');
        session.textChannel.send({ content: error.message, allowedMentions: { parse: [] } }).catch(() => null);
    });
    service.on('speechStart', session => {
        registrarEvento(session, 'Mensaje de voz iniciado', 'Vita comenzó a reproducir un mensaje de /decir. El contenido no se registra.');
    });
    service.on('speechError', session => {
        registrarEvento(session, 'Error de mensaje de voz', 'No se pudo iniciar o continuar el mensaje de /decir. El contenido no se registra.');
    });
}
module.exports = { obtenerCanalVoz, obtenerSesionActiva, responderError, crearMensajeCola, mostrarLetra, vincularInterfazMusica, crearMensajeReproduccion };
