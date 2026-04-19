// utils/linkGuard.js — Motor de Seguridad Grado Belka v7.0
const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { log } = require('./logger');

// ─────────────────────────────────────────────
// WHITELIST DE DOMINIOS SEGUROS
// ─────────────────────────────────────────────
const dominiosSeguros = [
    'discord.com', 'discordapp.com', 'discord.gg', 'discord.media',
    'youtube.com', 'youtu.be', 'music.youtube.com', 'googlevideo.com',
    'soundcloud.com', 'apple.com', 'music.apple.com', 'netflix.com', 'vimeo.com',
    'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org',
    'google.com', 'google.com.mx', 'accounts.google.com', 'googleusercontent.com', 'gstatic.com', 'bing.com',
    'cloudflare.com', 'steamcommunity.com', 'steampowered.com', 'tenor.com', 'giphy.com',
    'wikipedia.org', 'wikimedia.org', 'twitch.tv', 'reddit.com', 'redd.it',
    'spotify.com', 'open.spotify.com'
];

const extensionesRiesgo = [
    '.exe', '.msi', '.bat', '.ps1', '.vbs', '.zip', '.rar', '.7z', '.iso',
    '.scr', '.jar', '.apk', '.com', '.dll', '.sys', '.bin', '.cmd', '.js',
    '.wsf', '.cpl', '.msc', '.reg', '.vb', '.vbe', '.ws', '.wsh', '.hta',
    '.pif', '.gadget', '.lnk'
];

const serviciosNube = [
    'drive.google.com', 'mediafire.com', 'dropbox.com', 'mega.nz',
    'anonfiles.com', 'cuty.io', 'cutt.ly', 'bit.ly', 't.co', 'ow.ly',
    'tinyurl.com', 'is.gd', 'buff.ly', 'adf.ly', 'short.io', 'shorte.st',
    'soo.gd', 's.id', 'rebrand.ly', 'bl.ink', 'lnkd.in', 'db.tt', 'qr.ae',
    'ity.im', 'q.gs', 'po.st', 'bc.vc', 'twurl.nl', 'u.to', 'j.mp',
    'b.link', 'zpaste.net'
];

// ─────────────────────────────────────────────
// EXPANSIÓN DE URL CON SEGUIMIENTO DE REDIRECCIONES
// Usa HEAD primero (sin descargar body) y GET solo como fallback.
// ─────────────────────────────────────────────
async function expandirUrl(urlOriginal) {
    const ruta = [urlOriginal];
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0' };

    const opciones = {
        maxRedirects: 5,
        timeout: 5000,
        headers,
        validateStatus: () => true, // no lanzar error en 4xx/5xx
    };

    try {
        // HEAD primero: no descarga body, mucho más eficiente
        const res = await axios.head(urlOriginal, opciones);
        const urlFinal = res.request?.res?.responseUrl || res.config?.url || urlOriginal;
        if (urlFinal !== urlOriginal) ruta.push(urlFinal);
        return { urlFinal, ruta };
    } catch {
        // Fallback a GET si HEAD falla (algunos servidores lo bloquean)
        try {
            const res = await axios.get(urlOriginal, { ...opciones, responseType: 'stream' });
            const urlFinal = res.request?.res?.responseUrl || urlOriginal;
            res.data.destroy(); // cerrar stream inmediatamente, no necesitamos el body
            if (urlFinal !== urlOriginal) ruta.push(urlFinal);
            return { urlFinal, ruta };
        } catch {
            return { urlFinal: urlOriginal, ruta };
        }
    }
}

// ─────────────────────────────────────────────
// ANÁLISIS VISUAL CON urlscan.io
// ─────────────────────────────────────────────
async function obtenerAnalisisVisual(url) {
    if (!process.env.URLSCAN_KEY) return null;
    try {
        const res = await axios.post('https://urlscan.io/api/v1/scan/', {
            url,
            visibility: 'public'
        }, {
            headers: { 'API-Key': process.env.URLSCAN_KEY, 'Content-Type': 'application/json' },
            timeout: 5000
        });
        return { reporte: res.data.result };
    } catch {
        return null;
    }
}

// ─────────────────────────────────────────────
// SCORE DE RIESGO COMPUESTO
// Combina todas las fuentes en un número de 0–100 y un nivel de amenaza.
// Así el usuario no tiene que interpretar 4 campos por separado.
// ─────────────────────────────────────────────
function calcularScoreCompuesto({ statsVT, resIPQS, esPhishingGoogle, resHaus, esServicioNube, tieneExtension }) {
    let score = 0;

    if (tieneExtension)        score += 40; // archivo ejecutable = riesgo muy alto
    if (esServicioNube)        score += 20; // almacenamiento externo = riesgo medio
    if (esPhishingGoogle)      score += 35; // Google confirmó phishing
    if (resHaus?.url_status === 'online') score += 40; // URLhaus: malware activo confirmado
    if (statsVT?.malicious > 0) score += Math.min(statsVT.malicious * 5, 30); // hasta 30pts por VT
    if (resIPQS?.risk_score)   score += Math.floor(resIPQS.risk_score * 0.15); // hasta ~15pts por IPQS
    if (resIPQS?.phishing)     score += 15;
    if (resIPQS?.malware)      score += 15;

    score = Math.min(score, 100);

    let nivel, emoji;
    if      (score >= 70) { nivel = 'CRÍTICO';  emoji = '🔴'; }
    else if (score >= 40) { nivel = 'ALTO';     emoji = '🟠'; }
    else if (score >= 20) { nivel = 'MEDIO';    emoji = '🟡'; }
    else                  { nivel = 'BAJO';     emoji = '🟢'; }

    return { score, nivel, emoji };
}

// ─────────────────────────────────────────────
// MOTOR PRINCIPAL DE ESCANEO
// ─────────────────────────────────────────────
async function escanearEnlace(link) {
    const { urlFinal, ruta } = await expandirUrl(link);
    const urlObj    = new URL(urlFinal);
    const hostname  = urlObj.hostname.replace('www.', '');
    const cleanUrl  = urlFinal.replace(/\/$/, '');

    let reporte = {
        detectado: false,
        motivo: '',
        nivel: 'BAJO',
        score: 0,
        cleanUrl,
        ruta,
        visual: null,
        resultados: {}
    };

    // ── 1. Heurística rápida (sin llamadas a API) ────────────────────────
    const esServicioNube = serviciosNube.some(s => hostname.includes(s));
    const tieneExtension = extensionesRiesgo.some(ext => urlObj.pathname.toLowerCase().endsWith(ext));

    if (esServicioNube || tieneExtension) {
        reporte.detectado = true;
        reporte.motivo = tieneExtension
            ? `Archivo sospechoso: \`${urlObj.pathname.split('/').pop()}\``
            : 'Almacenamiento / acortador externo';
        reporte.nivel  = tieneExtension ? 'CRÍTICO' : 'MEDIO';
    }

    // ── 2. Whitelist (evita análisis innecesario en dominios de confianza) ─
    if (!reporte.detectado && dominiosSeguros.some(d => hostname.endsWith(d))) {
        return { ...reporte, detectado: false, motivo: 'Dominio de confianza', nivel: 'BAJO', score: 0 };
    }

    // ── 3. Análisis multinivel paralelo ─────────────────────────────────
    const urlIdVT = Buffer.from(cleanUrl).toString('base64').replace(/=/g, '');

    try {
        const [resHaus, resGoogle, resIPQS, resVT, visual] = await Promise.all([
            // URLhaus: base de datos de malware activo (gratuita, sin key)
            axios.post(
                'https://urlhaus-api.abuse.ch/v1/url/',
                new URLSearchParams({ url: cleanUrl }),
                { timeout: 5000 }
            ).catch(() => null),

            // Google Safe Browsing
            process.env.GOOGLE_SAFE_BROWSING_KEY
                ? axios.post(
                    `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${process.env.GOOGLE_SAFE_BROWSING_KEY}`,
                    {
                        client: { clientId: 'vitabot', clientVersion: '3.0' },
                        threatInfo: {
                            threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
                            platformTypes: ['ANY_PLATFORM'],
                            threatEntryTypes: ['URL'],
                            threatEntries: [{ url: cleanUrl }]
                        }
                    },
                    { timeout: 5000 }
                ).catch(() => null)
                : null,

            // IPQualityScore
            process.env.IPQS_KEY
                ? axios.get(
                    `https://www.ipqualityscore.com/api/json/url/${process.env.IPQS_KEY}/${encodeURIComponent(cleanUrl)}`,
                    { timeout: 5000 }
                ).catch(() => null)
                : null,

            // VirusTotal
            process.env.VIRUSTOTAL_KEY
                ? axios.get(
                    `https://www.virustotal.com/api/v3/urls/${urlIdVT}`,
                    { headers: { 'x-apikey': process.env.VIRUSTOTAL_KEY }, timeout: 8000 }
                ).catch(() => null)
                : null,

            // urlscan.io — análisis visual
            obtenerAnalisisVisual(cleanUrl)
        ]);

        const statsVT        = resVT?.data?.data?.attributes?.last_analysis_stats;
        const esPhishingGoogle = !!resGoogle?.data?.matches;
        const resHausData    = resHaus?.data;
        const resIPQSData    = resIPQS?.data;

        // Determinar detección por API (solo si la heurística no ya lo marcó)
        if (!reporte.detectado) {
            if (resHausData?.query_status === 'ok' && resHausData?.url_status === 'online') {
                reporte = { ...reporte, detectado: true, motivo: 'URLhaus: Malware activo confirmado', nivel: 'CRÍTICO' };
            } else if (esPhishingGoogle) {
                reporte = { ...reporte, detectado: true, motivo: 'Google Safe Browsing: Phishing/Sitio engañoso', nivel: 'ALTO' };
            } else if (statsVT?.malicious > 1) {
                reporte = { ...reporte, detectado: true, motivo: `VirusTotal: ${statsVT.malicious} motores detectaron amenaza`, nivel: 'ALTO' };
            } else if (resIPQSData?.risk_score >= 85) {
                reporte = { ...reporte, detectado: true, motivo: `IPQualityScore: Riesgo alto (${resIPQSData.risk_score}/100)`, nivel: 'ALTO' };
            }
        }

        // Score compuesto unificado
        const compuesto = calcularScoreCompuesto({
            statsVT, resIPQS: resIPQSData, esPhishingGoogle,
            resHaus: resHausData, esServicioNube, tieneExtension
        });

        reporte.score  = compuesto.score;
        reporte.nivel  = compuesto.nivel;
        reporte.visual = visual;
        reporte.resultados = {
            statsVT,
            resHaus: resHausData,
            esPhishingGoogle,
            resIPQS: resIPQSData,
            scoreCompuesto: compuesto
        };

    } catch (error) {
        console.error('[LinkGuard] Error en análisis paralelo:', error.message);
    }

    return reporte;
}

// ─────────────────────────────────────────────
// GESTIÓN DE CUARENTENA
// Borra el mensaje, notifica el canal y crea el log de moderación
// con botones Aprobar/Eliminar que expiran en 10 minutos.
// ─────────────────────────────────────────────
async function ejecutarCuarentena(message, reporte) {
    const originalContent = message.content;
    await message.delete().catch(() => null);

    await message.channel.send(
        `🛡️ **Cuarentena Belka:** Enlace de ${message.author} bloqueado por seguridad.\nMotivo: \`${reporte.motivo}\` | Riesgo: **${reporte.resultados?.scoreCompuesto?.score ?? '?'}/100**`
    ).catch(() => null);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`approve_link_${message.channel.id}`)
            .setLabel('Aprobar y Restaurar')
            .setEmoji('✅')
            .setStyle(ButtonStyle.Success),
        new ButtonBuilder()
            .setCustomId(`deny_link_${message.id}`)
            .setLabel('Confirmar Eliminación')
            .setEmoji('🗑️')
            .setStyle(ButtonStyle.Danger)
    );

    const { statsVT, resIPQS, esPhishingGoogle, resHaus, scoreCompuesto } = reporte.resultados ?? {};

    // ⚠️ El nombre del campo DEBE coincidir exactamente con el que index.js
    // busca para restaurar el mensaje: '📝 Contenido Original'
    const logMsg = await log(message.guild, {
        categoria: 'sistema',
        titulo: `🚨 Alerta de Seguridad — Riesgo ${scoreCompuesto?.emoji ?? ''} ${scoreCompuesto?.nivel ?? reporte.nivel}`,
        descripcion: `Análisis multinivel completado. Acción pendiente de moderador. Se auto-purgará en **10 minutos**.`,
        campos: [
            // Fila 1: score compuesto (ancho completo, el más importante)
            {
                name: '⚠️ Score de Riesgo Compuesto',
                value: scoreCompuesto
                    ? `${scoreCompuesto.emoji} **${scoreCompuesto.score}/100** — Nivel: **${scoreCompuesto.nivel}**`
                    : '⚪ No calculado',
                inline: false
            },
            // Fila 2: 3 fuentes inline (ocupan una fila completa juntas)
            {
                name: '🛑 Google Safe Browsing',
                value: esPhishingGoogle ? '🚨 Phishing' : '✅ Limpio',
                inline: true
            },
            {
                name: '🛡️ VirusTotal',
                value: statsVT
                    ? `🚨 ${statsVT.malicious} maliciosos\n⚠️ ${statsVT.suspicious} sospechosos`
                    : '⚪ Sin datos',
                inline: true
            },
            {
                name: '📊 IPQualityScore',
                value: resIPQS
                    ? `🚩 **${resIPQS.risk_score ?? 0}/100**\nPhishing: ${resIPQS.phishing ? '🚨' : '✅'} | Malware: ${resIPQS.malware ? '🚨' : '✅'}`
                    : '⚪ Sin datos',
                inline: true
            },
            // Fila 3: URLhaus (ancho completo)
            {
                name: '🦠 URLhaus',
                value: resHaus?.query_status === 'ok'
                    ? (resHaus.url_status === 'online' ? '🚨 Malware activo' : `⚠️ Registrado (${resHaus.url_status})`)
                    : '✅ No encontrado',
                inline: false
            },
            // Fila 4: diagnóstico y ruta (ancho completo)
            {
                name: '🚩 Diagnóstico Principal',
                value: `\`${reporte.motivo}\``,
                inline: false
            },
            {
                name: '🛤️ Ruta de Redirección',
                value: reporte.ruta.map(r => `↪️ \`${new URL(r).hostname}\``).join('\n'),
                inline: false
            },
            // ⚠️ Este campo lo usa index.js para restaurar el mensaje — no cambiar el nombre
            {
                name: '📝 Contenido Original',
                value: originalContent.substring(0, 1024),
                inline: false
            }
        ],
        usuario: message.author,
        componentes: [row]
    });

    if (logMsg) {
        setTimeout(async () => {
            const freshMsg = await logMsg.fetch().catch(() => null);
            if (freshMsg && freshMsg.components.length > 0) {
                await freshMsg.edit({
                    content: '⏰ **Revisión expirada:** El enlace ha sido purgado permanentemente sin acción de moderador.',
                    components: []
                }).catch(() => null);
            }
        }, 600_000); // 10 minutos
    }
}

module.exports = { dominiosSeguros, expandirUrl, escanearEnlace, ejecutarCuarentena };