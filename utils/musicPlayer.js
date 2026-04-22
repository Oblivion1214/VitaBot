// utils/musicPlayer.js — VitaBot
// Motor de audio: arquitectura híbrida PC Local (Tailscale-Windows) + VM fallback(linux)
// VM fallback usa: URL cache + detección opus/copy + ffmpeg-static (sin throttling)
const path = require('path');
const os = require('os');
const http = require('http');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Player, BaseExtractor, Track, Playlist } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const { StreamType } = require('@discordjs/voice');
const { spawn, execSync } = require('child_process');
const ffmpegPath = require('ffmpeg-static'); // ← usado solo en VM fallback
const youtubeExt = require('youtube-ext');
const youtubedl = require('youtube-dl-exec');
const fs = require('fs');
const { log, sanitizeErrorMessage } = require('./logger');

// ─────────────────────────────────────────────
// CONFIGURACIÓN HÍBRIDA — PC Local vía Tailscale
// ─────────────────────────────────────────────
const PC_AUDIO_HOST  = '100.127.221.32';
const PC_AUDIO_PORT  = 3000;
const PC_HEALTH_URL  = `http://${PC_AUDIO_HOST}:${PC_AUDIO_PORT}/health`;
const PC_STREAM_BASE = `http://${PC_AUDIO_HOST}:${PC_AUDIO_PORT}/stream`;

let pcLocalDisponible    = false;
let ultimaVerificacionPC = 0;
const PC_CHECK_INTERVAL  = 30_000; // reverifica cada 30s
const PC_TIMEOUT_MS      = 4_000;  // timeout para el health check

// ─────────────────────────────────────────────
// DIAGNÓSTICO DEL SISTEMA
// ─────────────────────────────────────────────
function logSistema(tag = 'BOOT') {
    const totalMem = os.totalmem();
    const freeMem  = os.freemem();
    const usedMem  = totalMem - freeMem;
    const heap     = process.memoryUsage();
    const loadAvg  = os.loadavg();
    const uptime   = (process.uptime() / 60).toFixed(1);

    console.log(`\n┌─────────────────────────── [PERF:${tag}] ───────────────────────────`);
    console.log(`│ 🖥  RAM Sistema : ${(usedMem / 1024 / 1024).toFixed(1)} MB / ${(totalMem / 1024 / 1024).toFixed(1)} MB  (libre: ${(freeMem / 1024 / 1024).toFixed(1)} MB)`);
    console.log(`│ 🟩 Node Heap   : ${(heap.heapUsed / 1024 / 1024).toFixed(1)} MB / ${(heap.heapTotal / 1024 / 1024).toFixed(1)} MB`);
    console.log(`│ 📦 Node RSS    : ${(heap.rss / 1024 / 1024).toFixed(1)} MB`);
    console.log(`│ ⚡ CPU LoadAvg : ${loadAvg[0].toFixed(2)} (1m) | ${loadAvg[1].toFixed(2)} (5m) | ${loadAvg[2].toFixed(2)} (15m)`);
    console.log(`│ ⏱  Uptime Bot  : ${uptime} min`);
    console.log(`│ 🏠 PC Local    : ${pcLocalDisponible ? '✅ ONLINE' : '❌ OFFLINE (usando VM fallback)'}`);
    console.log(`└────────────────────────────────────────────────────────────────────\n`);

    if (freeMem < 150 * 1024 * 1024) {
        console.warn(`⚠️  [PERF:${tag}] RAM CRÍTICA: ${(freeMem / 1024 / 1024).toFixed(1)} MB libres`);
    }
    if (loadAvg[0] > 1.5) {
        console.warn(`⚠️  [PERF:${tag}] CPU SATURADA: load avg ${loadAvg[0].toFixed(2)}`);
    }
}

// ─────────────────────────────────────────────
// VERIFICADOR DE PC LOCAL
// ─────────────────────────────────────────────
function verificarPCLocal() {
    return new Promise((resolve) => {
        const ahora = Date.now();

        if (ahora - ultimaVerificacionPC < PC_CHECK_INTERVAL) {
            resolve(pcLocalDisponible);
            return;
        }

        ultimaVerificacionPC = ahora;

        const req = http.get(PC_HEALTH_URL, { timeout: PC_TIMEOUT_MS }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const estadoAnterior = pcLocalDisponible;
                    pcLocalDisponible = json.available === true;
                    if (!estadoAnterior && pcLocalDisponible) {
                        console.log(`[PC-Check] ✅ PC Local ONLINE — streams activos: ${json.streamsActivos}`);
                    }
                    resolve(pcLocalDisponible);
                } catch {
                    pcLocalDisponible = false;
                    resolve(false);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (pcLocalDisponible) {
                console.warn(`[PC-Check] ⚠️ PC Local no responde (timeout ${PC_TIMEOUT_MS}ms) → VM fallback`);
            }
            pcLocalDisponible = false;
            ultimaVerificacionPC = 0;
            resolve(false);
        });

        req.on('error', () => {
            if (pcLocalDisponible) {
                console.warn(`[PC-Check] ⚠️ PC Local OFFLINE → VM fallback`);
            }
            pcLocalDisponible = false;
            ultimaVerificacionPC = 0;
            resolve(false);
        });
    });
}

// Verificación inicial al cargar el módulo
verificarPCLocal().then((online) => {
    console.log(`[PC-Check] Estado inicial: ${online ? '✅ PC ONLINE' : '❌ PC OFFLINE — se usará VM'}`);
});

// ─────────────────────────────────────────────
// COOKIE DE YOUTUBE
// ─────────────────────────────────────────────
let youtubeCookie = '';
try {
    const cookiePath = path.join(__dirname, '../config/youtube-cookie.json');
    youtubeCookie = fs.readFileSync(cookiePath, 'utf-8').trim().replace(/^\"|\"$/g, '');
    console.log('» | [Music] Cookie de YouTube cargada desde /config.');
} catch {
    console.warn('» | [Music] Sin cookie de YouTube en /config.');
}

// ─────────────────────────────────────────────
// CACHÉ DE URLs DE AUDIO (VM fallback)
// Cacheamos la URL del audio extraída, NO el stream.
// Las URLs de YouTube expiran ~6h; usamos 12min para máxima seguridad.
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
        console.log(`[CACHE] 🧹 ${eliminadas} URL(s) expiradas. Restantes: ${audioUrlCache.size}`);
    }
    logSistema('CACHE_GC');
}, 1000 * 60 * 5).unref();

// ─────────────────────────────────────────────
// CONTADOR DE STREAMS ACTIVOS (VM)
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
        .replace(/\(Letra Oficial\)/gi, '').replace(/\(Letra\)/gi, '')
        .replace(/\(Letra Lyrics\)/gi, '').replace(/\(Video Oficial\)/gi, '')
        .replace(/\(Video\)/gi, '').replace(/\(Official Video\)/gi, '')
        .replace(/\(Lyrics\)/gi, '').replace(/\(Audio Oficial\)/gi, '')
        .replace(/\(Lyrics Video\)/gi, '').replace(/\(Cover Audio\)/gi, '')
        .replace(/\(Official Live Video\)/gi, '').replace(/\(Live Video\)/gi, '')
        .replace(/\(Official Live\)/gi, '').replace(/\[.*?\]/g, '')
        .replace(/"/g, '').replace(/\s+/g, ' ').trim();

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
// HELPER: Construir Track
// ─────────────────────────────────────────────
function buildTrack(player, data, context, extractor) {
    const track = new Track(player, {
        title:       data.title,
        url:         data.url,
        duration:    data.duration || '0:00',
        thumbnail:   data.thumbnail || '',
        author:      data.author || 'Desconocido',
        requestedBy: context.requestedBy,
        source:      data.source || 'youtube',
        queryType:   data.queryType || context.type,
        description: data.description || '',
        views:       data.views || 0,
        live:        data.live || false,
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
            console.log(`[Validate] ❌ URL rechazada: ${query.slice(0, 60)}`);
            return false;
        }
        console.log(`[Validate] ✅ Query aceptada: "${query.slice(0, 80)}"`);
        return true;
    }

    async handle(query, context) {
        const t0 = Date.now();
        console.log(`\n[Handle] ▶ Resolviendo: "${query.slice(0, 80)}"`);
        logSistema('HANDLE_START');

        try {
            // ── 1. SPOTIFY ────────────────────────────────────────────────
            if (query.includes('spotify.com/track/')) {
                console.log('[Spotify] 🎵 Track de Spotify detectado.');
                const trackId = query.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                if (!trackId) return { playlist: null, tracks: [] };

                const t1 = Date.now();
                const oembedRes = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${trackId}`);
                if (!oembedRes.ok) throw new Error('Spotify oEmbed falló');
                const oembed = await oembedRes.json();
                console.log(`[Spotify] oEmbed OK en ${Date.now() - t1}ms → "${oembed.title}"`);

                const t2 = Date.now();
                const results = await youtubeExt.search(oembed.title, { type: 'video', limit: 1 });
                console.log(`[Spotify] YT en ${Date.now() - t2}ms → ${results?.videos?.length || 0} resultados`);
                if (!results?.videos?.length) return { playlist: null, tracks: [] };

                const video    = results.videos[0];
                const videoUrl = cleanYoutubeUrl(video.url);
                if (!videoUrl) return { playlist: null, tracks: [] };

                const track = buildTrack(this.context.player, {
                    title:     oembed.title || video.title,
                    url:       videoUrl,
                    duration:  video.duration?.text || '0:00',
                    thumbnail: oembed.thumbnail_url || video.thumbnails?.[0]?.url || '',
                    author:    video.channel?.name || 'Desconocido',
                    source:    'spotify',
                }, context, this);

                console.log(`[Spotify] ✅ "${track.title}" en ${Date.now() - t0}ms`);
                return { playlist: null, tracks: [track] };
            }

            // ── 2. PLAYLIST ───────────────────────────────────────────────
            if (query.includes('list=')) {
                console.log('[DATA-SCAN] 🔍 Playlist detectada...');
                logSistema('PLAYLIST_FETCH');
                let playlistData = null;

                try {
                    const t1 = Date.now();
                    const output = await youtubedl(query, {
                        dumpSingleJson: true, flatPlaylist: true,
                        noCheckCertificates: true, quiet: true, noWarnings: true
                    }, { maxBuffer: 1024 * 1024 * 100 });

                    const json = (typeof output === 'string') ? JSON.parse(output) : output;
                    console.log(`[DATA-SCAN] yt-dlp OK en ${Date.now() - t1}ms`);

                    if (json?.entries?.length || json?.videos?.length) {
                        const entries = json.entries || json.videos;
                        playlistData = {
                            title:     json.title || 'Playlist de YouTube',
                            author:    json.uploader || 'YouTube',
                            thumbnail: json.thumbnails?.[0]?.url || '',
                            videos:    entries.filter(e => e && (e.id || e.url)).map(entry => ({
                                title:     entry.title || 'Video sin título',
                                url:       entry.id ? `https://www.youtube.com/watch?v=${entry.id}` : entry.url,
                                duration:  entry.duration ? secondsToTime(entry.duration) : '0:00',
                                thumbnail: entry.thumbnails?.[0]?.url || '',
                                author:    entry.uploader || json.uploader || 'YouTube'
                            }))
                        };
                    }
                } catch (e) {
                    console.warn(`[DATA-SCAN] yt-dlp falló: ${e.message}`);
                }

                if (!playlistData) {
                    console.log('[DATA-SCAN] Reintentando con youtube-ext...');
                    playlistData = await youtubeExt.playlistInfo(query, {
                        requestOptions: { headers: { cookie: youtubeCookie } }
                    }).catch((e) => {
                        console.warn(`[DATA-SCAN] youtube-ext falló: ${e.message}`);
                        return null;
                    });
                }

                if (playlistData?.videos?.length > 0) {
                    const MAX_TRACKS = 200;
                    if (playlistData.videos.length > MAX_TRACKS) {
                        playlistData.videos = playlistData.videos.slice(0, MAX_TRACKS);
                    }

                    const tracks = playlistData.videos
                        .filter(v => v?.title && v?.url)
                        .map((video, index) => {
                            const track = buildTrack(this.context.player, {
                                title:     video.title,
                                url:       video.url,
                                duration:  typeof video.duration === 'string' ? video.duration : '0:00',
                                thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || '',
                                author:    video.author || 'YouTube Playlist',
                                source:    'youtube',
                                queryType: 'youtubePlaylist',
                            }, context, this);
                            if (index % 10 === 0) console.log(`[TRACK] Pista ${index}: "${track.title}"`);
                            return track;
                        });

                    const playlist = new Playlist(this.context.player, {
                        title:     playlistData.title || 'Playlist',
                        url:       query,
                        thumbnail: playlistData.thumbnail || '',
                        author:    { name: playlistData.author || 'YouTube', url: '' },
                        tracks,
                        source:    'youtube',
                        type:      'playlist'
                    });

                    console.log(`[Handle] ✅ Playlist "${playlist.title}" | ${tracks.length} tracks | ${Date.now() - t0}ms`);
                    return { playlist, tracks };
                }

                console.error('[Handle] No se encontraron videos en la playlist.');
                return { playlist: null, tracks: [] };
            }

            // ── 3. LINK DIRECTO ───────────────────────────────────────────
            if (query.includes('youtube.com') || query.includes('youtu.be')) {
                const videoUrl = cleanYoutubeUrl(query);
                if (!videoUrl) return { playlist: null, tracks: [] };

                console.log(`[Handle] 🔗 Link directo: ${videoUrl}`);
                const t1  = Date.now();
                const info = await youtubeExt.videoInfo(videoUrl, {
                    requestOptions: { headers: { cookie: youtubeCookie } }
                });
                console.log(`[Handle] videoInfo en ${Date.now() - t1}ms → "${info?.title || 'N/A'}"`);

                if (!info?.title) return { playlist: null, tracks: [] };

                const track = buildTrack(this.context.player, {
                    title:       info.title,
                    url:         videoUrl,
                    duration:    secondsToTime(info.duration?.lengthSec),
                    thumbnail:   info.thumbnails?.[0]?.url || '',
                    author:      info.channel?.name || 'Desconocido',
                    source:      'youtube',
                    description: info.shortDescription || '',
                    views:       info.views?.pretty || 0,
                    live:        info.isLive || false,
                }, context, this);

                console.log(`[Handle] ✅ "${track.title}" en ${Date.now() - t0}ms`);
                return { playlist: null, tracks: [track] };
            }

            // ── 4. BÚSQUEDA LIBRE ─────────────────────────────────────────
            const searchQuery = query.includes('music') ? query : `${query} music topic`;
            console.log(`[Handle] 🔍 Búsqueda: "${searchQuery}"`);

            const t1      = Date.now();
            const results = await youtubeExt.search(searchQuery, { type: 'video', limit: 10 });
            console.log(`[Handle] Búsqueda en ${Date.now() - t1}ms → ${results?.videos?.length || 0} resultados`);

            if (!results?.videos?.length) return { playlist: null, tracks: [] };

            const tracks = results.videos
                .filter(v => v?.url)
                .map(video => buildTrack(this.context.player, {
                    title:     video.title,
                    url:       cleanYoutubeUrl(video.url),
                    duration:  video.duration?.text || '0:00',
                    thumbnail: video.thumbnails?.[0]?.url || '',
                    author:    video.channel?.name || 'YouTube Music',
                    source:    'youtube',
                }, context, this));

            console.log(`[Handle] ✅ ${tracks.length} tracks en ${Date.now() - t0}ms`);
            return { playlist: null, tracks };

        } catch (e) {
            if (e instanceof SyntaxError || e.message?.includes('Unexpected non-whitespace')) {
                console.warn('[Handle] Error de parseo JSON.');
            } else {
                console.error('[Handle] ERROR:', e.message);
            }
            return { playlist: null, tracks: [] };
        }
    }

    // ─────────────────────────────────────────────
    // STREAM — Arquitectura híbrida
    //
    // MODO 1 (PC Local): La PC procesa yt-dlp + FFmpeg con alta calidad.
    //                    La VM solo recibe el stream Opus listo para Discord.
    //
    // MODO 2 (VM fallback): Usa yt-dlp para extraer la URL de audio real,
    //                       detecta si ya es Opus nativo (copy sin pérdida),
    //                       y usa ffmpeg-static para transcodificar.
    //                       URL cacheada 12min para evitar llamadas repetidas.
    // ─────────────────────────────────────────────
    async stream(track) {
        const t0         = Date.now();
        const trackLabel = `"${track.title?.slice(0, 50) || 'sin título'}"`;

        console.log(`\n╔══════════════════════════════════════════════════════════`);
        console.log(`║ [STREAM] ▶ ${trackLabel}`);
        console.log(`╚══════════════════════════════════════════════════════════`);
        logSistema('STREAM_START');

        streamsActivos++;
        if (streamsActivos > 1) {
            console.warn(`⚠️  [STREAM] ${streamsActivos} streams activos simultáneamente`);
        }

        try {
            const cleanUrl = cleanYoutubeUrl(track.url);
            if (!cleanUrl) throw new Error('URL no válida o malformada');

            // ── BITRATE DEL CANAL ─────────────────────────────────────────
            let channelBitrate = 96;
            let channelName    = 'desconocido';
            try {
                const guildId        = track.metadata?.guildId || track.queue?.metadata?.guildId;
                const guild          = this.context.player.client.guilds.cache.get(guildId);
                const voiceChannelId = guild?.members.me?.voice.channelId;
                if (voiceChannelId) {
                    const ch = await this.context.player.client.channels.fetch(voiceChannelId, { force: true });
                    if (ch?.bitrate) { channelBitrate = ch.bitrate / 1000; channelName = ch.name || channelName; }
                }
                console.log(`[STREAM] Canal: "${channelName}" | Bitrate: ${channelBitrate}kbps`);
            } catch (e) {
                console.warn(`[STREAM] ⚠️ Error leyendo bitrate: ${e.message} → fallback 96k`);
            }

            const targetBitrate = channelBitrate <= 96  ? 96
                                : channelBitrate <= 256 ? channelBitrate
                                : 256;

            // ── SELECCIONAR MODO ──────────────────────────────────────────
            const usarPC = await verificarPCLocal();

            if (usarPC) {
                return await this._streamDesdePC(cleanUrl, targetBitrate, t0);
            } else {
                // VM fallback usa bitrate reducido para minimizar throttling de YouTube
                const bitrateReducido = Math.min(targetBitrate, 64);
                console.log(`[STREAM] 🔄 VM fallback | Bitrate reducido: ${bitrateReducido}kbps`);
                return await this._streamDesdeVM(cleanUrl, track, bitrateReducido, t0);
            }

        } catch (e) {
            streamsActivos = Math.max(0, streamsActivos - 1);
            console.error(`[STREAM] 🔴 ERROR CRÍTICO: ${e.message}`);
            logSistema('STREAM_CRITICAL_ERROR');
            throw e;
        }
    }

    // ─────────────────────────────────────────────
    // MODO 1: Stream desde PC local vía Tailscale
    // La PC corre audioServer.js que procesa yt-dlp + FFmpeg
    // y devuelve Opus listo. La VM no hace nada pesado.
    // ─────────────────────────────────────────────
    async _streamDesdePC(cleanUrl, targetBitrate, t0) {
        const pcUrl  = `${PC_STREAM_BASE}?url=${encodeURIComponent(cleanUrl)}&bitrate=${targetBitrate}`;
        const tSpawn = Date.now();
        console.log(`[STREAM:PC] 🏠 Conectando a PC Local → bitrate: ${targetBitrate}kbps`);

        let bytesEmitidos   = 0;
        let primerDatoMs    = null;
        let ultimoChunkMs   = Date.now();
        let silencioAlertado = false;

        return new Promise((resolve, reject) => {
            const agent = new http.Agent({
                keepAlive: true,
                maxSockets: 5,
            });

            const req = http.get(pcUrl, { timeout: 10_000 }, (res) => {
                if (res.statusCode !== 200) {
                    console.error(`[STREAM:PC] 🔴 HTTP ${res.statusCode} → fallback VM`);
                    pcLocalDisponible    = false;
                    ultimaVerificacionPC = 0;
                    req.destroy();
                    // Fallback automático a VM
                    this._streamDesdeVM(cleanUrl, null, Math.min(targetBitrate, 64), t0)
                        .then(resolve).catch(reject);
                    return;
                }

                console.log(`[STREAM:PC] ✅ Conexión establecida`);

                // 🔥 NUEVO: evitar que Node pause el stream
                    res.socket?.setNoDelay(true);
                    res.resume();

                    // 🔥 NUEVO: mantener flujo activo SIEMPRE
                    res.on('data', () => {});

                const watchdogInterval = setInterval(() => {
                    const silencioMs = Date.now() - ultimoChunkMs;
                    if (silencioMs > 5000 && !silencioAlertado) {
                        silencioAlertado = true;
                        console.warn(`⚠️  [WATCHDOG:PC] Sin datos por ${(silencioMs / 1000).toFixed(1)}s`);
                    } else if (silencioMs <= 5000 && silencioAlertado) {
                        silencioAlertado = false;
                        console.log(`[WATCHDOG:PC] ✅ Audio reanudado`);
                    }
                }, 1000);

                res.on('data', (chunk) => {
                    bytesEmitidos += chunk.length;
                    ultimoChunkMs  = Date.now();
                    if (!primerDatoMs) {
                        primerDatoMs = Date.now();
                        console.log(`[STREAM:PC] ⚡ Primer chunk en ${primerDatoMs - tSpawn}ms`);
                        streamsActivos = Math.max(0, streamsActivos - 1);
                    }
                    if (bytesEmitidos % (1024 * 1024) < chunk.length) {
                        console.log(`[STREAM:PC] 📊 ${(bytesEmitidos / 1024 / 1024).toFixed(1)} MB`);
                    }
                });

                res.on('end', () => {
                    clearInterval(watchdogInterval);
                    console.log(`[STREAM:PC] ✅ Completo | ${(bytesEmitidos / 1024).toFixed(1)} KB | ${((Date.now() - tSpawn) / 1000).toFixed(1)}s`);
                    logSistema('STREAM_END');
                });

                res.on('error', (err) => {
                    clearInterval(watchdogInterval);
                    console.error(`[STREAM:PC] 🔴 Error en stream: ${err.message}`);
                    pcLocalDisponible    = false;
                    ultimaVerificacionPC = 0;
                });

                // Si no llega el primer chunk en 15s → fallback VM
                const primerChunkTimeout = setTimeout(() => {
                    if (!primerDatoMs) {
                        console.warn(`[STREAM:PC] ⚠️ Timeout 15s sin primer chunk → VM fallback`);
                        req.destroy();
                        clearInterval(watchdogInterval);
                        pcLocalDisponible    = false;
                        ultimaVerificacionPC = 0;
                        this._streamDesdeVM(cleanUrl, null, Math.min(targetBitrate, 64), t0)
                            .then(resolve).catch(reject);
                    }
                }, 15_000);

                res.once('data', () => clearTimeout(primerChunkTimeout));

                console.log(`[STREAM:PC] ✅ Pipeline listo. Preparación: ${Date.now() - t0}ms`);
                resolve({
                    stream:        res,
                    type:          StreamType.Opus,
                    highWaterMark: 1 << 20, // 1MB
                });
            });

            req.on('error', (err) => {
                console.error(`[STREAM:PC] 🔴 Error de conexión: ${err.message} → VM fallback`);
                pcLocalDisponible    = false;
                ultimaVerificacionPC = 0;
                this._streamDesdeVM(cleanUrl, null, Math.min(targetBitrate, 64), t0)
                    .then(resolve).catch(reject);
            });

            req.on('timeout', () => {
                req.destroy();
                console.warn(`[STREAM:PC] ⚠️ Timeout de conexión → VM fallback`);
                pcLocalDisponible    = false;
                ultimaVerificacionPC = 0;
                this._streamDesdeVM(cleanUrl, null, Math.min(targetBitrate, 64), t0)
                    .then(resolve).catch(reject);
            });
        });
    }

    // ─────────────────────────────────────────────
    // MODO 2: VM fallback — inteligente con URL cache + opus copy
    //
    // Lógica:
    //   1. Extrae la URL real de audio con yt-dlp (o usa caché de 12min).
    //   2. Detecta si el audio ya es Opus/WebM nativo → usa -c:a copy
    //      (sin reencoding, cero pérdida de calidad, mínimo CPU).
    //   3. Si no es Opus nativo → encode a targetBitrate con dynaudnorm.
    //   4. Usa ffmpeg-static (empaquetado en el repo) para no depender
    //      de instalaciones externas en la VM.
    // ─────────────────────────────────────────────
    async _streamDesdeVM(cleanUrl, track, targetBitrate, t0) {
        console.log(`[STREAM:VM] 🖥  Pipeline local | bitrate: ${targetBitrate}kbps`);

        try {
            // ── 1. OBTENER URL DE AUDIO (con caché) ──────────────────────
            let audioUrl, isOpusCopy;
            const cached = audioUrlCache.get(cleanUrl);

            if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
                console.log('[CACHE] ✅ Usando URL cacheada');
                ({ audioUrl, isOpusCopy } = cached);
            } else {
                console.log('[STREAM:VM] 🔍 Extrayendo URL de audio con yt-dlp...');
                const tExtract = Date.now();

                const info = await youtubedl(cleanUrl, {
                    dumpSingleJson:      true,
                    noWarnings:          true,
                    noCheckCertificates: true,
                    preferFreeFormats:   true,
                }, { windowsHide: true });

                console.log(`[STREAM:VM] yt-dlp info en ${Date.now() - tExtract}ms`);

                const formats = (info.formats || []).filter(f => f.acodec !== 'none' && f.url);
                if (!formats.length) throw new Error('No se encontró ningún formato de audio');

                // Prioridad: opus/webm nativo (copy sin pérdida) > mayor bitrate disponible
                const opusWebm = formats
                    .filter(f => f.acodec?.includes('opus') && f.ext === 'webm')
                    .sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

                const bestAudio = opusWebm || formats.sort((a, b) => (b.abr || 0) - (a.abr || 0))[0];

                audioUrl   = bestAudio.url;
                isOpusCopy = !!opusWebm;

                audioUrlCache.set(cleanUrl, { audioUrl, isOpusCopy, timestamp: Date.now() });
                console.log(`[STREAM:VM] URL extraída | Opus nativo: ${isOpusCopy ? '✅ copy' : '❌ encode'}`);
            }

            // ── 2. CONSTRUIR ARGUMENTOS DE FFMPEG ────────────────────────
            const esLive = track?.live || false;

            const args = [
                '-reconnect',           '1',
                '-reconnect_streamed',  '1',
                '-reconnect_delay_max', '10',
                ...(esLive ? ['-reconnect_at_eof', '1'] : []),
                '-probesize',           '4M',
                '-analyzeduration',     '4M',
                '-loglevel',            'error',
                '-i',                   audioUrl,
                '-vn',
            ];

            if (isOpusCopy) {
                // Audio opus nativo: copia directa, cero reencoding, mínimo CPU
                args.push('-c:a', 'copy', '-f', 'opus');
                console.log(`[STREAM:VM] ✅ COPY opus nativo | Canal: ${targetBitrate}kbps`);
            } else {
                // Reencoding con normalización de volumen en tiempo real
                // dynaudnorm: f=150ms ventana, g=15 frames suavizado, p=0.95 pico
                args.push(
                    '-af',  'dynaudnorm=f=150:g=15:p=0.95',
                    '-c:a', 'libopus',
                    '-ar',  '48000',
                    '-ac',  '2',
                    '-b:a', `${targetBitrate}k`,
                    '-f',   'opus'
                );
                console.log(`[STREAM:VM] 🔄 ENCODE ${targetBitrate}kbps | Live: ${esLive}`);
            }

            args.push('pipe:1');

            // ── 3. SPAWN FFMPEG (ffmpeg-static, no depende del sistema) ───
            const tSpawn        = Date.now();
            const ffmpegProcess = spawn(ffmpegPath, args, {
                stdio:       ['ignore', 'pipe', 'pipe'],
                windowsHide: true,
            });

            console.log(`[STREAM:VM] 🚀 FFmpeg PID: ${ffmpegProcess.pid}`);

            ffmpegProcess.stderr.on('data', (data) => {
                const msg = data.toString();
                const esErrorNormal = msg.includes('I/O error') || msg.includes('End of file');
                if (msg.includes('10054') && !esLive) {
                    console.debug('[FFmpeg:VM] Fin de stream (normal en audio pregrabado)');
                } else if (msg.includes('10054') && esLive) {
                    console.error('[FFmpeg:VM] Reset de conexión en live. Re-sincronizando...');
                } else if (msg.includes('error') && !esErrorNormal) {
                    console.error('[FFmpeg:VM]', msg.trim());
                }
            });

            ffmpegProcess.on('close', (code) => {
                streamsActivos = Math.max(0, streamsActivos - 1);
                if (code !== 0 && code !== null) {
                    if (isOpusCopy) {
                        // Copy falló → próxima vez forzar encode
                        const entry = audioUrlCache.get(cleanUrl);
                        if (entry) {
                            audioUrlCache.set(cleanUrl, { ...entry, isOpusCopy: false });
                            console.warn('[STREAM:VM] ⚠️ Copy falló → cache actualizado a encode');
                        }
                    }
                    console.warn(`[FFmpeg:VM] Proceso terminó con código ${code}`);
                }
                console.log(`[STREAM:VM] ⏹ Cerrado | ${((Date.now() - tSpawn) / 1000).toFixed(1)}s`);
                logSistema('STREAM_END');
            });

            ffmpegProcess.on('error', (err) => {
                streamsActivos = Math.max(0, streamsActivos - 1);
                console.error(`[STREAM:VM] 🔴 FFmpeg error: ${err.message}`);
            });

            // Timeout: si FFmpeg no arranca en 20s, lo matamos
            const timeout = setTimeout(() => {
                if (!ffmpegProcess.killed) {
                    console.warn('[STREAM:VM] ⚠️ Timeout 20s — terminando FFmpeg');
                    ffmpegProcess.kill('SIGKILL');
                }
            }, 20_000);

            ffmpegProcess.stdout.once('data', () => {
                clearTimeout(timeout);
                console.log(`[STREAM:VM] ✅ Pipeline activo. Preparación: ${Date.now() - t0}ms`);
            });

            return {
                stream:        ffmpegProcess.stdout,
                type:          StreamType.Opus,
                highWaterMark: 1 << 23, // 8MB — reduce micro-cortes en VM
            };

        } catch (e) {
            streamsActivos = Math.max(0, streamsActivos - 1);
            console.error(`[STREAM:VM] 🔴 ERROR: ${e.message}`);
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

    const limpiarInterfaz = async (queue) => {
        if (queue.metadata?.ultimoMensaje) {
            await queue.metadata.ultimoMensaje.edit({ components: [] }).catch(() => null);
            queue.metadata.ultimoMensaje = null;
        }
    };

    player.events.on('playerStart', async (queue, track) => {
        if (track.url.includes('translate_tts')) return;
        console.log(`\n[Event:playerStart] 🎵 "${track.title?.slice(0, 60)}" | ${track.duration}`);
        logSistema('PLAYER_START_EVENT');

        if (queue.metadata?.ultimoMensaje) {
            try {
                const msgAnterior        = queue.metadata.ultimoMensaje;
                const filasDeshabilitadas = msgAnterior.components.map(fila =>
                    ActionRowBuilder.from(fila).setComponents(
                        fila.components.map(btn => ButtonBuilder.from(btn).setDisabled(true))
                    )
                );
                await msgAnterior.edit({ components: filasDeshabilitadas }).catch(() => null);
            } catch {}
            queue.metadata.ultimoMensaje = null;
        }

        const modoLabel = pcLocalDisponible ? '🏠 PC Local (Hi-Fi)' : '🖥  VM Fallback';

        const embed = new EmbedBuilder()
            .setTitle('🎵 Reproduciendo Ahora')
            .setDescription(`**[${track.title}](${track.url})**\nAutor: ${track.author}`)
            .setFooter({ text: `Motor: ${modoLabel}` })
            .setColor(pcLocalDisponible ? '#00C853' : '#FF9900');

        if (track.thumbnail?.startsWith('http')) embed.setThumbnail(track.thumbnail);

        const fila1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('musica_pausa').setEmoji('⏯️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('musica_salto').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('musica_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('musica_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('musica_queue').setEmoji('📜').setStyle(ButtonStyle.Secondary)
        );

        const fila2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('musica_lyrics').setLabel('Ver Letras').setEmoji('🎤').setStyle(ButtonStyle.Secondary)
        );

        if (queue.metadata?.canal) {
            const mensaje = await queue.metadata.canal.send({
                embeds: [embed], components: [fila1, fila2]
            }).catch((e) => {
                console.warn(`[playerStart] No se pudo enviar embed: ${e.message}`);
                return null;
            });
            queue.metadata.ultimoMensaje = mensaje;
            console.log(`[playerStart] ✅ Embed enviado (${modoLabel})`);
        }
    });

    player.events.on('emptyQueue', (queue) => {
        console.log('[Event:emptyQueue] Cola vacía.');
        limpiarInterfaz(queue);
        logSistema('QUEUE_EMPTY');
    });

    player.events.on('disconnect', (queue) => {
        console.log('[Event:disconnect] Desconectado del canal de voz.');
        limpiarInterfaz(queue);
        logSistema('DISCONNECT');
    });

    player.events.on('error', (queue, error) => {
        console.error(`[Event:error] ${error.message}`);
        logSistema('PLAYER_ERROR');
        if (queue?.guild) {
            log(queue.guild, {
                categoria: 'sistema', titulo: 'Error de Sistema',
                descripcion: 'Error en el sistema de reproducción.',
                error: sanitizeErrorMessage(error.message),
            }).catch(() => null);
        }
    });

    player.events.on('playerError', (queue, error) => {
        console.error(`[Event:playerError] ${error.message}`);
        logSistema('PLAYER_AUDIO_ERROR');
        if (queue?.guild) {
            log(queue.guild, {
                categoria: 'sistema', titulo: 'Error de Audio',
                descripcion: 'Error al reproducir la pista.',
                campos: queue.currentTrack ? [{ name: '🎵 Pista', value: queue.currentTrack.title, inline: true }] : [],
                error: sanitizeErrorMessage(error.message),
            }).catch(() => null);
        }
    });

    return player;
}

module.exports = { inicializarPlayer, cleanYoutubeUrl, secondsToTime, limpiarParaLyrics };