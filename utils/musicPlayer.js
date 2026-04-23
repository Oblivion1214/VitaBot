// utils/musicPlayer.js — VitaBot
// Motor de audio: arquitectura híbrida PC Local (Tailscale-Windows) + VM fallback (Linux)
const path = require('path');
const os   = require('os');
const http = require('http');
const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { Player, BaseExtractor, Track, Playlist } = require('discord-player');
const { DefaultExtractors } = require('@discord-player/extractor');
const { StreamType } = require('@discordjs/voice');
const { spawn, execSync } = require('child_process');
const youtubeExt = require('youtube-ext');
const youtubedl  = require('youtube-dl-exec');
const fs = require('fs');
const { log, sanitizeErrorMessage } = require('./logger');
const { Transform, PassThrough } = require('stream');

// ─────────────────────────────────────────────
// CONFIGURACIÓN HÍBRIDA
// ─────────────────────────────────────────────
const PC_AUDIO_HOST  = '100.127.221.32';
const PC_AUDIO_PORT  = 3000;
const PC_HEALTH_URL  = `http://${PC_AUDIO_HOST}:${PC_AUDIO_PORT}/health`;
const PC_STREAM_BASE = `http://${PC_AUDIO_HOST}:${PC_AUDIO_PORT}/stream`;

let pcLocalDisponible    = false;
let ultimaVerificacionPC = 0;

// Cuánto tiempo cachear el estado del PC:
//   - Si está ONLINE: 15s (reverificar frecuente para detectar caídas)
//   - Si está OFFLINE: 0s (siempre reverificar — el PC puede volver en cualquier momento)
const PC_CHECK_INTERVAL_ONLINE  = 15_000;
const PC_TIMEOUT_MS              = 4_000;

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
    console.log(`│ 🖥  RAM Sistema : ${(usedMem/1024/1024).toFixed(1)} MB / ${(totalMem/1024/1024).toFixed(1)} MB  (libre: ${(freeMem/1024/1024).toFixed(1)} MB)`);
    console.log(`│ 🟩 Node Heap   : ${(heap.heapUsed/1024/1024).toFixed(1)} MB / ${(heap.heapTotal/1024/1024).toFixed(1)} MB`);
    console.log(`│ 📦 Node RSS    : ${(heap.rss/1024/1024).toFixed(1)} MB`);
    console.log(`│ ⚡ CPU LoadAvg : ${loadAvg[0].toFixed(2)} (1m) | ${loadAvg[1].toFixed(2)} (5m) | ${loadAvg[2].toFixed(2)} (15m)`);
    console.log(`│ ⏱  Uptime Bot  : ${uptime} min`);
    console.log(`│ 🏠 PC Local    : ${pcLocalDisponible ? '✅ ONLINE' : '❌ OFFLINE (VM fallback)'}`);
    console.log(`└────────────────────────────────────────────────────────────────────\n`);

    if (freeMem < 150 * 1024 * 1024) console.warn(`⚠️  [PERF:${tag}] RAM CRÍTICA: ${(freeMem/1024/1024).toFixed(1)} MB libres`);
    if (loadAvg[0] > 1.5)            console.warn(`⚠️  [PERF:${tag}] CPU SATURADA: load avg ${loadAvg[0].toFixed(2)}`);
}

// ─────────────────────────────────────────────
// VERIFICADOR DE PC LOCAL
//
// FIX APLICADO:
//   - Lee json.status === 'ok' (no json.available que el servidor no devuelve)
//   - Cuando PC está OFFLINE no cachea (siempre reverifica al siguiente intento)
//   - Cuando PC está ONLINE cachea 15s para no hacer health-check en cada chunk
// ─────────────────────────────────────────────
function verificarPCLocal() {
    return new Promise((resolve) => {
        const ahora = Date.now();

        // Solo usar caché si el PC estaba ONLINE y el intervalo no expiró
        if (pcLocalDisponible && (ahora - ultimaVerificacionPC < PC_CHECK_INTERVAL_ONLINE)) {
            console.log(`[PC-Check] 📋 Estado cacheado: ONLINE (siguiente check en ${((PC_CHECK_INTERVAL_ONLINE - (ahora - ultimaVerificacionPC))/1000).toFixed(0)}s)`);
            resolve(true);
            return;
        }

        // Si estaba OFFLINE o el caché expiró → hacer el check ahora
        const razon = !pcLocalDisponible ? 'PC estaba OFFLINE' : 'caché expirado';
        console.log(`[PC-Check] 🔍 Verificando PC Local... (razón: ${razon}) → ${PC_HEALTH_URL}`);

        ultimaVerificacionPC = ahora;

        const req = http.get(PC_HEALTH_URL, { timeout: PC_TIMEOUT_MS }, (res) => {
            let data = '';
            res.on('data', (chunk) => data += chunk);
            res.on('end', () => {
                try {
                    const json = JSON.parse(data);
                    const estadoAnterior = pcLocalDisponible;

                    // FIX: checar json.status === 'ok', NO json.available
                    // El audioServer devuelve { status: 'ok', available: true, ... }
                    pcLocalDisponible = json.status === 'ok';

                    console.log(`[PC-Check] 📡 Respuesta del PC:`);
                    console.log(`[PC-Check]   status   : ${json.status}`);
                    console.log(`[PC-Check]   available: ${json.available}`);
                    console.log(`[PC-Check]   streams  : ${json.streamsActivos}`);
                    console.log(`[PC-Check]   uptime   : ${json.uptime}s`);
                    console.log(`[PC-Check]   cpu      : ${json.cpu}`);
                    console.log(`[PC-Check]   ram libre: ${json.ram?.libre} MB`);

                    if (!estadoAnterior && pcLocalDisponible) {
                        console.log(`[PC-Check] ✅ PC Local ONLINE — recuperado después de estar offline`);
                    } else if (pcLocalDisponible) {
                        console.log(`[PC-Check] ✅ PC Local ONLINE`);
                    }

                    resolve(pcLocalDisponible);
                } catch (e) {
                    console.error(`[PC-Check] 🔴 Error parseando respuesta JSON: ${e.message}`);
                    console.error(`[PC-Check]   Respuesta cruda: ${data.slice(0, 200)}`);
                    pcLocalDisponible = false;
                    ultimaVerificacionPC = 0; // forzar recheck
                    resolve(false);
                }
            });
        });

        req.on('timeout', () => {
            req.destroy();
            if (pcLocalDisponible) {
                console.warn(`[PC-Check] ⏱ TIMEOUT (${PC_TIMEOUT_MS}ms) — PC no respondió → VM fallback`);
            } else {
                console.log(`[PC-Check] ⏱ Timeout — PC sigue OFFLINE`);
            }
            pcLocalDisponible    = false;
            ultimaVerificacionPC = 0; // forzar recheck inmediato próxima vez
            resolve(false);
        });

        req.on('error', (err) => {
            if (pcLocalDisponible) {
                console.warn(`[PC-Check] 🔴 Error de conexión: ${err.message} → VM fallback`);
            } else {
                console.log(`[PC-Check] 🔴 PC sigue OFFLINE (${err.code || err.message})`);
            }
            pcLocalDisponible    = false;
            ultimaVerificacionPC = 0;
            resolve(false);
        });
    });
}

// Verificación inicial
verificarPCLocal().then((online) => {
    console.log(`[PC-Check] Estado inicial: ${online ? '✅ PC ONLINE' : '❌ PC OFFLINE — se usará VM fallback'}`);
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
// ─────────────────────────────────────────────
const audioUrlCache = new Map();
const CACHE_TTL     = 1000 * 60 * 12; // 12 minutos

setInterval(() => {
    const now = Date.now();
    let eliminadas = 0;
    for (const [key, value] of audioUrlCache.entries()) {
        if (now - value.timestamp > CACHE_TTL) { audioUrlCache.delete(key); eliminadas++; }
    }
    if (eliminadas > 0) console.log(`[CACHE] 🧹 ${eliminadas} URL(s) expiradas. Restantes: ${audioUrlCache.size}`);
    logSistema('CACHE_GC');
}, 1000 * 60 * 5).unref();

// ─────────────────────────────────────────────
// BINARIO DE YT-DLP (VM fallback)
// ─────────────────────────────────────────────
function getYtdlpBin() {
    try {
        const binPath = require('youtube-dl-exec').raw;
        if (binPath && fs.existsSync(binPath)) return binPath;
    } catch {}
    try {
        const which = os.platform() === 'win32' ? 'where yt-dlp' : 'which yt-dlp';
        return execSync(which, { stdio: 'pipe' }).toString().trim().split('\n')[0];
    } catch {}
    return os.platform() === 'win32' ? 'yt-dlp.exe' : 'yt-dlp';
}

const YTDLP_BIN = getYtdlpBin();

(async () => {
    try {
        const { execFileSync } = require('child_process');
        const v = execFileSync(YTDLP_BIN, ['--version'], { stdio: 'pipe' }).toString().trim();
        console.log(`[yt-dlp] ✅ Versión: ${v} | bin: ${YTDLP_BIN}`);
    } catch {
        console.error(`[yt-dlp] 🔴 Binario no encontrado: ${YTDLP_BIN}`);
    }
})();

// ─────────────────────────────────────────────
// STREAMS ACTIVOS (VM)
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
        if (!videoId && u.hostname === 'youtu.be') videoId = u.pathname.slice(1).split(/[?#]/)[0];
        if (!videoId) {
            const match = u.pathname.match(/\/(?:live|shorts)\/([a-zA-Z0-9_-]{11})/);
            if (match) videoId = match[1];
        }
        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    } catch { return null; }
}

function secondsToTime(secs) {
    const s = parseInt(secs || '0');
    return `${Math.floor(s/60)}:${(s%60).toString().padStart(2,'0')}`;
}

function limpiarParaLyrics(texto, autor) {
    if (!texto) return '';
    let limpio = texto
        .replace(/\(Letra Oficial\)/gi,'').replace(/\(Letra\)/gi,'')
        .replace(/\(Letra Lyrics\)/gi,'').replace(/\(Video Oficial\)/gi,'')
        .replace(/\(Video\)/gi,'').replace(/\(Official Video\)/gi,'')
        .replace(/\(Lyrics\)/gi,'').replace(/\(Audio Oficial\)/gi,'')
        .replace(/\(Lyrics Video\)/gi,'').replace(/\(Cover Audio\)/gi,'')
        .replace(/\(Official Live Video\)/gi,'').replace(/\(Live Video\)/gi,'')
        .replace(/\(Official Live\)/gi,'').replace(/\[.*?\]/g,'')
        .replace(/"/g,'').replace(/\s+/g,' ').trim();
    if (limpio.includes('-')) {
        const partes = limpio.split('-');
        if (autor && partes[0].toLowerCase().includes(autor.toLowerCase())) limpio = partes[1].trim();
        else limpio = partes[partes.length - 1].trim();
    }
    return limpio;
}

// ─────────────────────────────────────────────
// HELPER: Construir Track
// ─────────────────────────────────────────────
function buildTrack(player, data, context, extractor) {
    const track = new Track(player, {
        title: data.title, url: data.url,
        duration: data.duration || '0:00', thumbnail: data.thumbnail || '',
        author: data.author || 'Desconocido', requestedBy: context.requestedBy,
        source: data.source || 'youtube', queryType: data.queryType || context.type,
        description: data.description || '', views: data.views || 0, live: data.live || false,
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
        if (query.startsWith('http') && !query.includes('youtube.com') && !query.includes('youtu.be') && !query.includes('spotify.com')) {
            console.log(`[Validate] ❌ URL rechazada: ${query.slice(0,60)}`);
            return false;
        }
        console.log(`[Validate] ✅ Query: "${query.slice(0,80)}"`);
        return true;
    }

    async handle(query, context) {
        const t0 = Date.now();
        console.log(`\n[Handle] ▶ Resolviendo: "${query.slice(0,80)}"`);
        logSistema('HANDLE_START');

        try {
            // ── 1. SPOTIFY ────────────────────────────────────────────────
            if (query.includes('spotify.com/track/')) {
                const trackId = query.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                if (!trackId) return { playlist: null, tracks: [] };
                const t1 = Date.now();
                const oembedRes = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${trackId}`);
                if (!oembedRes.ok) throw new Error('Spotify oEmbed falló');
                const oembed = await oembedRes.json();
                console.log(`[Spotify] oEmbed en ${Date.now()-t1}ms → "${oembed.title}"`);
                const results = await youtubeExt.search(oembed.title, { type: 'video', limit: 1 });
                if (!results?.videos?.length) return { playlist: null, tracks: [] };
                const video = results.videos[0];
                const videoUrl = cleanYoutubeUrl(video.url);
                if (!videoUrl) return { playlist: null, tracks: [] };
                const track = buildTrack(this.context.player, {
                    title: oembed.title || video.title, url: videoUrl,
                    duration: video.duration?.text || '0:00',
                    thumbnail: oembed.thumbnail_url || video.thumbnails?.[0]?.url || '',
                    author: video.channel?.name || 'Desconocido', source: 'spotify',
                }, context, this);
                console.log(`[Spotify] ✅ "${track.title}" en ${Date.now()-t0}ms`);
                return { playlist: null, tracks: [track] };
            }

            // ── 2. PLAYLIST ───────────────────────────────────────────────
            if (query.includes('list=')) {
                console.log('[Handle] 🔍 Playlist detectada...');
                let playlistData = null;
                try {
                    const t1 = Date.now();
                    const output = await youtubedl(query, { dumpSingleJson: true, flatPlaylist: true, noCheckCertificates: true, quiet: true, noWarnings: true }, { maxBuffer: 1024*1024*100 });
                    const json = (typeof output === 'string') ? JSON.parse(output) : output;
                    console.log(`[Handle] yt-dlp playlist en ${Date.now()-t1}ms`);
                    if (json?.entries?.length || json?.videos?.length) {
                        const entries = json.entries || json.videos;
                        playlistData = {
                            title: json.title || 'Playlist de YouTube', author: json.uploader || 'YouTube',
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
                } catch (e) { console.warn(`[Handle] yt-dlp playlist falló: ${e.message}`); }

                if (!playlistData) {
                    const t1 = Date.now();
                    playlistData = await youtubeExt.playlistInfo(query, { requestOptions: { headers: { cookie: youtubeCookie } } }).catch(e => { console.warn(`[Handle] youtube-ext playlist falló: ${e.message}`); return null; });
                    if (playlistData) console.log(`[Handle] youtube-ext playlist en ${Date.now()-t1}ms`);
                }

                if (playlistData?.videos?.length > 0) {
                    const MAX_TRACKS = 200;
                    if (playlistData.videos.length > MAX_TRACKS) playlistData.videos = playlistData.videos.slice(0, MAX_TRACKS);
                    const tracks = playlistData.videos.filter(v => v?.title && v?.url).map((video, i) => {
                        const track = buildTrack(this.context.player, {
                            title: video.title, url: video.url,
                            duration: typeof video.duration === 'string' ? video.duration : '0:00',
                            thumbnail: video.thumbnail || video.thumbnails?.[0]?.url || '',
                            author: video.author || 'YouTube Playlist', source: 'youtube', queryType: 'youtubePlaylist',
                        }, context, this);
                        if (i % 10 === 0) console.log(`[Handle] Pista ${i}: "${track.title}"`);
                        return track;
                    });
                    const playlist = new Playlist(this.context.player, {
                        title: playlistData.title || 'Playlist', url: query,
                        thumbnail: playlistData.thumbnail || '',
                        author: { name: playlistData.author || 'YouTube', url: '' },
                        tracks, source: 'youtube', type: 'playlist'
                    });
                    console.log(`[Handle] ✅ Playlist "${playlist.title}" | ${tracks.length} tracks | ${Date.now()-t0}ms`);
                    return { playlist, tracks };
                }
                return { playlist: null, tracks: [] };
            }

            // ── 3. LINK DIRECTO ───────────────────────────────────────────
            if (query.includes('youtube.com') || query.includes('youtu.be')) {
                const videoUrl = cleanYoutubeUrl(query);
                if (!videoUrl) return { playlist: null, tracks: [] };
                console.log(`[Handle] 🔗 Link directo: ${videoUrl}`);
                const t1 = Date.now();
                const info = await youtubeExt.videoInfo(videoUrl, { requestOptions: { headers: { cookie: youtubeCookie } } });
                console.log(`[Handle] videoInfo en ${Date.now()-t1}ms → "${info?.title || 'N/A'}"`);
                if (!info?.title) return { playlist: null, tracks: [] };
                const track = buildTrack(this.context.player, {
                    title: info.title, url: videoUrl,
                    duration: secondsToTime(info.duration?.lengthSec),
                    thumbnail: info.thumbnails?.[0]?.url || '',
                    author: info.channel?.name || 'Desconocido', source: 'youtube',
                    description: info.shortDescription || '', views: info.views?.pretty || 0, live: info.isLive || false,
                }, context, this);
                console.log(`[Handle] ✅ "${track.title}" en ${Date.now()-t0}ms | Live: ${track.live}`);
                return { playlist: null, tracks: [track] };
            }

            // ── 4. BÚSQUEDA ───────────────────────────────────────────────
            const searchQuery = query.includes('music') ? query : `${query} music topic`;
            const t1 = Date.now();
            const results = await youtubeExt.search(searchQuery, { type: 'video', limit: 10 });
            console.log(`[Handle] 🔍 Búsqueda "${searchQuery}" en ${Date.now()-t1}ms → ${results?.videos?.length || 0} resultados`);
            if (!results?.videos?.length) return { playlist: null, tracks: [] };
            const tracks = results.videos.filter(v => v?.url).map(video => buildTrack(this.context.player, {
                title: video.title, url: cleanYoutubeUrl(video.url),
                duration: video.duration?.text || '0:00', thumbnail: video.thumbnails?.[0]?.url || '',
                author: video.channel?.name || 'YouTube Music', source: 'youtube',
            }, context, this));
            console.log(`[Handle] ✅ ${tracks.length} tracks en ${Date.now()-t0}ms`);
            return { playlist: null, tracks };

        } catch (e) {
            console.error(`[Handle] ERROR: ${e.message}`);
            return { playlist: null, tracks: [] };
        }
    }

    // ─────────────────────────────────────────────
    // STREAM — Despacha a PC local o VM fallback
    // ─────────────────────────────────────────────
    async stream(track) {
        const t0         = Date.now();
        const trackLabel = `"${track.title?.slice(0,50) || 'sin título'}"`;

        console.log(`\n${'═'.repeat(60)}`);
        console.log(`[STREAM] ▶ ${trackLabel}`);
        console.log(`[STREAM] URL: ${track.url}`);
        console.log(`${'═'.repeat(60)}`);
        logSistema('STREAM_START');

        streamsActivos++;
        if (streamsActivos > 1) console.warn(`⚠️  [STREAM] ${streamsActivos} streams activos simultáneamente`);

        try {
            const cleanUrl = cleanYoutubeUrl(track.url);
            if (!cleanUrl) throw new Error('URL no válida');

            // Bitrate del canal de voz
            let channelBitrate = 96;
            let channelName    = 'desconocido';
            try {
                const guildId = track.metadata?.guildId || track.queue?.metadata?.guildId;
                const guild   = this.context.player.client.guilds.cache.get(guildId);
                const vcId    = guild?.members.me?.voice.channelId;
                if (vcId) {
                    const ch = await this.context.player.client.channels.fetch(vcId, { force: true });
                    if (ch?.bitrate) { channelBitrate = ch.bitrate / 1000; channelName = ch.name || channelName; }
                }
                console.log(`[STREAM] Canal de voz: "${channelName}" | Bitrate del canal: ${channelBitrate}kbps`);
            } catch (e) {
                console.warn(`[STREAM] ⚠️ No se pudo leer bitrate del canal: ${e.message} → fallback 96k`);
            }

            const targetBitrate = channelBitrate <= 96 ? 96 : channelBitrate <= 256 ? channelBitrate : 256;
            console.log(`[STREAM] Target bitrate calculado: ${targetBitrate}kbps`);

            // Verificar PC
            console.log(`[STREAM] Verificando PC local...`);
            const usarPC = await verificarPCLocal();

            if (usarPC) {
                console.log(`[STREAM] 🏠 → PC Local seleccionado | bitrate: ${targetBitrate}kbps`);
                return await this._streamDesdePC(cleanUrl, targetBitrate, t0);
            } else {
                const bitrateReducido = Math.min(targetBitrate, 64);
                console.log(`[STREAM] 🖥  → VM Fallback seleccionado | bitrate reducido: ${bitrateReducido}kbps (original: ${targetBitrate}kbps)`);
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
    // MODO 1: PC Local vía Tailscale
    // ─────────────────────────────────────────────
    async _streamDesdePC(cleanUrl, targetBitrate, t0) {
        const pcUrl = `${PC_STREAM_BASE}?url=${encodeURIComponent(cleanUrl)}&bitrate=${targetBitrate}`;
        console.log(`[STREAM:PC] 🏠 Conectando → ${PC_AUDIO_HOST}:${PC_AUDIO_PORT}`);
        console.log(`[STREAM:PC]   bitrate: ${targetBitrate}kbps`);

        const tSpawn = Date.now();
        let bytesEmitidos = 0;
        let primerDatoMs  = null;
        let ultimoChunkMs = Date.now();
        let silencioAlert = false;

        return new Promise((resolve, reject) => {
            const req = http.get(pcUrl, (res) => {
                console.log(`[STREAM:PC] Respuesta HTTP: ${res.statusCode}`);

                if (res.statusCode !== 200) {
                    console.error(`[STREAM:PC] 🔴 HTTP ${res.statusCode} → marcando PC offline, usando VM fallback`);
                    pcLocalDisponible    = false;
                    ultimaVerificacionPC = 0;
                    req.destroy();
                    this._streamDesdeVM(cleanUrl, null, Math.min(64, targetBitrate), t0).then(resolve).catch(reject);
                    return;
                }

                console.log(`[STREAM:PC] ✅ Conexión HTTP establecida con PC Local`);
                req.setTimeout(0); // Inmortalidad de conexión

                const watchdog = setInterval(() => {
                    const silencio = Date.now() - ultimoChunkMs;
                    if (silencio > 5000 && !silencioAlert) {
                        silencioAlert = true;
                        console.warn(`[STREAM:PC] ⚠️ Sin datos por ${(silencio/1000).toFixed(1)}s | bytes: ${(bytesEmitidos/1024).toFixed(1)} KB`);
                    } else if (silencio < 5000 && silencioAlert) {
                        silencioAlert = false;
                        console.log(`[STREAM:PC] ✅ Audio reanudado`);
                    }
                }, 1000);

                // 🌟 EL ESPÍA ASPIRADORA: Búfer de 20MB + Métricas integradas
                const espiaLigeroVM = new Transform({
                    //highWaterMark: 1024 * 1024 * 20, // 20 MB de almacenamiento RAM
                    transform(chunk, encoding, callback) {
                        bytesEmitidos += chunk.length;
                        ultimoChunkMs  = Date.now();

                        if (!primerDatoMs) {
                            primerDatoMs = Date.now();
                            console.log(`[STREAM:PC] ⚡ Primer chunk en ${primerDatoMs - tSpawn}ms | ${chunk.length} bytes`);
                        }

                        if (bytesEmitidos % (1024 * 1024) < chunk.length) {
                            const elapsedS = (Date.now() - primerDatoMs) / 1000;
                            const tasaKbps = elapsedS > 0 ? ((bytesEmitidos*8)/elapsedS/1000).toFixed(1) : '?';
                            console.log(`[STREAM:PC] 📊 ${(bytesEmitidos/1024/1024).toFixed(1)} MB | ~${tasaKbps} kbps`);
                        }

                        // Le entregamos el chunk INTACTO a Discord.js
                        callback(null, chunk);
                    }
                });

                // Conectamos la descarga de red al Espía-Aspiradora
                res.pipe(aspiradoraEspiaVM);

                // IMPORTANTE: ¡Desapareció el aspiradora.on('data')! Ya no hay agujero negro.

                res.on('end', () => {
                    clearInterval(watchdog);
                    const dur = ((Date.now() - tSpawn) / 1000).toFixed(1);
                    console.log(`[STREAM:PC] ✅ Descarga a RAM completa | ${(bytesEmitidos/1024).toFixed(1)} KB | ${dur}s`);
                    logSistema('STREAM_END');
                });

                res.on('error', (err) => {
                    clearInterval(watchdog);
                    console.error(`[STREAM:PC] 🔴 Error HTTP: ${err.message}`);
                    pcLocalDisponible = false;
                    ultimaVerificacionPC = 0;
                });

                const primerChunkTimeout = setTimeout(() => {
                    if (!primerDatoMs) {
                        console.warn(`[STREAM:PC] ⚠️ Timeout 15s sin primer chunk → VM fallback`);
                        req.destroy();
                        clearInterval(watchdog);
                        pcLocalDisponible = false;
                        ultimaVerificacionPC = 0;
                        this._streamDesdeVM(cleanUrl, null, Math.min(64, targetBitrate), t0).then(resolve).catch(reject);
                    }
                }, 15_000);

                res.once('data', () => clearTimeout(primerChunkTimeout));

                console.log(`[STREAM:PC] ✅ Pipeline configurado. Preparación: ${Date.now() - t0}ms`);

                resolve({
                    stream:        espiaLigeroVM, // Se lo pasamos directamente a Discord
                    type:          StreamType.OggOpus,
                    highWaterMark: 1 << 18 // ⬅️ DEVOLVEMOS EL BÚFER SANO (256KB) A DISCORD
                });
            });

            req.on('socket', (socket) => {
                socket.setKeepAlive(true, 10000); 
                socket.setTimeout(0); 
            });

            req.on('error', (err) => {
                console.error(`[STREAM:PC] 🔴 Error TCP: ${err.code} — ${err.message} → VM fallback`);
                pcLocalDisponible = false;
                ultimaVerificacionPC = 0;
                this._streamDesdeVM(cleanUrl, null, Math.min(64, targetBitrate), t0).then(resolve).catch(reject);
            });

            req.on('timeout', () => {
                req.destroy();
                console.warn(`[STREAM:PC] ⚠️ Timeout TCP → VM fallback`);
                pcLocalDisponible = false;
                ultimaVerificacionPC = 0;
                this._streamDesdeVM(cleanUrl, null, Math.min(64, targetBitrate), t0).then(resolve).catch(reject);
            });
        });
    }

    // ─────────────────────────────────────────────
    // MODO 2: VM Fallback (yt-dlp local → FFmpeg con rate control)
    //
    // FIX APLICADO:
    //   - Eliminado COPY mode completamente (causaba burst de datos al instante)
    //   - Siempre usa encode libopus + -maxrate/-bufsize para regular a targetBitrate
    //   - highWaterMark reducido a 256KB (no 8MB)
    //   - Timeout limpiado correctamente en close
    // ─────────────────────────────────────────────
    async _streamDesdeVM(cleanUrl, track, targetBitrate, t0) {
        console.log(`[STREAM:VM] 🖥  Pipeline VM local`);
        console.log(`[STREAM:VM]   bitrate   : ${targetBitrate}kbps`);
        console.log(`[STREAM:VM]   URL       : ${cleanUrl}`);
        console.log(`[STREAM:VM]   YTDLP_BIN : ${YTDLP_BIN}`);

        const esLive = track?.live || false;

        try {
            // ── Extraer URL del audio con yt-dlp (--get-url) ─────────────
            // Usamos --get-url en lugar de dumpSingleJson para mayor velocidad.
            // Solo necesitamos la URL del stream, no todos los metadatos.
            let audioUrl;
            const cached = audioUrlCache.get(cleanUrl);

            if (cached && Date.now() - cached.timestamp < CACHE_TTL) {
                audioUrl = cached.audioUrl;
                console.log(`[STREAM:VM] 📋 Usando URL cacheada (edad: ${((Date.now()-cached.timestamp)/1000/60).toFixed(1)}min)`);
            } else {
                console.log(`[STREAM:VM] 🔍 Extrayendo URL con yt-dlp --get-url...`);
                const tExtract = Date.now();

                audioUrl = await new Promise((resolve, reject) => {
                    const cookieNetscape = path.join(__dirname, '../config/youtube-cookie.txt');
                    const args = [
                        '--no-warnings', '--no-check-certificates', '--no-check-formats',
                        '--format', 'bestaudio[ext=webm]/bestaudio[ext=m4a]/bestaudio/best',
                        '--get-url',
                        cleanUrl,
                    ];
                    if (fs.existsSync(cookieNetscape) && fs.statSync(cookieNetscape).size > 50) {
                        args.unshift('--cookies', cookieNetscape);
                        console.log(`[STREAM:VM]   🍪 Cookie cargada`);
                    }

                    console.log(`[STREAM:VM]   yt-dlp args: ${args.filter((a,i)=>args[i-1]!=='--cookies').join(' ')}`);

                    const proc = spawn(YTDLP_BIN, args, { stdio: ['ignore', 'pipe', 'pipe'] });
                    let out = '', err = '';
                    proc.stdout.on('data', d => { out += d.toString(); });
                    proc.stderr.on('data', d => {
                        const msg = d.toString().trim();
                        if (msg) {
                            err += msg + '\n';
                            if (msg.toLowerCase().includes('error')) console.error(`[yt-dlp:VM] 🔴 ${msg}`);
                            else console.log(`[yt-dlp:VM] ${msg}`);
                        }
                    });
                    proc.on('close', (code) => {
                        const url = out.trim().split('\n')[0].trim();
                        console.log(`[STREAM:VM]   yt-dlp completó en ${Date.now()-tExtract}ms | código: ${code} | URL obtenida: ${url ? 'SÍ' : 'NO'}`);
                        if (code !== 0 || !url) {
                            console.error(`[STREAM:VM]   stderr: ${err.slice(0,400)}`);
                            reject(new Error(`yt-dlp falló (código ${code})`));
                        } else {
                            // Detectar formato
                            const esWebm = url.includes('webm') || url.includes('mime=audio%2Fwebm');
                            const esM4a  = url.includes('mp4')  || url.includes('mime=audio%2Fmp4');
                            console.log(`[STREAM:VM]   Formato detectado: ${esWebm ? 'webm/opus' : esM4a ? 'm4a/aac' : 'desconocido'}`);
                            resolve(url);
                        }
                    });
                    proc.on('error', reject);
                });

                audioUrlCache.set(cleanUrl, { audioUrl, timestamp: Date.now() });
                console.log(`[STREAM:VM]   URL guardada en caché`);
            }

            // ── Construir args de FFmpeg con rate control ─────────────────
            //
            // NUNCA usar -c:a copy aunque el audio sea opus nativo.
            // Con copy, FFmpeg pasa los bytes crudos sin ningún control de velocidad
            // y la VM recibe todo en ~1-2s (burst). Con encode + -maxrate/-bufsize
            // la salida se regula a targetBitrate sostenido durante toda la canción.
            const maxrate = targetBitrate + 4;
            const bufsize  = maxrate * 2;

            const ffmpegArgs = [
                //'-re',                        // <--- AÑADIR ESTA LÍNEA en ambos modos (PC y VM) para simular velocidad de reproducción real y evitar bursts
                '-reconnect',             '1',
                '-reconnect_streamed',    '1',
                '-reconnect_delay_max',   '10',
                ...(esLive ? ['-reconnect_at_eof', '1'] : []),
                '-probesize',             '512K',
                '-analyzeduration',       '512K',
                '-loglevel',              'warning',
                '-i',                     audioUrl,
                '-vn',
                '-fflags',                '+discardcorrupt',
                '-max_muxing_queue_size', '512',
                '-af',                    'dynaudnorm=f=150:g=15:p=0.95',
                '-c:a',                   'libopus',
                '-ar',                    '48000',
                '-ac',                    '2',
                '-b:a',                   `${targetBitrate}k`,
                // CONTROL DE VELOCIDAD — igual que en audioServer
                //'-maxrate',               `${maxrate}k`,
                //'-bufsize',               `${bufsize}k`,
                '-f',                     'opus',
                'pipe:1',
            ];

            console.log(`[STREAM:VM] 🎯 Modo: ENCODE ${targetBitrate}kbps | maxrate:${maxrate}k bufsize:${bufsize}k | Live: ${esLive}`);
            console.log(`[STREAM:VM] FFmpeg args: ffmpeg ${ffmpegArgs.join(' ').replace(audioUrl,'[URL]').slice(0,200)}`);

            const tSpawn       = Date.now();
            const ffmpegProcess = spawn('ffmpeg', ffmpegArgs, { stdio: ['ignore', 'pipe', 'pipe'] });

            console.log(`[STREAM:VM] 🚀 FFmpeg PID: ${ffmpegProcess.pid} | Streams activos: ${streamsActivos}`);

            // Monitoreo
            let bytesEmitidos = 0;
            let primerDatoMs  = null;
            let ultimoChunkMs = Date.now();
            let silencioAlert = false;

            const watchdogInterval = setInterval(() => {
                const silencio = Date.now() - ultimoChunkMs;
                const ramLibre = os.freemem();
                const load     = os.loadavg()[0];
                if (silencio > 3000 && !silencioAlert) {
                    silencioAlert = true;
                    console.warn(`⚠️  [WATCHDOG:VM:${ffmpegProcess.pid}] SIN DATOS por ${(silencio/1000).toFixed(1)}s`);
                    console.warn(`    RAM: ${(ramLibre/1024/1024).toFixed(1)} MB | CPU: ${load.toFixed(2)}`);
                    console.warn(`    Bytes emitidos: ${(bytesEmitidos/1024).toFixed(1)} KB`);
                    if (ramLibre < 100 * 1024 * 1024) console.error(`    🔴 RAM CRÍTICA — probablemente usando SWAP`);
                    if (load > 1.5)                   console.error(`    🔴 CPU SATURADA`);
                } else if (silencio < 3000 && silencioAlert) {
                    silencioAlert = false;
                    console.log(`[WATCHDOG:VM] ✅ Audio reanudado`);
                }
            }, 1000);

            // CREAMOS EL ESPÍA PARA LA VM
            const spyStream = new Transform({
                highWaterMark: 1024 * 1024 * 4, // ⬅️ AÑADIR ESTO: 4 MB de búfer interno
                transform(chunk, encoding, callback) {
                    bytesEmitidos += chunk.length;
                    ultimoChunkMs  = Date.now();
                    if (!primerDatoMs) {
                        primerDatoMs = Date.now();
                        console.log(`[STREAM:VM] ⚡ Primer chunk en ${primerDatoMs - tSpawn}ms | ${chunk.length} bytes`);
                    }
                    if (bytesEmitidos % (1024 * 1024) < chunk.length) {
                        const tasaKbps = primerDatoMs ? ((bytesEmitidos*8)/((Date.now()-primerDatoMs)/1000)/1000).toFixed(1) : '?';
                        console.log(`[STREAM:VM] 📊 ${(bytesEmitidos/1024/1024).toFixed(1)} MB | ~${tasaKbps} kbps | RAM: ${(os.freemem()/1024/1024).toFixed(0)} MB`);
                    }
                    callback(null, chunk);
                }
            });

            // Conectamos FFmpeg al espía
            ffmpegProcess.stdout.pipe(spyStream);

            ffmpegProcess.stderr.on('data', (data) => {
                const msg = data.toString().trim();
                if (!msg) return;
                const esSpam = msg.includes('Non-monotonic DTS') || msg.includes('Queue input is backward') ||
                               msg.includes('invalid as first byte of an EBML') || msg.includes('[aac @') ||
                               msg.includes('aist#0') || msg.includes('dec:aac');
                if (esSpam) return;
                if (msg.toLowerCase().includes('error')) console.error(`[FFmpeg:VM:${ffmpegProcess.pid}] 🔴 ${msg}`);
                else console.warn(`[FFmpeg:VM:${ffmpegProcess.pid}] ⚠️ ${msg}`);
            });

            // Timeout: si no llega primer chunk en 25s, terminar
            let timeoutHandle = setTimeout(() => {
                if (!ffmpegProcess.killed && !primerDatoMs) {
                    console.warn(`[STREAM:VM] ⚠️ Timeout 25s sin audio — matando FFmpeg ${ffmpegProcess.pid}`);
                    ffmpegProcess.kill('SIGKILL');
                }
            }, 25_000);

            ffmpegProcess.stdout.once('data', () => {
                clearTimeout(timeoutHandle);
                console.log(`[STREAM:VM] ✅ Timeout cancelado — FFmpeg emitiendo`);
            });

            ffmpegProcess.on('close', (code, signal) => {
                clearInterval(watchdogInterval);
                clearTimeout(timeoutHandle); // ← FIX: limpiar timeout también en close
                streamsActivos = Math.max(0, streamsActivos - 1);

                const dur      = ((Date.now() - tSpawn) / 1000).toFixed(1);
                const kbEnv    = (bytesEmitidos / 1024).toFixed(1);
                const tasaFinal = primerDatoMs ? ((bytesEmitidos*8)/((Date.now()-primerDatoMs)/1000)/1000).toFixed(1) : '0';

                console.log(`\n[STREAM:VM] ⏹ FFmpeg cerrado`);
                console.log(`   PID         : ${ffmpegProcess.pid}`);
                console.log(`   código      : ${code} | señal: ${signal || 'ninguna'}`);
                console.log(`   duración    : ${dur}s`);
                console.log(`   datos       : ${kbEnv} KB`);
                console.log(`   tasa prom   : ~${tasaFinal} kbps (objetivo: ${targetBitrate}kbps)`);
                console.log(`   primer chunk: ${primerDatoMs ? (primerDatoMs - tSpawn) + 'ms' : 'nunca llegó'}`);

                if (!primerDatoMs) {
                    console.error(`[STREAM:VM] 🔴 FFmpeg cerró sin emitir datos — URL expirada o error de red`);
                    // Limpiar caché para forzar re-extracción en la próxima canción
                    audioUrlCache.delete(cleanUrl);
                    console.log(`[STREAM:VM]   Caché invalidada para re-extracción`);
                }

                logSistema('STREAM_END');
            });

            ffmpegProcess.on('error', (err) => {
                clearInterval(watchdogInterval);
                clearTimeout(timeoutHandle);
                streamsActivos = Math.max(0, streamsActivos - 1);
                console.error(`[STREAM:VM] 🔴 FFmpeg spawn error: ${err.message}`);
                logSistema('STREAM_ERROR');
            });

            return {
                stream:        spyStream, // SE PASA EL spyStream a discord-player, NO ffmpegProcess.stdout directamente
                type:          StreamType.OggOpus, // ⬅️ CAMBIO CRÍTICO: De Opus a OggOpus
                highWaterMark: 1 << 18, // 256KB — NO usar 8MB, causaría burst en VM
            };

        } catch (e) {
            streamsActivos = Math.max(0, streamsActivos - 1);
            console.error(`[STREAM:VM] 🔴 ERROR: ${e.message}`);
            logSistema('STREAM_VM_ERROR');
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
        console.log(`\n[Event:playerStart] 🎵 "${track.title?.slice(0,60)}" | ${track.duration}`);
        logSistema('PLAYER_START_EVENT');

        if (queue.metadata?.ultimoMensaje) {
            try {
                const msgAnterior = queue.metadata.ultimoMensaje;
                const filasDeshabilitadas = msgAnterior.components.map(fila =>
                    ActionRowBuilder.from(fila).setComponents(fila.components.map(btn => ButtonBuilder.from(btn).setDisabled(true)))
                );
                await msgAnterior.edit({ components: filasDeshabilitadas }).catch(() => null);
                console.log('[playerStart] Botones anteriores deshabilitados.');
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
            const mensaje = await queue.metadata.canal.send({ embeds: [embed], components: [fila1, fila2] }).catch(e => {
                console.warn(`[playerStart] No se pudo enviar embed: ${e.message}`);
                return null;
            });
            queue.metadata.ultimoMensaje = mensaje;
            console.log(`[playerStart] ✅ Embed enviado (${modoLabel})`);
        } else {
            console.warn('[playerStart] ⚠️ queue.metadata.canal no disponible');
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
            log(queue.guild, { categoria: 'sistema', titulo: 'Error de Sistema', descripcion: 'Error en el sistema de reproducción.', error: sanitizeErrorMessage(error.message) }).catch(() => null);
        }
    });

    player.events.on('playerError', (queue, error) => {
        console.error(`[Event:playerError] ${error.message}`);
        logSistema('PLAYER_AUDIO_ERROR');
        if (queue?.guild) {
            log(queue.guild, {
                categoria: 'sistema', titulo: 'Error de Audio', descripcion: 'Error al reproducir la pista.',
                campos: queue.currentTrack ? [{ name: '🎵 Pista', value: queue.currentTrack.title, inline: true }] : [],
                error: sanitizeErrorMessage(error.message),
            }).catch(() => null);
        }
    });

    return player;
}

module.exports = { inicializarPlayer, cleanYoutubeUrl, secondsToTime, limpiarParaLyrics };