const VIDEO_ID = /^[A-Za-z0-9_-]{11}$/;
const YOUTUBE = new Set(['youtube.com', 'www.youtube.com', 'music.youtube.com', 'm.youtube.com']);

class ErrorAudio extends Error {
    constructor(message, status = 502) { super(message); this.name = 'ErrorAudio'; this.status = status; }
}
function interpretarConsulta(value) {
    if (typeof value !== 'string' || !value.trim() || value.length > 500) throw new ErrorAudio('Escribe una búsqueda de hasta 500 caracteres.', 400);
    const query = value.trim();
    if (!/^[a-z][a-z\d+.-]*:/i.test(query)) return { type: 'search', value: `ytsearch5:${query}` };
    let url;
    try { url = new URL(query); } catch { throw new ErrorAudio('El enlace no es válido.', 400); }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) throw new ErrorAudio('El enlace no es compatible.', 400);
    const host = url.hostname.toLowerCase();
    if (host === 'open.spotify.com' || host === 'spotify.com') {
        const match = url.pathname.match(/^\/(?:intl-[a-z]+\/)?track\/([A-Za-z0-9]{22})\/?$/);
        if (!match) throw new ErrorAudio('Por ahora Spotify admite enlaces de canciones individuales.', 400);
        return { type: 'spotify', value: `https://open.spotify.com/track/${match[1]}` };
    }
    if (!YOUTUBE.has(host) && host !== 'youtu.be') throw new ErrorAudio('Usa enlaces de YouTube o una canción de Spotify.', 400);
    const id = host === 'youtu.be' ? url.pathname.slice(1) : url.searchParams.get('v') || url.pathname.match(/^\/(?:shorts|live)\/([^/]+)/)?.[1];
    const list = url.searchParams.get('list');
    if (list && /^[A-Za-z0-9_-]{8,100}$/.test(list)) return { type: 'playlist', value: `https://www.youtube.com/playlist?list=${list}` };
    if (!VIDEO_ID.test(id || '')) throw new ErrorAudio('No encuentro el identificador del video.', 400);
    return { type: 'video', value: `https://www.youtube.com/watch?v=${id}` };
}
function obtenerUrlVideo(value) {
    const query = interpretarConsulta(value);
    if (query.type !== 'video') throw new ErrorAudio('Se necesita un video individual de YouTube.', 400);
    return query.value;
}
function formatearDuracion(seconds) {
    const n = Math.max(0, Math.floor(Number(seconds) || 0));
    return `${Math.floor(n / 60)}:${String(n % 60).padStart(2, '0')}`;
}
function normalizarCancion(data) {
    const id = data.id;
    const url = VIDEO_ID.test(id || '') ? `https://www.youtube.com/watch?v=${id}` : obtenerUrlVideo(data.url || data.webpage_url || '');
    const thumbnail = data.thumbnail || data.thumbnails?.at(-1)?.url || '';
    return {
        url, title: String(data.title || 'Video sin título').slice(0, 200),
        author: String(data.channel || data.uploader || data.author || 'YouTube').slice(0, 100),
        durationSeconds: Math.max(0, Number(data.durationSeconds ?? data.duration) || 0),
        thumbnail: /^https:\/\//.test(thumbnail) ? thumbnail.slice(0, 1000) : '',
    };
}
module.exports = { ErrorAudio, interpretarConsulta, obtenerUrlVideo, normalizarCancion, formatearDuracion };
