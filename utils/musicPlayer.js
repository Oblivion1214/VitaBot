// utils/musicPlayer.js — VitaBot
// Motor de audio: extractor personalizado, streaming Hi-Fi y eventos del reproductor
const path = require('path');
const os = require('os');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Player, BaseExtractor, Track, Playlist } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const { StreamType } = require('@discordjs/voice');
const { spawn } = require('child_process');
//const ffmpegPath = require('ffmpeg-static'); Solo usar en windows, en Linux y Mac se asume ffmpeg instalado globalmente
const youtubeExt = require('youtube-ext');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const { log, sanitizeErrorMessage } = require('./logger');
// Detecta el binario correcto de yt-dlp según el sistema operativo
const { execSync } = require('child_process');

// ─────────────────────────────────────────────
// DIAGNÓSTICO DEL SISTEMA — Imprime al arranque
// ─────────────────────────────────────────────
function logSistema(tag = 'BOOT') {
    const totalMem  = os.totalmem();
    const freeMem   = os.freemem();
    const usedMem   = totalMem - freeMem;
    const heapUsed  = process.memoryUsage().heapUsed;
    const heapTotal = process.memoryUsage().heapTotal;
    const rss       = process.memoryUsage().rss;
    const loadAvg   = os.loadavg();
    const uptime    = (process.uptime() / 60).toFixed(1);

    console.log(`\n┌─────────────────────────── [PERF:${tag}] ───────────────────────────`);
    console.log(`│ 🖥  RAM Sistema : ${(usedMem / 1024 / 1024).toFixed(1)} MB usados / ${(totalMem / 1024 / 1024).toFixed(1)} MB total  (libre: ${(freeMem / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`│ 🟩 Node Heap   : ${(heapUsed / 1024 / 1024).toFixed(1)} MB usados / ${(heapTotal / 1024 / 1024).toFixed(1)} MB total`);
    console.log(`│ 📦 Node RSS    : ${(rss / 1024 / 1024).toFixed(1)} MB (memoria física real del proceso)`);
    console.log(`│ ⚡ CPU LoadAvg : ${loadAvg[0].toFixed(2)} (1m) | ${loadAvg[1].toFixed(2)} (5m) | ${loadAvg[2].toFixed(2)} (15m)`);
    console.log(`│ ⏱  Uptime Bot  : ${uptime} min`);
    console.log(`└────────────────────────────────────────────────────────────────────\n`);

    // Alerta si la RAM libre cae por debajo de 150MB (probable presión de SWAP)
    if (freeMem < 150 * 1024 * 1024) {
        console.warn(`⚠️  [PERF:${tag}] RAM CRÍTICA: solo ${(freeMem / 1024 / 1024).toFixed(1)} MB libres — riesgo alto de SWAP`);
    }
    // Alerta si load average supera 1.5 en e2-micro (1 vCPU)
    if (loadAvg[0] > 1.5) {
        console.warn(`⚠️  [PERF:${tag}] CPU SATURADA: load avg ${loadAvg[0].toFixed(2)} (umbral recomendado < 1.5 para e2-micro)`);
    }
}

// Llama al diagnóstico al arrancar el módulo
logSistema('MODULE_LOAD');

// ─────────────────────────────────────────────
// CARGA DE COOKIE DE YOUTUBE
// ─────────────────────────────────────────────
let youtubeCookie = '';
try {
    const cookiePath = path.join(__dirname, '../config/youtube-cookie.json');
    youtubeCookie = fs.readFileSync(cookiePath, 'utf-8').trim().replace(/^\"|\"$/g, '');
    console.log('» | [Music] Cookie de YouTube cargada desde /config.');
} catch (e) {
    console.warn('» | [Music] Sin cookie de YouTube en /config.');
}

// ─────────────────────────────────────────────
// CACHE DE URLs DE AUDIO
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
    if (eliminadas > 0) {
        console.log(`[CACHE] 🧹 ${eliminadas} URL(s) expiradas eliminadas. Entradas restantes: ${audioUrlCache.size}`);
    }
    // Log periódico de estado del caché cada limpieza
    console.log(`[CACHE] Estado: ${audioUrlCache.size} entradas activas en memoria`);
    logSistema('CACHE_GC');
}, 1000 * 60 * 5).unref();

// ─────────────────────────────────────────────
// CONTADOR GLOBAL DE STREAMS ACTIVOS
// Nos permite saber cuántos FFmpeg hay corriendo simultáneamente
// ─────────────────────────────────────────────
let streamsActivos = 0;

// ─────────────────────────────────────────────
// UTILIDADES
// ─────────────────────────────────────────────

function cleanYoutubeUrl(url) {
    try {
        const u = new URL(url);
        const dominiosSeguros = ['youtube.com', 'youtu.be', 'music.youtube.com', 'googleusercontent.com'];
        if (!dominiosSeguros.some(d => u.hostname.endsWith(d))) return null;

        let videoId = u.searchParams.get('v');

        if (!videoId && u.hostname === 'youtu.be') {
            videoId = u.pathname.slice(1).split(/[?#]/)[0];
        }

        if (!videoId) {
            const match = u.pathname.match(/\/(?:live|shorts)\/([a-zA-Z0-9_-]{11})/);
            if (match) videoId = match[1];
        }

        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    } catch {
        return null;
    }
}

function secondsToTime(secs) {
    const s = parseInt(secs || '0');
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}

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
// Detecta el binario correcto de yt-dlp según el sistema operativo y la instalación
function getYtdlpBin() {
    // youtube-dl-exec incluye su propio binario, usarlo siempre que esté disponible
    try {
        const binPath = require('youtube-dl-exec').raw;
        if (binPath && fs.existsSync(binPath)) {
            console.log(`[yt-dlp] Usando binario de youtube-dl-exec: ${binPath}`);
            return binPath;
        }
    } catch {}

    // Fallback: buscar en PATH
    try {
        const which = os.platform() === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
        const bin = execSync(which, { stdio: 'pipe' }).toString().trim().split('\n')[0];
        console.log(`[yt-dlp] Binario encontrado en PATH: ${bin}`);
        return bin;
    } catch {}

    // Último recurso: nombre genérico (funciona si está en PATH en Linux)
    return os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

const YTDLP_BIN = getYtdlpBin();

// Verificación de dependencias al arrancar
(async () => {
    try {
        const { execFileSync } = require('child_process');
        const version = execFileSync(YTDLP_BIN, ['--version'], { stdio: 'pipe' }).toString().trim();
        console.log(`[yt-dlp] ✅ Versión detectada: ${version}`);
    } catch (e) {
        console.error(`[yt-dlp] 🔴 BINARIO NO ENCONTRADO: ${YTDLP_BIN}`);
        console.error(`[yt-dlp]    En Windows: instala con "winget install yt-dlp" o "pip install yt-dlp"`);
        console.error(`[yt-dlp]    En Linux:   sudo curl -L https://github.com/yt-dlp/yt-dlp/releases/latest/download/yt-dlp -o /usr/local/bin/yt-dlp && sudo chmod +x /usr/local/bin/yt-dlp`);
    }
})();
// ─────────────────────────────────────────────


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
        if (
            query.startsWith('http') &&
            !query.includes('youtube.com') &&
            !query.includes('youtu.be') &&
            !query.includes('spotify.com')
        ) {
            console.log(`[Validate] ❌ URL rechazada (no es YouTube/Spotify): ${query.slice(0, 60)}`);
            return false;
        }
        console.log(`[Validate] ✅ Query aceptada: "${query.slice(0, 80)}"`);
        return true;
    }

    async handle(query, context) {
        const t0 = Date.now();
        console.log(`\n[Handle] ▶ Iniciando resolución de query: "${query.slice(0, 80)}"`);
        logSistema('HANDLE_START');

        try {
            // ══════════════════════════════════════════
            // 1. SOPORTE SPOTIFY
            // ══════════════════════════════════════════
            if (query.includes('spotify.com/track/')) {
                console.log('[Spotify] 🎵 Track de Spotify detectado.');
                const trackId = query.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                if (!trackId) {
                    console.warn('[Spotify] ⚠️ No se pudo extraer trackId de la URL.');
                    return { playlist: null, tracks: [] };
                }

                console.log(`[Spotify] Consultando oEmbed para trackId: ${trackId}`);
                const t1 = Date.now();
                const oembedRes = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${trackId}`);
                if (!oembedRes.ok) throw new Error('Spotify oEmbed falló');
                const oembed = await oembedRes.json();
                console.log(`[Spotify] oEmbed OK en ${Date.now() - t1}ms → título: "${oembed.title}"`);

                const t2 = Date.now();
                const results = await youtubeExt.search(oembed.title, { type: 'video', limit: 1 });
                console.log(`[Spotify] Búsqueda YT en ${Date.now() - t2}ms → ${results?.videos?.length || 0} resultados`);

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

                console.log(`[Spotify] ✅ Track resuelto: "${track.title}" en ${Date.now() - t0}ms total`);
                return { playlist: null, tracks: [track] };
            }

            // ══════════════════════════════════════════
            // 2. SOPORTE PLAYLISTS DE YOUTUBE
            // ══════════════════════════════════════════
            if (query.includes('list=')) {
                console.log('[DATA-SCAN] 🔍 Detectada posible playlist. Iniciando rastreo...');
                logSistema('PLAYLIST_FETCH');
                let playlistData = null;

                // NIVEL 1: yt-dlp
                try {
                    console.log('[DATA-SCAN] Intentando con yt-dlp...');
                    const t1 = Date.now();
                    const output = await youtubedl(query, {
                        dumpSingleJson: true,
                        flatPlaylist: true,
                        noCheckCertificates: true,
                        quiet: true,
                        noWarnings: true
                    }, { maxBuffer: 1024 * 1024 * 100 });

                    const json = (typeof output === 'string') ? JSON.parse(output) : output;
                    console.log(`[DATA-SCAN] yt-dlp completó en ${Date.now() - t1}ms`);

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
                    console.warn(`[DEBUG-FAIL] Motor yt-dlp falló: ${e.message}`);
                }

                // NIVEL 2: Fallback con youtube-ext
                if (!playlistData) {
                    console.log('[DATA-SCAN] Reintentando con youtube-ext...');
                    const t1 = Date.now();
                    playlistData = await youtubeExt.playlistInfo(query, {
                        requestOptions: { headers: { cookie: youtubeCookie } }
                    }).catch((e) => {
                        console.warn(`[DATA-SCAN] youtube-ext también falló en ${Date.now() - t1}ms: ${e.message}`);
                        return null;
                    });
                    if (playlistData) console.log(`[DATA-SCAN] youtube-ext OK en ${Date.now() - t1}ms`);
                }

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

                            if (index % 10 === 0) console.log(`[TRACK-CHECK] Pista ${index}: "${track.title}" [VÁLIDA]`);
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

                    console.log(`[FINAL-RESULT] Playlist: "${playlist.title}" | Tracks: ${tracks.length} | requestedBy: ${context.requestedBy ? 'SÍ' : 'NO'} | Tiempo total: ${Date.now() - t0}ms`);
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
                if (!videoUrl) {
                    console.warn(`[Handle] URL directa inválida o no procesable: ${query.slice(0, 80)}`);
                    return { playlist: null, tracks: [] };
                }
                console.log(`[YoutubeExt] 🔗 Link directo: ${videoUrl}`);

                const t1 = Date.now();
                const info = await youtubeExt.videoInfo(videoUrl, {
                    requestOptions: { headers: { cookie: youtubeCookie } }
                });
                console.log(`[YoutubeExt] videoInfo completó en ${Date.now() - t1}ms → título: "${info?.title || 'N/A'}"`);

                if (!info?.title) {
                    console.warn('[Handle] videoInfo no devolvió título. Abortando.');
                    return { playlist: null, tracks: [] };
                }

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

                console.log(`[Handle] ✅ Track resuelto en ${Date.now() - t0}ms: "${track.title}" | Live: ${track.live}`);
                return { playlist: null, tracks: [track] };
            }

            // ══════════════════════════════════════════
            // 4. BÚSQUEDA POR NOMBRE / TEXTO LIBRE
            // ══════════════════════════════════════════
            const searchQuery = query.includes('music') ? query : `${query} music topic`;
            console.log(`[YoutubeExt] 🔍 Búsqueda libre: "${searchQuery}"`);

            const t1 = Date.now();
            const results = await youtubeExt.search(searchQuery, { type: 'video', limit: 10 });
            console.log(`[YoutubeExt] Búsqueda completó en ${Date.now() - t1}ms → ${results?.videos?.length || 0} resultados`);

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

            console.log(`[Handle] ✅ ${tracks.length} tracks resueltos en ${Date.now() - t0}ms`);
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
    // STREAM — Motor Hi-Fi con logs de diagnóstico
    // ─────────────────────────────────────────────
    /*
    async stream(track) {
        const t0 = Date.now();
        const trackLabel = `"${track.title?.slice(0, 50) || 'sin título'}"`;

        console.log(`\n╔══════════════════════════════════════════════════════════`);
        console.log(`║ [STREAM] ▶ Iniciando stream de ${trackLabel}`);
        console.log(`║ [STREAM] URL: ${track.url?.slice(0, 80)}`);
        console.log(`╚══════════════════════════════════════════════════════════`);

        logSistema('STREAM_START');

        // Alerta si ya hay más de 1 stream activo (e2-micro no aguanta 2+ FFmpeg)
        streamsActivos++;
        if (streamsActivos > 1) {
            console.warn(`⚠️  [STREAM] ADVERTENCIA: ${streamsActivos} streams FFmpeg activos simultáneamente en este proceso. Riesgo de saturación de CPU/RAM.`);
        }

        try {
            const cleanUrl = cleanYoutubeUrl(track.url);
            if (!cleanUrl) throw new Error('URL no permitida o malformada');

            // ── 1. BITRATE DINÁMICO DEL CANAL DE VOZ ──────────────────────
            let channelBitrate = 96;
            let channelName = 'desconocido';
            try {
                const guildId = track.metadata?.guildId || track.queue?.metadata?.guildId;
                const guild = this.context.player.client.guilds.cache.get(guildId);
                const voiceChannelId = guild?.members.me?.voice.channelId;

                if (voiceChannelId) {
                    const freshChannel = await this.context.player.client.channels.fetch(voiceChannelId, { force: true });
                    if (freshChannel?.bitrate) {
                        channelBitrate = freshChannel.bitrate / 1000;
                        channelName = freshChannel.name || channelName;
                    }
                }
                console.log(`[STREAM] Canal de voz: "${channelName}" | Bitrate real: ${channelBitrate}kbps`);
            } catch (e) {
                console.warn(`[STREAM] ⚠️ Error al leer bitrate del canal: ${e.message} → fallback 96k`);
            }

            const targetBitrate = channelBitrate <= 96  ? 96
                                : channelBitrate <= 256 ? channelBitrate
                                : 256;
            console.log(`[STREAM] Target bitrate calculado: ${targetBitrate}kbps`);

            // ── 2. OBTENER URL DE AUDIO (con cache) ──
            let audioUrl, isOpusCopy;
            const cached = audioUrlCache.get(cleanUrl);

            if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
                const edadCache = ((Date.now() - cached.timestamp) / 1000 / 60).toFixed(1);
                console.log(`[CACHE] ✅ Usando URL de audio cacheada (edad: ${edadCache} min) | isOpusCopy: ${cached.isOpusCopy}`);
                ({ audioUrl, isOpusCopy } = cached);
            } else {
                if (cached) {
                    console.log(`[CACHE] ⏰ Entrada expirada para esta URL, re-extrayendo con yt-dlp`);
                } else {
                    console.log(`[CACHE] ❌ Sin caché para esta URL. Llamando a yt-dlp...`);
                }

                const t1 = Date.now();
                const info = await youtubedl(cleanUrl, {
                    dumpSingleJson: true,
                    noWarnings: true,
                    noCheckCertificates: true,
                    preferFreeFormats: true,
                    noPlaylist: true,
                }, { maxBuffer: 1024 * 1024 * 10 });

                const ytdlpMs = Date.now() - t1;
                console.log(`[STREAM] yt-dlp completó en ${ytdlpMs}ms`);
                if (ytdlpMs > 8000) {
                    console.warn(`⚠️  [STREAM] yt-dlp tardó ${ytdlpMs}ms — red lenta o CPU saturada (carga CPU actual: ${os.loadavg()[0].toFixed(2)})`);
                }

                const formats = (info.formats || []).filter(f => f.acodec !== 'none' && f.url);
                console.log(`[STREAM] Formatos de audio disponibles: ${formats.length}`);

                if (!formats.length) throw new Error('No se encontró ningún formato de audio');

                // Log de los mejores formatos disponibles
                const topFormats = formats
                    .sort((a, b) => (b.abr || 0) - (a.abr || 0))
                    .slice(0, 3);
                topFormats.forEach((f, i) => {
                    console.log(`[STREAM] Formato #${i + 1}: codec=${f.acodec} ext=${f.ext} abr=${f.abr || '?'}kbps tbr=${f.tbr || '?'}kbps`);
                });

                const opusWebm = formats
                    .filter(f => f.acodec?.includes('opus') && f.ext === 'webm')
                    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

                const bestAudio = opusWebm || formats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

                audioUrl   = bestAudio.url;
                isOpusCopy = !!opusWebm;

                console.log(`[STREAM] Formato seleccionado: codec=${bestAudio.acodec} ext=${bestAudio.ext} abr=${bestAudio.abr || '?'}kbps | Modo: ${isOpusCopy ? 'COPY nativo' : 'ENCODE'}`);

                audioUrlCache.set(cleanUrl, { audioUrl, isOpusCopy, timestamp: Date.now() });
                console.log(`[CACHE] 💾 URL guardada en caché. Total entradas: ${audioUrlCache.size}`);
            }

            // ── 3. CONSTRUIR ARGUMENTOS DE FFMPEG ─────────────────────────
            const esLive = track.live || false;

            const args = [
                '-reconnect',           '1',
                '-reconnect_streamed',  '1',
                '-reconnect_delay_max', '10',
                '-headers',          'User-Agent: Mozilla/5.0\r\n',
                '-timeout',          '15000000',   // 15s timeout en microsegundos
                '-rw_timeout',       '15000000',   // 15s read/write timeout
                ...(esLive ? ['-reconnect_at_eof', '1'] : []),
                '-probesize',           '512K',
                '-analyzeduration',     '512K',
                '-loglevel',            'warning', // 'warning' en vez de 'error' para capturar más info de FFmpeg
                '-i',                   audioUrl,
                '-vn',
            ];

            if (isOpusCopy) {
                console.log(`[Audio-Engine] ℹ️ Opus nativo detectado → forzando ENCODE para evitar throttling de YouTube`);
            }

            args.push(
                '-af',  'dynaudnorm=f=150:g=15:p=0.95',
                '-c:a', 'libopus',
                '-ar',  '48000',
                '-ac',  '2',
                '-b:a', `${targetBitrate}k`,
                '-f',   'opus'   // ← siempre presente, sin importar isOpusCopy
            );
            console.log(`[Audio-Engine] 🔄 ENCODE ${targetBitrate}kbps | Canal: ${channelBitrate}kbps | Live: ${esLive} | opusNativo: ${isOpusCopy}`);

            args.push('pipe:1');

            // ── 4. SPAWN FFMPEG ────────────────────────────────────────────
            const tSpawn = Date.now();
            const ffmpegProcess = spawn('ffmpeg', args, {
                stdio: ['ignore', 'pipe', 'pipe'],
            });

            const pid = ffmpegProcess.pid;
            console.log(`[FFmpeg] 🚀 Proceso iniciado | PID: ${pid} | Streams activos: ${streamsActivos}`);

            // ── Monitoreo de bytes emitidos por FFmpeg ─────────────────────
            let bytesEmitidos = 0;
            let primerDatoMs = null;
            let ultimoChunkMs = Date.now();
            let silencioAlertado = false;

            // Intervalo de watchdog: detecta si FFmpeg deja de emitir datos (silencio intermitente)
            const watchdogInterval = setInterval(() => {
                const silencioMs = Date.now() - ultimoChunkMs;
                const ramLibre = os.freemem();
                const load = os.loadavg()[0];

                if (silencioMs > 3000 && !silencioAlertado) {
                    silencioAlertado = true;
                    console.warn(`\n⚠️  [WATCHDOG:PID:${pid}] SILENCIO DE AUDIO DETECTADO`);
                    console.warn(`   Sin datos de FFmpeg por: ${(silencioMs / 1000).toFixed(1)}s`);
                    console.warn(`   RAM libre: ${(ramLibre / 1024 / 1024).toFixed(1)} MB`);
                    console.warn(`   CPU load: ${load.toFixed(2)}`);
                    console.warn(`   Bytes emitidos hasta ahora: ${(bytesEmitidos / 1024).toFixed(1)} KB`);
                    if (ramLibre < 100 * 1024 * 1024) {
                        console.error(`   🔴 CAUSA PROBABLE: RAM CRÍTICA (${(ramLibre / 1024 / 1024).toFixed(1)} MB libres) — el sistema está usando SWAP HDD`);
                    }
                    if (load > 1.5) {
                        console.error(`   🔴 CAUSA PROBABLE: CPU SATURADA (load: ${load.toFixed(2)}) — FFmpeg no tiene tiempo de CPU`);
                    }
                } else if (silencioMs <= 3000 && silencioAlertado) {
                    silencioAlertado = false;
                    console.log(`[WATCHDOG:PID:${pid}] ✅ Audio reanudado tras ${(silencioMs / 1000).toFixed(1)}s de silencio`);
                }
            }, 1000);

            ffmpegProcess.stdout.on('data', (chunk) => {
                bytesEmitidos += chunk.length;
                ultimoChunkMs = Date.now();

                if (!primerDatoMs) {
                    primerDatoMs = Date.now();
                    console.log(`[FFmpeg:PID:${pid}] ⚡ Primer chunk de audio en ${primerDatoMs - tSpawn}ms desde spawn | tamaño: ${chunk.length} bytes`);
                    if ((primerDatoMs - tSpawn) > 5000) {
                        console.warn(`⚠️  [FFmpeg:PID:${pid}] Arranque lento (${primerDatoMs - tSpawn}ms). RAM: ${(os.freemem() / 1024 / 1024).toFixed(1)} MB libre, CPU: ${os.loadavg()[0].toFixed(2)}`);
                    }
                }

                // Log de progreso cada 1MB
                if (bytesEmitidos % (1024 * 1024) < chunk.length) {
                    console.log(`[FFmpeg:PID:${pid}] 📊 ${(bytesEmitidos / 1024 / 1024).toFixed(1)} MB emitidos | RAM libre: ${(os.freemem() / 1024 / 1024).toFixed(1)} MB | CPU: ${os.loadavg()[0].toFixed(2)}`);
                }
            });

            ffmpegProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (!msg) return;

                // Clasifica y loguea el mensaje de FFmpeg
                const esErrorNormal = msg.includes('I/O error') || msg.includes('End of file');
                const es10054      = msg.includes('10054');
                const esWarning    = msg.toLowerCase().includes('warning') || msg.toLowerCase().includes('deprecated');
                const esError      = msg.toLowerCase().includes('error') || msg.toLowerCase().includes('invalid') || msg.toLowerCase().includes('failed');

                if (es10054 && !esLive) {
                    console.debug(`[FFmpeg:PID:${pid}] Fin de stream normal (-10054, audio pregrabado)`);
                } else if (es10054 && esLive) {
                    console.error(`[FFmpeg:PID:${pid}] 🔴 Reset de conexión en LIVE (-10054). Re-sincronizando...`);
                } else if (esWarning) {
                    console.warn(`[FFmpeg:PID:${pid}] ⚠️ WARN: ${msg}`);
                } else if (esError && !esErrorNormal) {
                    console.error(`[FFmpeg:PID:${pid}] 🔴 ERROR: ${msg}`);
                    // Log del estado del sistema cuando FFmpeg reporta un error real
                    console.error(`[FFmpeg:PID:${pid}]    → RAM libre: ${(os.freemem() / 1024 / 1024).toFixed(1)} MB | CPU: ${os.loadavg()[0].toFixed(2)}`);
                } else if (!esErrorNormal) {
                    // Cualquier otro output de FFmpeg (info general)
                    console.log(`[FFmpeg:PID:${pid}] INFO: ${msg}`);
                }
            });

            ffmpegProcess.on('close', (code, signal) => {
                streamsActivos = Math.max(0, streamsActivos - 1);
                clearInterval(watchdogInterval);

                const duracionTotal = ((Date.now() - tSpawn) / 1000).toFixed(1);
                const kbEmitidos    = (bytesEmitidos / 1024).toFixed(1);

                console.log(`\n[FFmpeg:PID:${pid}] ⏹  Proceso cerrado`);
                console.log(`   Código de salida : ${code} | Señal: ${signal || 'ninguna'}`);
                console.log(`   Duración stream  : ${duracionTotal}s`);
                console.log(`   Datos emitidos   : ${kbEmitidos} KB`);
                console.log(`   Primer chunk en  : ${primerDatoMs ? (primerDatoMs - tSpawn) + 'ms' : 'nunca llegó'}`);
                console.log(`   Streams activos  : ${streamsActivos}`);
                logSistema('STREAM_END');

                if (code !== 0 && code !== null) {
                    if (isOpusCopy) {
                        const entry = audioUrlCache.get(cleanUrl);
                        if (entry) {
                            audioUrlCache.set(cleanUrl, { ...entry, isOpusCopy: false });
                            console.warn(`[Audio-Engine:PID:${pid}] ⚠️ Copy falló (código ${code}) → cache actualizado a ENCODE`);
                        }
                    }
                    console.warn(`[FFmpeg:PID:${pid}] ⚠️ Proceso terminó con código ${code}`);
                } else {
                    console.log(`[FFmpeg:PID:${pid}] ✅ Proceso terminó normalmente (código ${code})`);
                }
            });

            ffmpegProcess.on('error', (err) => {
                streamsActivos = Math.max(0, streamsActivos - 1);
                clearInterval(watchdogInterval);
                console.error(`[FFmpeg:PID:${pid}] 🔴 Error de proceso spawn: ${err.message}`);
                logSistema('STREAM_ERROR');
            });

            // ── 5. TIMEOUT: evita que FFmpeg quede zombie ─────────────────
            const timeout = setTimeout(() => {
                if (!ffmpegProcess.killed) {
                    console.warn(`[FFmpeg:PID:${pid}] ⚠️ Timeout de 20s sin primer chunk — matando proceso zombie`);
                    logSistema('STREAM_TIMEOUT');
                    ffmpegProcess.kill('SIGKILL');
                }
            }, 20000);

            ffmpegProcess.stdout.once('data', () => {
                clearTimeout(timeout);
                console.log(`[FFmpeg:PID:${pid}] ✅ Timeout cancelado — datos recibidos`);
            });

            console.log(`[STREAM] ✅ Stream configurado y listo. Tiempo de preparación: ${Date.now() - t0}ms`);

            return {
                stream:        ffmpegProcess.stdout,
                type:          StreamType.Opus,
                highWaterMark: 1 << 20, // 1MB — más colchón para absorber las pausas del throttling
            };

        } catch (e) {
            streamsActivos = Math.max(0, streamsActivos - 1);
            console.error(`[YoutubeExt stream] 🔴 ERROR CRÍTICO: ${e.message}`);
            logSistema('STREAM_CRITICAL_ERROR');
            throw e;
        }
    }*/
    async stream(track) {
        const t0 = Date.now();
        const trackLabel = `"${track.title?.slice(0, 50) || 'sin título'}"`;

        console.log(`\n╔══════════════════════════════════════════════════════════`);
        console.log(`║ [STREAM] ▶ Iniciando stream de ${trackLabel}`);
        console.log(`╚══════════════════════════════════════════════════════════`);
        logSistema('STREAM_START');

        streamsActivos++;
        if (streamsActivos > 1) {
            console.warn(`⚠️  [STREAM] ${streamsActivos} streams activos simultáneamente.`);
        }

        try {
            const cleanUrl = cleanYoutubeUrl(track.url);
            if (!cleanUrl) throw new Error('URL no permitida o malformada');

            // ── BITRATE DEL CANAL ──────────────────────────────────────────────
            let channelBitrate = 96;
            let channelName = 'desconocido';
            try {
                const guildId = track.metadata?.guildId || track.queue?.metadata?.guildId;
                const guild = this.context.player.client.guilds.cache.get(guildId);
                const voiceChannelId = guild?.members.me?.voice.channelId;
                if (voiceChannelId) {
                    const freshChannel = await this.context.player.client.channels.fetch(voiceChannelId, { force: true });
                    if (freshChannel?.bitrate) {
                        channelBitrate = freshChannel.bitrate / 1000;
                        channelName = freshChannel.name || channelName;
                    }
                }
                console.log(`[STREAM] Canal de voz: "${channelName}" | Bitrate real: ${channelBitrate}kbps`);
            } catch (e) {
                console.warn(`[STREAM] ⚠️ Error al leer bitrate: ${e.message} → fallback 96k`);
            }

            const targetBitrate = channelBitrate <= 96  ? 96
                                : channelBitrate <= 256 ? channelBitrate
                                : 256;
            console.log(`[STREAM] Target bitrate: ${targetBitrate}kbps`);

            const esLive = track.live || false;

            // ── YTDLP → stdout → FFmpeg stdin ──────────────────────────────────
            // En lugar de extraer la URL y pasársela a FFmpeg (donde YouTube
            // throttlea el HTTP), dejamos que yt-dlp descargue y escriba a su
            // stdout, y FFmpeg lee desde su stdin. Así yt-dlp maneja la
            // conexión con YouTube (con su lógica de reintentos y throttling)
            // y FFmpeg solo se encarga de encodear lo que recibe.
            console.log(`[STREAM] Iniciando pipeline yt-dlp → FFmpeg (sin URL directa)`);
            const tSpawn = Date.now();

            // Spawn yt-dlp escribiendo audio a stdout
            // --- EN musicPlayer.js (~Línea 445 en adelante) ---
            const ytdlpArgs = [
                '--no-warnings',
                '--no-check-certificates',
                '--no-playlist',
                // 1. Priorizamos el formato 251 (Opus) que es el más ligero para tu CPU
                '--format', 'bestaudio', 
                // 2. Usamos el cliente de iOS, que suele recibir menos restricciones en centros de datos
                '--extractor-args', 'youtube:player_client=ios,web',
                // 3. Mantenemos Node para resolver los desafíos de JS rápido
                '--js-runtimes', 'node',
                '--concurrent-fragments', '1',
                '--retries', '10',
                // 4. Agregamos un User-Agent real para no parecer un bot genérico
                '--user-agent', 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
                '--output', '-',
                cleanUrl
            ];

            // Agrega cookie si está disponible
            if (youtubeCookie) {
                const cookieNetscape = path.join(__dirname, '../config/youtube-cookie.txt');
                const cookieJson     = path.join(__dirname, '../config/youtube-cookie.json');

                if (fs.existsSync(cookieNetscape)) {
                    ytdlpArgs.unshift('--cookies', cookieNetscape);
                    console.log(`[yt-dlp] 🍪 Cookie Netscape cargada: ${cookieNetscape}`);
                } else if (fs.existsSync(cookieJson)) {
                    console.warn(`[yt-dlp] ⚠️ Solo existe youtube-cookie.json — yt-dlp necesita formato Netscape (.txt)`);
                    console.warn(`[yt-dlp]    Convierte con el script de conversión y reinicia el bot`);
                    // No pasar cookie — yt-dlp intentará sin autenticación
                }
            }

            console.log(`[yt-dlp] Argumentos: yt-dlp ${ytdlpArgs.filter(a => !a.includes('cookie')).join(' ')}`);

            const ytdlpProcess = spawn(YTDLP_BIN, ytdlpArgs, {
                stdio: ['ignore', 'pipe', 'pipe']
            });

            // FFmpeg lee desde stdin (pipe) en lugar de una URL HTTP
            const ffmpegArgs = [
                '-loglevel',  'warning',
                '-analyzeduration', '0',
                '-probesize', '32k',
                '-fflags',    '+discardcorrupt+genpts+nobuffer+igndts+flush_packets', 
                '-i',         'pipe:0',
                '-vn',
                '-max_muxing_queue_size', '4096', // ⬅️ Mantenlo aquí, después del -i
                '-acodec', 'libopus',
                '-application', 'voip', 
                '-compression_level', '0', 
                '-ar',   '48000',
                '-ac',   '2',
                '-b:a',  `${targetBitrate}k`,
                '-f',    'opus',
                'pipe:1'
            ];

            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, {
                stdio: ['pipe', 'pipe', 'pipe']
            });

            const pid = `ytdlp:${ytdlpProcess.pid}/ffmpeg:${ffmpegProcess.pid}`;
            console.log(`[STREAM] 🚀 Pipeline iniciado | PIDs: ${pid} | Streams activos: ${streamsActivos}`);

            // Conectar stdout de yt-dlp → stdin de FFmpeg
            ytdlpProcess.stdout.pipe(ffmpegProcess.stdin);

            // Si yt-dlp termina con error, destruimos el pipe de FFmpeg
            ytdlpProcess.on('close', (code) => {
                if (code !== 0 && code !== null) {
                    console.error(`[yt-dlp:PID:${ytdlpProcess.pid}] ⚠️ Terminó con código ${code}`);
                } else {
                    console.log(`[yt-dlp:PID:${ytdlpProcess.pid}] ✅ Descarga completa (código ${code})`);
                }
                // Cerrar stdin de FFmpeg para que sepa que no hay más datos
                ffmpegProcess.stdin.end();
            });

            ytdlpProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (msg) console.log(`[yt-dlp:PID:${ytdlpProcess.pid}] ${msg}`);
            });

            // ── Monitoreo FFmpeg ───────────────────────────────────────────────
            let bytesEmitidos = 0;
            let primerDatoMs = null;
            let ultimoChunkMs = Date.now();
            let silencioAlertado = false;

            const watchdogInterval = setInterval(() => {
                const silencioMs = Date.now() - ultimoChunkMs;
                const ramLibre = os.freemem();
                const load = os.loadavg()[0];

                if (silencioMs > 3000 && !silencioAlertado) {
                    silencioAlertado = true;
                    console.warn(`\n⚠️  [WATCHDOG:${pid}] SILENCIO DE AUDIO`);
                    console.warn(`   Sin datos: ${(silencioMs / 1000).toFixed(1)}s | RAM: ${(ramLibre / 1024 / 1024).toFixed(1)} MB | CPU: ${load.toFixed(2)}`);
                    console.warn(`   Bytes emitidos: ${(bytesEmitidos / 1024).toFixed(1)} KB`);
                } else if (silencioMs <= 3000 && silencioAlertado) {
                    silencioAlertado = false;
                    console.log(`[WATCHDOG:${pid}] ✅ Audio reanudado`);
                }
            }, 1000);

            ffmpegProcess.stdout.on('data', (chunk) => {
                bytesEmitidos += chunk.length;
                ultimoChunkMs = Date.now();
                if (!primerDatoMs) {
                    primerDatoMs = Date.now();
                    console.log(`[FFmpeg] ⚡ Primer chunk en ${primerDatoMs - tSpawn}ms | ${chunk.length} bytes`);
                }
                if (bytesEmitidos % (1024 * 1024) < chunk.length) {
                    console.log(`[FFmpeg] 📊 ${(bytesEmitidos / 1024 / 1024).toFixed(1)} MB emitidos | RAM: ${(os.freemem() / 1024 / 1024).toFixed(1)} MB | CPU: ${os.loadavg()[0].toFixed(2)}`);
                }
            });

            ffmpegProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (!msg) return;
                
                // Filtrar spam de errores AAC — son normales con +discardcorrupt
                const esSpamAAC = msg.includes('[aac @') || 
                                msg.includes('aist#0') ||
                                msg.includes('dec:aac');
                if (esSpamAAC) return; // silenciar completamente

                const esSpamDTS = msg.includes('Non-monotonic DTS') || 
                  msg.includes('Queue input is backward') ||
                  msg.includes('invalid as first byte of an EBML');
                if (esSpamDTS) return; // silenciar completamente
                
                const esError   = msg.toLowerCase().includes('error') || msg.toLowerCase().includes('invalid');
                const esWarning = msg.toLowerCase().includes('warning');
                if (esError)        console.error(`[FFmpeg:${ffmpegProcess.pid}] 🔴 ${msg}`);
                else if (esWarning) console.warn(`[FFmpeg:${ffmpegProcess.pid}] ⚠️ ${msg}`);
                else                console.log(`[FFmpeg:${ffmpegProcess.pid}] ${msg}`);
            });

            ffmpegProcess.on('close', (code, signal) => {
                streamsActivos = Math.max(0, streamsActivos - 1);
                clearInterval(watchdogInterval);
                // Asegura que yt-dlp también muera si FFmpeg cierra primero
                if (!ytdlpProcess.killed) ytdlpProcess.kill('SIGKILL');

                console.log(`\n[FFmpeg:${ffmpegProcess.pid}] ⏹ Cerrado | código: ${code} | señal: ${signal || 'ninguna'}`);
                console.log(`   Duración: ${((Date.now() - tSpawn) / 1000).toFixed(1)}s | Emitidos: ${(bytesEmitidos / 1024).toFixed(1)} KB`);
                console.log(`   Primer chunk: ${primerDatoMs ? (primerDatoMs - tSpawn) + 'ms' : 'nunca'} | Streams activos: ${streamsActivos}`);
                logSistema('STREAM_END');
            });

            ffmpegProcess.on('error', (err) => {
                streamsActivos = Math.max(0, streamsActivos - 1);
                clearInterval(watchdogInterval);
                if (!ytdlpProcess.killed) ytdlpProcess.kill('SIGKILL');
                console.error(`[FFmpeg] 🔴 Error de spawn: ${err.message}`);
            });

            // Timeout: si no llega ningún chunk en 25s algo salió muy mal
            const timeout = setTimeout(() => {
                if (!ffmpegProcess.killed) {
                    console.warn(`[STREAM] ⚠️ Timeout 25s sin audio — matando pipeline`);
                    ytdlpProcess.kill('SIGKILL');
                    ffmpegProcess.kill('SIGKILL');
                }
            }, 60000);
            ffmpegProcess.stdout.once('data', () => {
                clearTimeout(timeout);
                console.log(`[STREAM] ✅ Timeout cancelado — pipeline activo`);
            });

            console.log(`[STREAM] ✅ Pipeline listo. Preparación: ${Date.now() - t0}ms`);

            return {
                stream:        ffmpegProcess.stdout,
                type:          StreamType.Opus,
                highWaterMark: 1 << 23, // 8MB
            };

        } catch (e) {
            streamsActivos = Math.max(0, streamsActivos - 1);
            console.error(`[STREAM] 🔴 ERROR CRÍTICO: ${e.message}`);
            logSistema('STREAM_CRITICAL_ERROR');
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
            logSistema('PLAYER_INIT_OK');
        } catch (e) {
            console.error(`» | Error al inicializar motores: ${e.message}`);
        }
    })();

    // ── Limpieza de botones al vaciar cola o desconectar ──────────────────
    const limpiarInterfaz = async (queue) => {
        if (queue.metadata?.ultimoMensaje) {
            await queue.metadata.ultimoMensaje.edit({ components: [] }).catch(() => null);
            queue.metadata.ultimoMensaje = null;
        }
    };

    // ── playerStart ───────────────────────────────────────────────────────
    player.events.on('playerStart', async (queue, track) => {
        if (track.url.includes('translate_tts')) return;

        console.log(`\n[Event:playerStart] 🎵 "${track.title?.slice(0, 60)}" | Duración: ${track.duration}`);
        logSistema('PLAYER_START_EVENT');

        if (queue.metadata?.ultimoMensaje) {
            const deshabilitado = (btn) => ButtonBuilder.from(btn).setDisabled(true);
            try {
                const msgAnterior = queue.metadata.ultimoMensaje;
                const filasDeshabilitadas = msgAnterior.components.map(fila =>
                    ActionRowBuilder.from(fila).setComponents(fila.components.map(deshabilitado))
                );
                await msgAnterior.edit({ components: filasDeshabilitadas }).catch(() => null);
                console.log('[playerStart] Botones del mensaje anterior deshabilitados.');
            } catch (e) {
                console.warn(`[playerStart] No se pudo deshabilitar mensaje anterior: ${e.message}`);
            }
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
            }).catch((e) => {
                console.warn(`[playerStart] No se pudo enviar embed al canal: ${e.message}`);
                return null;
            });

            queue.metadata.ultimoMensaje = mensaje;
            console.log(`[playerStart] ✅ Embed enviado al canal.`);
        } else {
            console.warn('[playerStart] ⚠️ queue.metadata.canal no disponible — no se envió embed.');
        }
    });

    player.events.on('emptyQueue', (queue) => {
        console.log('[Event:emptyQueue] Cola vacía. Limpiando interfaz.');
        limpiarInterfaz(queue);
        logSistema('QUEUE_EMPTY');
    });

    player.events.on('disconnect', (queue) => {
        console.log('[Event:disconnect] Bot desconectado del canal de voz. Limpiando interfaz.');
        limpiarInterfaz(queue);
        logSistema('DISCONNECT');
    });

    player.events.on('error', (queue, error) => {
        console.error(`[Event:error] Error de Sistema: ${error.message}`);
        logSistema('PLAYER_ERROR');
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
        console.error(`[Event:playerError] Error de Audio: ${error.message}`);
        logSistema('PLAYER_AUDIO_ERROR');
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