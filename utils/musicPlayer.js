// utils/musicPlayer.js — VitaBot
// Motor de audio: extractor personalizado, streaming Hi-Fi y eventos del reproductor
const path = require('path'); // Asegúrate de importar path
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
    // Apuntamos a la nueva carpeta config/
    const cookiePath = path.join(__dirname, '../config/youtube-cookie.json');
    youtubeCookie = fs.readFileSync(cookiePath, 'utf-8').trim().replace(/^"|"$/g, '');
    console.log('» | [Music] Cookie de YouTube cargada desde /config.');
} catch (e) {
    console.warn('» | [Music] Sin cookie de YouTube en /config.');
}

// ─────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────

/**
 * Limpia y valida una URL de YouTube para evitar errores con FFmpeg y yt-dlp.
 * Solo permite dominios oficiales y extrae el ID del video correctamente.
 */
function cleanYoutubeUrl(url) {
    try {
        const u = new URL(url);
        const dominiosSeguros = ['youtube.com', 'youtu.be', 'music.youtube.com', 'googleusercontent.com'];
        if (!dominiosSeguros.some(d => u.hostname.endsWith(d))) return null;

        let videoId = u.searchParams.get('v');
        if (!videoId && u.hostname === 'youtu.be') {
            videoId = u.pathname.slice(1).split(/[?#]/)[0];
        }

        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    } catch (e) {
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
 * Limpia el título de una canción para búsquedas en Genius,
 * eliminando tags de marketing y paréntesis innecesarios.
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
// EXTRACTOR PERSONALIZADO
// ─────────────────────────────────────────────

class YoutubeExtExtractor extends BaseExtractor {
    static identifier = 'com.vitabot.youtube-ext';

    async validate(query, type) {
        if (query.startsWith('http') &&
            !query.includes('youtube.com') &&
            !query.includes('youtu.be') &&
            !query.includes('spotify.com')) {
            return false;
        }
        return true;
    }

    async handle(query, context) {
        try {
            // ------ SOPORTE PLAYLISTS DE YOUTUBE Soporte de Playlists con Triple Redundancia------
            if (query.includes('list=')) {
                console.log(`[DATA-SCAN] 🔍 Detectada posible playlist. Iniciando rastreo...`);
                let playlistData = null;

                // NIVEL 1: YT-DLP
                try {
                    const output = await youtubedl(query, {
                        dumpSingleJson: true,
                        flatPlaylist: true,
                        noCheckCertificates: true,
                        quiet: true,
                        noWarnings: true
                    }, { windowsHide: true, maxBuffer: 1024 * 1024 * 100 });

                    let json = (typeof output === 'string') ? JSON.parse(output) : output;

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

                // NIVEL 2: FALLBACK
                if (!playlistData) {
                    console.log(`[DATA-SCAN] Reintentando con youtube-ext...`);
                    playlistData = await youtubeExt.playlistInfo(query, {
                        requestOptions: { headers: { cookie: youtubeCookie } }
                    }).catch(() => null);
                }

                // PROCESAMIENTO FINAL
                if (playlistData && playlistData.videos?.length > 0) {
                    const MAX_TRACKS = 200; 
                    if (playlistData.videos.length > MAX_TRACKS) {
                        console.log(`[YoutubeExt] ⚠️ Playlist de ${playlistData.videos.length} pistas detectada. Limitando a ${MAX_TRACKS} por seguridad.`);
                        playlistData.videos = playlistData.videos.slice(0, MAX_TRACKS);
                    }
                    console.log(`[DEBUG] Preparando inyección de tracks para: ${playlistData.title}`);
                    
                    const tracks = playlistData.videos
                        .filter(v => v && v.title && v.url)
                        .map((video, index) => {
                            const track = new Track(this.context.player, {
                                title: video.title,
                                url: video.url,
                                duration: typeof video.duration === 'string' ? video.duration : '0:00',
                                thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || '',
                                author: video.author || 'YouTube Playlist',
                                requestedBy: context.requestedBy,
                                source: 'youtube',
                                queryType: 'youtubePlaylist' 
                            });
                            track.extractor = this;
                            
                            // Log de cada 10 pistas para no saturar pero confirmar flujo
                            if (index % 10 === 0) console.log(`[TRACK-CHECK] Pista ${index}: ${track.title} [VÁLIDA]`);
                            
                            return track;
                        });

                    const playlist = new Playlist(this.context.player, {
                        title: playlistData.title || 'Playlist',
                        url: query,
                        thumbnail: playlistData.thumbnail || '',
                        author: { name: playlistData.author || 'YouTube', url: '' },
                        tracks: tracks,
                        source: 'youtube',
                        type: 'playlist'
                    });

                    // LOG FINAL ANTES DEL RETURN
                    console.log(`[FINAL-RESULT] Objeto Playlist creado: ${playlist.title}`);
                    console.log(`[FINAL-RESULT] Array de Tracks (length): ${tracks.length}`);
                    console.log(`[FINAL-RESULT] ¿requestedBy existe?: ${context.requestedBy ? 'SÍ' : 'NO'}`);

                    return { playlist, tracks };
                } else {
                    console.error(`[DEBUG-EMPTY] No se encontraron videos procesables en la lista.`);
                }
            }
            
            // ------ SOPORTE YOUTUBE Y BÚSQUEDA POR NOMBRE ------
            let videoUrl;

            if (query.includes('youtube.com') || query.includes('youtu.be')) {
                videoUrl = cleanYoutubeUrl(query);
                console.log(`[YoutubeExt] 🔗 Link directo detectado: ${videoUrl}`);
            } else {
                const searchQuery = query.includes('music') ? query : `${query} music topic`;
                const results = await youtubeExt.search(searchQuery, { type: 'video', limit: 10 });
                if (!results?.videos?.length) return { playlist: null, tracks: [] };

                console.log(`[YoutubeExt] 🔍 Búsqueda: "${searchQuery}" | Resultados devueltos: ${results?.length || 10}`);

                const tracks = results.videos.map(video => {
                    const track = new Track(this.context.player, {
                        title: video.title,
                        url: cleanYoutubeUrl(video.url),
                        duration: video.duration?.text || '0:00',
                        thumbnail: video.thumbnails?.[0]?.url || '',
                        author: video.channel?.name || 'YouTube Music',
                        requestedBy: context.requestedBy,
                        source: 'youtube',
                        queryType: context.type
                    });
                    track.extractor = this;
                    return track;
                });

                return { playlist: null, tracks };
            }

            const info = await youtubeExt.videoInfo(videoUrl, {
                requestOptions: { headers: { cookie: youtubeCookie } }
            });

            if (!info?.title) return { playlist: null, tracks: [] };

            const track = new Track(this.context.player, {
                title: info.title || 'Sin título',
                url: videoUrl,
                duration: secondsToTime(info.duration?.lengthSec),
                thumbnail: info.thumbnails?.[0]?.url || '',
                author: info.channel?.name || 'Desconocido',
                requestedBy: context.requestedBy,
                source: 'youtube',
                queryType: context.type,
                description: info.shortDescription || '',
                views: info.views?.pretty || 0,
                live: info.isLive || false
            });

            track.extractor = this;
            return { playlist: null, tracks: [track] };

        } catch (e) {
            if (e.message.includes('Unexpected non-whitespace character') || e instanceof SyntaxError) {
                console.warn('[YoutubeExt] Error de parseo. Activando motores de respaldo...');
            } else {
                console.error('[YoutubeExt handle] ERROR:', e.message);
            }
            return { playlist: null, tracks: [] };
        }

        // ------ SOPORTE SPOTIFY ------
            if (query.includes('spotify.com/track/')) {
                const trackId = query.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                if (!trackId) return { playlist: null, tracks: [] };

                const oembedRes = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${trackId}`);
                const oembed = await oembedRes.json();

                const results = await youtubeExt.search(oembed.title, { type: 'video', limit: 1 });
                if (!results?.videos?.length) return { playlist: null, tracks: [] };

                const video = results.videos[0];
                const videoUrl = cleanYoutubeUrl(video.url);

                const track = new Track(this.context.player, {
                    title: oembed.title || video.title,
                    url: videoUrl,
                    duration: video.duration?.text || '0:00',
                    thumbnail: oembed.thumbnail_url || video.thumbnails?.[0]?.url || '',
                    author: video.channel?.name || 'Desconocido',
                    requestedBy: context.requestedBy,
                    source: 'spotify',
                    queryType: context.type,
                    description: '',
                    views: 0,
                    live: false
                });

                track.extractor = this;
                return { playlist: null, tracks: [track] };
            }

    }

    // El método stream se encarga de obtener el audio en formato Opus utilizando yt-dlp y FFmpeg.
    // utils/musicPlayer.js — Motor v3.9 (Protocolo de Sincronización Real)
    async stream(track) {
        try {
            const cleanUrl = cleanYoutubeUrl(track.url);
            if (!cleanUrl) throw new Error('URL no permitida o malformada');

            // 1. DETECCIÓN DE BITRATE (Sincronización de Fuerza Bruta)
            let channelBitrate = 96; 
            try {
                // Buscamos el ID del servidor en la metadata que enviamos desde play.js
                const guildId = track.metadata?.guildId || track.queue?.metadata?.guildId;
                const guild = this.context.player.client.guilds.cache.get(guildId);
                
                // Obtenemos el ID del canal de voz donde está el bot actualmente
                const voiceChannelId = guild?.members.me?.voice.channelId;
                
                if (voiceChannelId) {
                    // FORZAMOS FETCH AL CANAL: Esto obliga a Discord a dar el valor real y no el de caché
                    const freshChannel = await this.context.player.client.channels.fetch(voiceChannelId, { force: true });
                    if (freshChannel && freshChannel.bitrate) {
                        channelBitrate = freshChannel.bitrate / 1000;
                    }
                }
            } catch (err) {
                console.warn('[Audio-Engine] Error al sincronizar bitrate, usando fallback 96k.');
            }
            
            // El objetivo siempre será el mínimo entre el canal y nuestro tope de 256k
            const targetBitrate = Math.min(channelBitrate, 256); 

            // 2. FILTROS Y OBTENCIÓN DE URL
            const filters = ['loudnorm=I=-16:TP=-1.5:LRA=11', 'aresample=48000'].join(',');
            
            const audioUrl = (await youtubedl(cleanUrl, {
                format: 'bestaudio', getUrl: true, noCheckCertificates: true, noWarnings: true,
            }, { windowsHide: true })).trim();

            // 3. FFMPEG REFORZADO (Sin buffer_size problemático, con Anti-Reset)
            const ffmpegProcess = spawn(ffmpegPath, [
                // Parámetros de red ANTES del input para estabilidad inicial
                '-reconnect', '1', 
                '-reconnect_at_eof', '1', 
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-rw_timeout', '20000000', // Margen de 20s para estabilidad de red
                '-user_agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36',
                '-i', audioUrl,
                '-vn', 
                '-af', filters, 
                '-c:a', 'libopus', 
                '-ar', '48000', 
                '-ac', '2',
                '-b:a', `${targetBitrate}k`,
                '-f', 'opus',
                'pipe:1'
            ], { stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });

            // Monitor de integridad para el registro de auditoría
            ffmpegProcess.stderr.on('data', (data) => {
                if (data.toString().includes('10054')) {
                    console.error('[FFmpeg-Shield] Reset de conexión (Error -10054). Re-sincronizando flujo...');
                }
            });

            console.log(`[Audio-Engine] 🚀 Stream blindado: ${targetBitrate}kbps | Canal Real: ${channelBitrate}kbps`);

            return { stream: ffmpegProcess.stdout, type: StreamType.Opus };

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

    // Registramos extractores
    (async () => {
        try {
            await player.extractors.register(YoutubeExtExtractor, {});
            await player.extractors.loadMulti(DefaultExtractors);
            console.log('» | Motores de audio (Base + Custom) cargados correctamente.');
        } catch (e) {
            console.error('» | Error al inicializar motores:', e.message);
        }
    })();

    // ── Limpieza de la interfaz de botones al vaciar cola o desconectar ──
    const limpiarInterfaz = async (queue) => {
        if (queue.metadata?.ultimoMensaje) {
            await queue.metadata.ultimoMensaje.edit({ components: [] }).catch(() => null);
            queue.metadata.ultimoMensaje = null;
        }
    };

    // ── playerStart: envía el embed y los botones de control ──
    player.events.on('playerStart', async (queue, track) => {
        if (track.url.includes('translate_tts')) return;

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

    player.events.on('emptyQueue', (queue) => limpiarInterfaz(queue));
    player.events.on('disconnect', (queue) => limpiarInterfaz(queue));

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