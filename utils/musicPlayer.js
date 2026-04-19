// utils/musicPlayer.js — VitaBot
// Motor de audio: extractor personalizado, streaming Hi-Fi y eventos del reproductor
const path = require('path');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Player, BaseExtractor, Track, Playlist } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const { StreamType } = require('@discordjs/voice');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const youtubeExt = require('youtube-ext');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const { log, sanitizeErrorMessage } = require('./logger');

// ─────────────────────────────────────────────
// CARGA DE COOKIE DE YOUTUBE
// ─────────────────────────────────────────────
let youtubeCookie = '';
try {
    const cookiePath = path.join(__dirname, '../config/youtube-cookie.json');
    youtubeCookie = fs.readFileSync(cookiePath, 'utf-8').trim().replace(/^"|"$/g, '');
    console.log('» | [Music] Cookie de YouTube cargada desde /config.');
} catch (e) {
    console.warn('» | [Music] Sin cookie de YouTube en /config.');
}

// ─────────────────────────────────────────────
// CACHE DE URLs DE AUDIO
// Cacheamos la URL del audio extraída por yt-dlp, NO el stream.
// Las URLs de YouTube expiran ~6h; usamos 12min para máxima seguridad.
//
// ⚠️ LIMPIEZA AUTOMÁTICA cada 5 min para evitar memory leak silencioso:
//    sin esto, el Map crece indefinidamente en sesiones largas.
// ─────────────────────────────────────────────
const audioUrlCache = new Map();
const CACHE_TTL = 1000 * 60 * 12; // 12 minutos

setInterval(() => {
    const now = Date.now();
    let eliminadas = 0;
    for (const [key, value] of audioUrlCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) {
            audioUrlCache.delete(key);
            eliminadas++;
        }
    }
    if (eliminadas > 0) console.log(`[CACHE] 🧹 ${eliminadas} URL(s) expiradas eliminadas.`);
}, 1000 * 60 * 5).unref(); // .unref() para que no bloquee el cierre del proceso

// ─────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────

/**
 * Limpia y valida una URL de YouTube.
 * Soporta todos los formatos conocidos:
 *   - youtube.com/watch?v=ID
 *   - youtu.be/ID
 *   - youtube.com/live/ID      ← streams en vivo
 *   - youtube.com/shorts/ID    ← shorts
 *   - parámetros extra como ?si= son ignorados (solo conserva el ID)
 */
function cleanYoutubeUrl(url) {
    try {
        const u = new URL(url);
        const dominiosSeguros = ['youtube.com', 'youtu.be', 'music.youtube.com', 'googleusercontent.com'];
        if (!dominiosSeguros.some(d => u.hostname.endsWith(d))) return null;

        // Formato estándar: ?v=ID
        let videoId = u.searchParams.get('v');

        // youtu.be/ID
        if (!videoId && u.hostname === 'youtu.be') {
            videoId = u.pathname.slice(1).split(/[?#]/)[0];
        }

        // /live/ID y /shorts/ID
        if (!videoId) {
            const match = u.pathname.match(/\/(?:live|shorts)\/([a-zA-Z0-9_-]{11})/);
            if (match) videoId = match[1];
        }

        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    } catch {
        return null;
    }
}

/**
 * Convierte segundos a formato mm:ss legible.
 */
function secondsToTime(secs) {
    const s = parseInt(secs || '0');
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}

/**
 * Limpia el título de una canción para búsquedas en Genius.
 */
function limpiarParaLyrics(texto, autor) {
    if (!texto) return '';

    let limpio = texto
        .replace(/\(Letra Oficial\)/gi, '')
        .replace(/\(Letra\)/gi, '')
        .replace(/\(Letra Lyrics\)/gi, '')
        .replace(/\(Video Oficial\)/gi, '')
        .replace(/\(Video\)/gi, '')
        .replace(/\(Official Video\)/gi, '')
        .replace(/\(Lyrics\)/gi, '')
        .replace(/\(Audio Oficial\)/gi, '')
        .replace(/\(Lyrics Video\)/gi, '')
        .replace(/\(Cover Audio\)/gi, '')
        .replace(/\(Official Live Video\)/gi, '')
        .replace(/\(Live Video\)/gi, '')
        .replace(/\(Official Live\)/gi, '')
        .replace(/\[.*?\]/g, '')
        .replace(/"/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (limpio.includes('-')) {
        const partes = limpio.split('-');
        if (autor && partes[0].toLowerCase().includes(autor.toLowerCase())) {
            limpio = partes[1].trim();
        } else {
            limpio = partes[partes.length - 1].trim();
        }
    }

    return limpio;
}

// ─────────────────────────────────────────────
// HELPER: Construir un Track desde datos de video
// ─────────────────────────────────────────────
function buildTrack(player, data, context, extractor) {
    const track = new Track(player, {
        title: data.title,
        url: data.url,
        duration: data.duration || '0:00',
        thumbnail: data.thumbnail || '',
        author: data.author || 'Desconocido',
        requestedBy: context.requestedBy,
        source: data.source || 'youtube',
        queryType: data.queryType || context.type,
        description: data.description || '',
        views: data.views || 0,
        live: data.live || false,
    });
    track.extractor = extractor;
    return track;
}

// ─────────────────────────────────────────────
// EXTRACTOR PERSONALIZADO
// ─────────────────────────────────────────────

class YoutubeExtExtractor extends BaseExtractor {
    static identifier = 'com.vitabot.youtube-ext';

    async validate(query, type) {
        // Rechaza URLs que no sean de YouTube ni Spotify
        if (
            query.startsWith('http') &&
            !query.includes('youtube.com') &&
            !query.includes('youtu.be') &&
            !query.includes('spotify.com')
        ) {
            return false;
        }
        return true;
    }

    async handle(query, context) {
        try {
            // ══════════════════════════════════════════
            // 1. SOPORTE SPOTIFY (primero, antes de los returns de YouTube)
            // ══════════════════════════════════════════
            if (query.includes('spotify.com/track/')) {
                console.log('[Spotify] 🎵 Track de Spotify detectado.');
                const trackId = query.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                if (!trackId) return { playlist: null, tracks: [] };

                const oembedRes = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${trackId}`);
                if (!oembedRes.ok) throw new Error('Spotify oEmbed falló');
                const oembed = await oembedRes.json();

                const results = await youtubeExt.search(oembed.title, { type: 'video', limit: 1 });
                if (!results?.videos?.length) return { playlist: null, tracks: [] };

                const video = results.videos[0];
                const videoUrl = cleanYoutubeUrl(video.url);
                if (!videoUrl) return { playlist: null, tracks: [] };

                const track = buildTrack(this.context.player, {
                    title: oembed.title || video.title,
                    url: videoUrl,
                    duration: video.duration?.text || '0:00',
                    thumbnail: oembed.thumbnail_url || video.thumbnails?.[0]?.url || '',
                    author: video.channel?.name || 'Desconocido',
                    source: 'spotify',
                }, context, this);

                console.log(`[Spotify] ✅ Track resuelto: ${track.title}`);
                return { playlist: null, tracks: [track] };
            }

            // ══════════════════════════════════════════
            // 2. SOPORTE PLAYLISTS DE YOUTUBE (con doble redundancia)
            // ══════════════════════════════════════════
            if (query.includes('list=')) {
                console.log('[DATA-SCAN] 🔍 Detectada posible playlist. Iniciando rastreo...');
                let playlistData = null;

                // NIVEL 1: yt-dlp (más rápido y completo)
                try {
                    const output = await youtubedl(query, {
                        dumpSingleJson: true,
                        flatPlaylist: true,
                        noCheckCertificates: true,
                        quiet: true,
                        noWarnings: true
                    }, { windowsHide: true, maxBuffer: 1024 * 1024 * 100 });

                    const json = (typeof output === 'string') ? JSON.parse(output) : output;

                    if (json && (json.entries || json.videos)) {
                        const entries = json.entries || json.videos;
                        console.log(`[DATA-SCAN] yt-dlp devolvió ${entries.length} entradas crudas.`);

                        playlistData = {
                            title: json.title || 'Playlist de YouTube',
                            author: json.uploader || 'YouTube',
                            thumbnail: json.thumbnails?.[0]?.url || '',
                            videos: entries.filter(e => e && (e.id || e.url)).map(entry => ({
                                title: entry.title || 'Video sin título',
                                url: entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : entry.url,
                                duration: entry.duration ? secondsToTime(entry.duration) : '0:00',
                                thumbnail: entry.thumbnails?.[0]?.url || '',
                                author: entry.uploader || json.uploader || 'YouTube'
                            }))
                        };
                    }
                } catch (e) {
                    console.warn(`[DEBUG-FAIL] Motor yt-dlp: ${e.message}`);
                }

                // NIVEL 2: Fallback con youtube-ext
                if (!playlistData) {
                    console.log('[DATA-SCAN] Reintentando con youtube-ext...');
                    playlistData = await youtubeExt.playlistInfo(query, {
                        requestOptions: { headers: { cookie: youtubeCookie } }
                    }).catch(() => null);
                }

                // PROCESAMIENTO FINAL DE PLAYLIST
                if (playlistData && playlistData.videos?.length > 0) {
                    const MAX_TRACKS = 200;
                    if (playlistData.videos.length > MAX_TRACKS) {
                        console.log(`[YoutubeExt] ⚠️ Playlist de ${playlistData.videos.length} pistas. Limitando a ${MAX_TRACKS}.`);
                        playlistData.videos = playlistData.videos.slice(0, MAX_TRACKS);
                    }

                    const tracks = playlistData.videos
                        .filter(v => v && v.title && v.url)
                        .map((video, index) => {
                            const track = buildTrack(this.context.player, {
                                title: video.title,
                                url: video.url,
                                duration: typeof video.duration === 'string' ? video.duration : '0:00',
                                thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || '',
                                author: video.author || 'YouTube Playlist',
                                source: 'youtube',
                                queryType: 'youtubePlaylist',
                            }, context, this);

                            if (index % 10 === 0) console.log(`[TRACK-CHECK] Pista ${index}: ${track.title} [VÁLIDA]`);
                            return track;
                        });

                    const playlist = new Playlist(this.context.player, {
                        title: playlistData.title || 'Playlist',
                        url: query,
                        thumbnail: playlistData.thumbnail || '',
                        author: { name: playlistData.author || 'YouTube', url: '' },
                        tracks,
                        source: 'youtube',
                        type: 'playlist'
                    });

                    console.log(`[FINAL-RESULT] Playlist: "${playlist.title}" | Tracks: ${tracks.length} | requestedBy: ${context.requestedBy ? 'SÍ' : 'NO'}`);
                    return { playlist, tracks };

                } else {
                    console.error('[DEBUG-EMPTY] No se encontraron videos procesables en la playlist.');
                    return { playlist: null, tracks: [] };
                }
            }

            // ══════════════════════════════════════════
            // 3. LINK DIRECTO DE YOUTUBE
            // ══════════════════════════════════════════
            if (query.includes('youtube.com') || query.includes('youtu.be')) {
                const videoUrl = cleanYoutubeUrl(query);
                if (!videoUrl) return { playlist: null, tracks: [] };
                console.log(`[YoutubeExt] 🔗 Link directo: ${videoUrl}`);

                const info = await youtubeExt.videoInfo(videoUrl, {
                    requestOptions: { headers: { cookie: youtubeCookie } }
                });

                if (!info?.title) return { playlist: null, tracks: [] };

                const track = buildTrack(this.context.player, {
                    title: info.title,
                    url: videoUrl,
                    duration: secondsToTime(info.duration?.lengthSec),
                    thumbnail: info.thumbnails?.[0]?.url || '',
                    author: info.channel?.name || 'Desconocido',
                    source: 'youtube',
                    description: info.shortDescription || '',
                    views: info.views?.pretty || 0,
                    live: info.isLive || false,
                }, context, this);

                return { playlist: null, tracks: [track] };
            }

            // ══════════════════════════════════════════
            // 4. BÚSQUEDA POR NOMBRE / TEXTO LIBRE
            // ══════════════════════════════════════════
            const searchQuery = query.includes('music') ? query : `${query} music topic`;
            console.log(`[YoutubeExt] 🔍 Búsqueda: "${searchQuery}"`);

            const results = await youtubeExt.search(searchQuery, { type: 'video', limit: 10 });
            if (!results?.videos?.length) return { playlist: null, tracks: [] };

            const tracks = results.videos
                .filter(v => v && v.url)
                .map(video => buildTrack(this.context.player, {
                    title: video.title,
                    url: cleanYoutubeUrl(video.url),
                    duration: video.duration?.text || '0:00',
                    thumbnail: video.thumbnails?.[0]?.url || '',
                    author: video.channel?.name || 'YouTube Music',
                    source: 'youtube',
                }, context, this));

            return { playlist: null, tracks };

        } catch (e) {
            if (e.message?.includes('Unexpected non-whitespace character') || e instanceof SyntaxError) {
                console.warn('[YoutubeExt] Error de parseo JSON en handle.');
            } else {
                console.error('[YoutubeExt handle] ERROR:', e.message);
            }
            return { playlist: null, tracks: [] };
        }
    }

    // ─────────────────────────────────────────────
    // STREAM — Motor Hi-Fi v4.0 (Híbrido M1+M2)
    //
    // Lógica:
    //   1. Obtiene bitrate real del canal de voz (dinámico, del M1).
    //   2. Inspecciona formatos con yt-dlp para detectar si el audio
    //      ya viene en Opus/WebM nativo → usa -c:a copy (sin pérdida,
    //      sin gasto de CPU). Si no, re-encodea con el bitrate del canal.
    //   3. Cachea la URL del audio (no el stream) para evitar llamadas
    //      repetidas a yt-dlp en la misma pista.
    //   4. Timeout de protección para que FFmpeg no quede zombie.
    // ─────────────────────────────────────────────
    async stream(track) {
        try {
            const cleanUrl = cleanYoutubeUrl(track.url);
            if (!cleanUrl) throw new Error('URL no permitida o malformada');

            // ── 1. BITRATE DINÁMICO DEL CANAL DE VOZ ──────────────────────
            let channelBitrate = 96;
            try {
                const guildId = track.metadata?.guildId || track.queue?.metadata?.guildId;
                const guild = this.context.player.client.guilds.cache.get(guildId);
                const voiceChannelId = guild?.members.me?.voice.channelId;

                if (voiceChannelId) {
                    // force: true para evitar caché de Discord y obtener el valor real
                    const freshChannel = await this.context.player.client.channels.fetch(voiceChannelId, { force: true });
                    if (freshChannel?.bitrate) channelBitrate = freshChannel.bitrate / 1000;
                }
            } catch {
                console.warn('[Audio-Engine] Error al leer bitrate del canal → fallback 96k');
            }

            // Bitrate inteligente por rangos según el canal real:
            //   < 96k   → probable canal básico, limitamos a 96k
            //   96–256k → sweet spot Discord, usamos el canal tal cual
            //   > 256k  → canal boosteado, subimos hasta 256k (máximo perceptible en Opus)
            // No usamos 320k porque Opus no mejora perceptiblemente sobre 256k para voz/música.
            const targetBitrate = channelBitrate <= 96  ? 96
                                : channelBitrate <= 256 ? channelBitrate
                                : 256;

            // ── 2. OBTENER URL DE AUDIO (con cache de URL, no de stream) ──
            let audioUrl, isOpusCopy;
            const cached = audioUrlCache.get(cleanUrl);

            if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
                console.log('[CACHE] ✅ Usando URL de audio cacheada');
                ({ audioUrl, isOpusCopy } = cached);
            } else {
                // Inspeccionar formatos para decidir si podemos hacer copy
                const info = await youtubedl(cleanUrl, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    noCheckCertificates: true,
                    preferFreeFormats: true,
                }, { windowsHide: true });

                const formats = (info.formats || []).filter(f => f.acodec !== 'none' && f.url);
                if (!formats.length) throw new Error('No se encontró ningún formato de audio');

                // Prioridad: mejor opus/webm nativo (copy sin pérdida) > mayor bitrate disponible.
                // Usamos sort() y no find() para garantizar que tomamos el de MAYOR bitrate entre
                // los opus disponibles, no simplemente el primero que aparezca en la lista.
                const opusWebm = formats
                    .filter(f => f.acodec?.includes('opus') && f.ext === 'webm')
                    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

                const bestAudio = opusWebm || formats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

                audioUrl    = bestAudio.url;
                isOpusCopy  = !!opusWebm;

                audioUrlCache.set(cleanUrl, { audioUrl, isOpusCopy, timestamp: Date.now() });
            }

            // ── 3. CONSTRUIR ARGUMENTOS DE FFMPEG ─────────────────────────
            // ⚠️ NOTA: loudnorm ELIMINADO intencionalmente.
            //   loudnorm necesita 2 pasadas para funcionar correctamente.
            //   En modo de un solo pase (streaming) introduce distorsión audible
            //   — el "ruido de vinilo / estática" que se escucha. En su lugar
            //   usamos dynaudnorm que sí opera bien en tiempo real.
            //
            // ⚠️ NOTA: -reconnect_at_eof ELIMINADO para audio normal.
            //   Cuando una canción termina, el stream HTTP cierra limpiamente.
            //   Con reconnect_at_eof, FFmpeg interpreta ese cierre como un error
            //   y genera los mensajes -10054 que ves en el log. Solo se activa
            //   para streams en vivo donde sí tiene sentido.
            const esLive = track.live || false;

            const args = [
                '-reconnect',           '1',
                '-reconnect_streamed',  '1',
                '-reconnect_delay_max', '10',
                // reconnect_at_eof solo en vivos — en audio pregrabado causa falsos errores -10054
                ...(esLive ? ['-reconnect_at_eof', '1'] : []),
                '-probesize',           '4M',
                '-analyzeduration',     '4M',
                '-loglevel',            'error',
                '-i',                   audioUrl,
                '-vn',
            ];

            if (isOpusCopy) {
                // Audio opus nativo: copia directa, cero re-encoding, cero pérdida
                args.push('-c:a', 'copy', '-f', 'opus');
                console.log(`[Audio-Engine] ✅ COPY opus nativo | Canal: ${channelBitrate}kbps | Live: ${esLive}`);
            } else {
                // dynaudnorm: normalización de volumen en tiempo real sin distorsión
                // f=150: ventana de 150ms — equilibrio entre reactividad y estabilidad
                // g=15:  suavizado de 15 frames — evita cambios bruscos de volumen
                // p=0.95: pico máximo al 95% para no saturar
                args.push(
                    '-af',  'dynaudnorm=f=150:g=15:p=0.95',
                    '-c:a', 'libopus',
                    '-ar',  '48000',
                    '-ac',  '2',
                    '-b:a', `${targetBitrate}k`,
                    '-f',   'opus'
                );
                console.log(`[Audio-Engine] 🔄 ENCODE ${targetBitrate}kbps | Canal: ${channelBitrate}kbps | Live: ${esLive}`);
            }

            args.push('pipe:1');

            // ── 4. SPAWN FFMPEG ────────────────────────────────────────────
            const ffmpegProcess = spawn(ffmpegPath, args, {
                stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });

            ffmpegProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                // Errores de I/O al final de pista son normales (stream HTTP cerrado limpiamente).
                // Solo logueamos si NO son errores esperados de fin de stream.
                const esErrorNormal = msg.includes('I/O error') || msg.includes('End of file');
                if (msg.includes('10054') && !esLive) {
                    // En audio normal este error es falso — el stream terminó limpiamente
                    // Solo lo logueamos en modo debug, no como error crítico
                    console.debug('[FFmpeg] Fin de stream detectado (normal en audio pregrabado)');
                } else if (msg.includes('10054') && esLive) {
                    console.error('[FFmpeg-Shield] Reset de conexión en live (-10054). Re-sincronizando...');
                } else if (msg.includes('error') && !esErrorNormal) {
                    console.error('[FFmpeg]', msg.trim());
                }
            });

            ffmpegProcess.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    if (isOpusCopy) {
                        // Copy falló (stream Opus corrupto o contenedor incompatible).
                        // Marcamos la entrada del cache para que la próxima reproducción
                        // use encode en lugar de copy, evitando el error recurrente.
                        const entry = audioUrlCache.get(cleanUrl);
                        if (entry) {
                            audioUrlCache.set(cleanUrl, { ...entry, isOpusCopy: false });
                            console.warn('[Audio-Engine] ⚠️ Copy falló → cache actualizado a encode para próxima vez');
                        }
                    }
                    console.warn(`[FFmpeg] Proceso terminó con código ${code}`);
                }
            });

            // ── 5. TIMEOUT: evita que FFmpeg quede zombie si no arranca ───
            const timeout = setTimeout(() => {
                if (!ffmpegProcess.killed) {
                    console.warn('[FFmpeg] ⚠️ Timeout de arranque (20s) — terminando proceso');
                    ffmpegProcess.kill('SIGKILL');
                }
            }, 20000);

            // Cancelar el timeout en cuanto lleguen los primeros datos
            ffmpegProcess.stdout.once('data', () => clearTimeout(timeout));

            return {
                stream:         ffmpegProcess.stdout,
                type:           StreamType.Opus,
                highWaterMark:  1 << 25, // 32MB de buffer → reduce micro-cortes
            };

        } catch (e) {
            console.error('[YoutubeExt stream] ERROR CRÍTICO:', e.message);
            throw e;
        }
    }

    emittedError(error) {
        console.error('[YoutubeExt error]', error);
    }
}

// ─────────────────────────────────────────────
// INICIALIZACIÓN Y EVENTOS DEL REPRODUCTOR
// ─────────────────────────────────────────────

/**
 * Crea e inicializa el Player con el extractor personalizado y los extractores base.
 * Registra todos los eventos de música (playerStart, emptyQueue, disconnect, errores).
 * @param {import('discord.js').Client} client
 * @returns {Player}
 */
function inicializarPlayer(client) {
    const player = new Player(client);

    (async () => {
        try {
            await player.extractors.register(YoutubeExtExtractor, {});
            await player.extractors.loadMulti(DefaultExtractors);
            console.log('» | Motores de audio (Base + Custom) cargados correctamente.');
        } catch (e) {
            console.error('» | Error al inicializar motores:', e.message);
        }
    })();

    // ── Limpieza de botones al vaciar cola o desconectar ──────────────────
    const limpiarInterfaz = async (queue) => {
        if (queue.metadata?.ultimoMensaje) {
            await queue.metadata.ultimoMensaje.edit({ components: [] }).catch(() => null);
            queue.metadata.ultimoMensaje = null;
        }
    };

    // ── playerStart: deshabilita botones anteriores y envía nuevo embed ─────
    player.events.on('playerStart', async (queue, track) => {
        if (track.url.includes('translate_tts')) return;

        // ⚠️ CRÍTICO: deshabilitar botones del mensaje ANTERIOR antes de enviar el nuevo.
        // Sin esto, los controles de canciones ya reproducidas quedan activos en el chat
        // (el problema de los botones "zombie" que se ve en la captura).
        if (queue.metadata?.ultimoMensaje) {
            const deshabilitado = (btn) => ButtonBuilder.from(btn).setDisabled(true);
            try {
                const msgAnterior = queue.metadata.ultimoMensaje;
                const filasDeshabilitadas = msgAnterior.components.map(fila =>
                    ActionRowBuilder.from(fila).setComponents(fila.components.map(deshabilitado))
                );
                await msgAnterior.edit({ components: filasDeshabilitadas }).catch(() => null);
            } catch { /* mensaje ya eliminado, ignorar */ }
            queue.metadata.ultimoMensaje = null;
        }

        const embed = new EmbedBuilder()
            .setTitle('🎵 Reproduciendo Ahora')
            .setDescription(`**[${track.title}](${track.url})**\nAutor: ${track.author}`)
            .setColor('#FF9900');

        if (track.thumbnail?.startsWith('http')) {
            embed.setThumbnail(track.thumbnail);
        }

        const fila1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('musica_pausa').setEmoji('⏯️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('musica_salto').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('musica_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('musica_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('musica_queue').setEmoji('📜').setStyle(ButtonStyle.Secondary)
        );

        const fila2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId('musica_lyrics')
                .setLabel('Ver Letras')
                .setEmoji('🎤')
                .setStyle(ButtonStyle.Secondary)
        );

        if (queue.metadata?.canal) {
            const mensaje = await queue.metadata.canal.send({
                embeds: [embed],
                components: [fila1, fila2]
            }).catch(() => null);

            queue.metadata.ultimoMensaje = mensaje;
        }
    });

    player.events.on('emptyQueue',  (queue) => limpiarInterfaz(queue));
    player.events.on('disconnect',  (queue) => limpiarInterfaz(queue));

    player.events.on('error', (queue, error) => {
        console.error(`[Error de Sistema]: ${error.message}`);
        if (queue?.guild) {
            log(queue.guild, {
                categoria: 'sistema',
                titulo: 'Error de Sistema',
                descripcion: 'Ocurrió un error en el sistema de reproducción.',
                error: sanitizeErrorMessage(error.message),
            }).catch(() => null);
        }
    });

    player.events.on('playerError', (queue, error) => {
        console.error(`[Error de Audio]: ${error.message}`);
        if (queue?.guild) {
            log(queue.guild, {
                categoria: 'sistema',
                titulo: 'Error de Audio',
                descripcion: 'Ocurrió un error al reproducir la pista de audio.',
                campos: queue.currentTrack ? [
                    { name: '🎵 Pista', value: queue.currentTrack.title, inline: true }
                ] : [],
                error: sanitizeErrorMessage(error.message),
            }).catch(() => null);
        }
    });

    return player;
}

module.exports = { inicializarPlayer, cleanYoutubeUrl, secondsToTime, limpiarParaLyrics };