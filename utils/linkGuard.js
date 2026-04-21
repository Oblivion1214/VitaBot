// utils/linkGuard.js — Motor de Seguridad Grado Belka v8.0
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
    'google.com', 'accounts.google.com', 'googleusercontent.com', 'gstatic.com', 'bing.com',
    'cloudflare.com', 'steamcommunity.com', 'steampowered.com', 'tenor.com', 'giphy.com',
    'wikipedia.org', 'wikimedia.org', 'twitch.tv', 'reddit.com', 'redd.it',
    'spotify.com', 'open.spotify.com', 'twitter.com', 'x.com', 'instagram.com',
    'tiktok.com', 'linkedin.com', 'amazon.com', 'microsoft.com', 'office.com'
];

// Extensiones que indican un ejecutable real o script potencialmente peligroso.
// ⚠️ Se eliminaron .js y .zip porque son demasiado comunes en contextos legítimos
//    (.js en proyectos web, .zip en entregas de archivos de comunidades).
//    Quedan solo los que casi nunca tienen uso legítimo en un chat de Discord.
const extensionesRiesgo = [
    '.exe', '.msi', '.bat', '.ps1', '.vbs',
    '.scr', '.jar', '.apk', '.dll', '.sys', '.cmd',
    '.wsf', '.cpl', '.msc', '.reg', '.vb', '.vbe', '.ws', '.wsh',
    '.hta', '.pif', '.gadget', '.lnk'
];

// Servicios de almacenamiento y acortadores de URL — señal de alerta, no confirmación.
const serviciosNube = [
    'drive.google.com', 'mediafire.com', 'dropbox.com', 'mega.nz',
    'anonfiles.com', 'cuty.io', 'cutt.ly', 'bit.ly', 't.co', 'ow.ly',
    'tinyurl.com', 'is.gd', 'buff.ly', 'adf.ly', 'short.io', 'shorte.st',
    'soo.gd', 's.id', 'rebrand.ly', 'bl.ink', 'lnkd.in', 'db.tt', 'qr.ae',
    'ity.im', 'q.gs', 'po.st', 'bc.vc', 'twurl.nl', 'u.to', 'j.mp',
    'b.link', 'zpaste.net'
];

// ─────────────────────────────────────────────
// EXPANSIÓN DE URL
// HEAD primero (sin descargar body), GET como fallback.
// ─────────────────────────────────────────────
async function expandirUrl(urlOriginal) {
    const ruta = [urlOriginal];
    const headers = { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0' };
    const opciones = { maxRedirects: 5, timeout: 5000, headers, validateStatus: () => true };

    try {
        const res = await axios.head(urlOriginal, opciones);
        const urlFinal = res.request?.res?.responseUrl || res.config?.url || urlOriginal;
        if (urlFinal !== urlOriginal) ruta.push(urlFinal);
        return { urlFinal, ruta };
    } catch {
        try {
            const res = await axios.get(urlOriginal, { ...opciones, responseType: 'stream' });
            const urlFinal = res.request?.res?.responseUrl || urlOriginal;
            res.data.destroy();
            if (urlFinal !== urlOriginal) ruta.push(urlFinal);
            return { urlFinal, ruta };
        } catch {
            return { urlFinal: urlOriginal, ruta };
        }
    }
}

// ─────────────────────────────────────────────
// ANÁLISIS VISUAL urlscan.io
// ─────────────────────────────────────────────
async function obtenerAnalisisVisual(url) {
    if (!process.env.URLSCAN_KEY) return null;
    try {
        const res = await axios.post('https://urlscan.io/api/v1/scan/', {
            url, visibility: 'public'
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
// SCORE DE RIESGO COMPUESTO v3
//
// Problema anterior: IPQS=89/100 + VT=1 daban score final 18/100 porque
// el peso de IPQS era solo 15%. Eso no refleja la realidad.
//
// Solución: el score final es el MÁXIMO entre:
//   (a) Score agregado de todas las fuentes
//   (b) El peor indicador individual escalado
// Así un IPQS de 89 no puede quedar diluido a 13.
// ─────────────────────────────────────────────
function calcularScoreCompuesto({ statsVT, resIPQS, esPhishingGoogle, resHaus, esServicioNube, tieneExtension }) {
    const confirmacionesAPI =
        (resHaus?.url_status === 'online' ? 1 : 0) +
        (esPhishingGoogle                  ? 1 : 0) +
        ((statsVT?.malicious ?? 0) > 0     ? 1 : 0) +
        ((resIPQS?.risk_score ?? 0) >= 75  ? 1 : 0) +
        (resIPQS?.phishing                 ? 1 : 0) +
        (resIPQS?.malware                  ? 1 : 0);

    const hayConfirmacionAPI = confirmacionesAPI > 0;

    // ── Score por API (puntos directos) ──
    let scoreAPI = 0;
    if (resHaus?.url_status === 'online')    scoreAPI += 40;
    if (esPhishingGoogle)                    scoreAPI += 35;
    if ((statsVT?.malicious ?? 0) > 0)      scoreAPI += Math.min(statsVT.malicious * 8, 30);
    if (resIPQS?.phishing)                   scoreAPI += 20;
    if (resIPQS?.malware)                    scoreAPI += 20;

    // ── Peor indicador individual (para evitar dilución) ──
    // Si IPQS dice 89/100, ese valor ya es un score de riesgo — no lo diluimos
    const peorIPQS      = resIPQS?.risk_score ?? 0;
    const peorVT        = (statsVT?.malicious ?? 0) > 0 ? Math.min(statsVT.malicious * 15, 60) : 0;
    const peorGoogle    = esPhishingGoogle ? 70 : 0;
    const peorHaus      = resHaus?.url_status === 'online' ? 80 : 0;
    const peorIndicador = Math.max(peorIPQS, peorVT, peorGoogle, peorHaus);

    // ── Heurística (peso reducido sin confirmación de APIs) ──
    let scoreHeuristico = 0;
    if (tieneExtension)  scoreHeuristico += 40;
    if (esServicioNube)  scoreHeuristico += 20;
    const factorHeuristico = hayConfirmacionAPI ? 1.0 : 0.25;

    // ── Score final: máximo entre agregado y peor indicador ──
    const scoreAgregado = Math.round(scoreAPI + scoreHeuristico * factorHeuristico);
    const score = Math.min(Math.max(scoreAgregado, hayConfirmacionAPI ? peorIndicador : 0), 100);

    let nivel, emoji;
    if      (score >= 75) { nivel = 'CRÍTICO'; emoji = '🔴'; }
    else if (score >= 50) { nivel = 'ALTO';    emoji = '🟠'; }
    else if (score >= 25) { nivel = 'MEDIO';   emoji = '🟡'; }
    else                  { nivel = 'BAJO';    emoji = '🟢'; }

    // ── Contexto claro y sin contradicciones ──
    let contexto = '';
    if (hayConfirmacionAPI) {
        const fuentes = [];
        if (resHaus?.url_status === 'online')   fuentes.push('URLhaus');
        if (esPhishingGoogle)                    fuentes.push('Google Safe Browsing');
        if ((statsVT?.malicious ?? 0) > 0)      fuentes.push(`VirusTotal (${statsVT.malicious} motores)`);
        if ((resIPQS?.risk_score ?? 0) >= 75)   fuentes.push(`IPQS (${resIPQS.risk_score}/100)`);
        if (resIPQS?.phishing)                   fuentes.push('IPQS phishing');
        if (resIPQS?.malware)                    fuentes.push('IPQS malware');
        contexto = `🚨 Detectado por: **${fuentes.join(', ')}**`;
    } else if (esServicioNube && !tieneExtension) {
        contexto = '📦 Almacenamiento externo — ninguna API detectó malware.';
    } else if (tieneExtension) {
        contexto = '⚙️ Archivo ejecutable — ninguna API lo marcó como malware.';
    } else {
        contexto = '✅ Ninguna base de datos registró actividad maliciosa.';
    }

    return { score, nivel, emoji, contexto, confirmacionesAPI };
}

// ─────────────────────────────────────────────
// HELPER: texto legible para el resultado de VirusTotal
// Distingue entre "sin datos disponibles", "analizado y limpio" y "amenaza detectada"
// ─────────────────────────────────────────────
function textoVirusTotal(statsVT) {
    if (!statsVT) return '⚪ Sin análisis previo en VT';
    if (statsVT.malicious === 0 && statsVT.suspicious === 0) {
        return `✅ Limpio (${statsVT.harmless ?? 0} motores sin detección)`;
    }
    return `🚨 **${statsVT.malicious}** maliciosos | ⚠️ **${statsVT.suspicious}** sospechosos`;
}

// ─────────────────────────────────────────────
// HELPER: texto legible para IPQualityScore
// ─────────────────────────────────────────────
function textoIPQS(resIPQS) {
    if (!resIPQS) return '⚪ Sin análisis (API no configurada)';
    const score = resIPQS.risk_score ?? 0;
    const flags = [
        resIPQS.phishing ? '🚨 Phishing' : null,
        resIPQS.malware  ? '🚨 Malware'  : null,
        resIPQS.suspicious ? '⚠️ Sospechoso' : null,
    ].filter(Boolean).join(' | ');
    const icono = score >= 75 ? '🚨' : score >= 40 ? '⚠️' : '✅';
    return `${icono} Riesgo: **${score}/100**${flags ? `\n${flags}` : ''}`;
}

// ─────────────────────────────────────────────
// MOTOR PRINCIPAL DE ESCANEO v8
//
// Cambio clave: la heurística YA NO pone detectado=true por sí sola.
// Solo las APIs confirman una detección real. La heurística sube el score
// como señal de alerta pero no activa la cuarentena automática.
// Esto elimina los falsos positivos en archivos legítimos de Drive/Mediafire.
// ─────────────────────────────────────────────
async function escanearEnlace(link) {
    const { urlFinal, ruta } = await expandirUrl(link);
    const urlObj   = new URL(urlFinal);
    const hostname = urlObj.hostname.replace('www.', '');
    const cleanUrl = urlFinal.replace(/\/$/, '');

    let reporte = {
        detectado: false,
        motivo:    '',
        nivel:     'BAJO',
        score:     0,
        cleanUrl,
        ruta,
        visual:    null,
        resultados: {}
    };

    // ── 1. Heurística rápida (señal de alerta, NO detección) ─────────────
    const esServicioNube = serviciosNube.some(s => hostname.includes(s));
    const tieneExtension = extensionesRiesgo.some(ext => urlObj.pathname.toLowerCase().endsWith(ext));
    // ⚠️ Ya NO marcamos reporte.detectado = true aquí.
    //    La cuarentena solo se activa si alguna API confirma la amenaza.

    // ── 2. Whitelist ──────────────────────────────────────────────────────
    if (dominiosSeguros.some(d => hostname.endsWith(d))) {
        return { ...reporte, motivo: 'Dominio en whitelist', nivel: 'BAJO', score: 0 };
    }

    // ── 3. Análisis multinivel paralelo ──────────────────────────────────
    const urlIdVT = Buffer.from(cleanUrl).toString('base64').replace(/=/g, '');

    try {
        const [resHaus, resGoogle, resIPQS, resVT, visual] = await Promise.all([
            process.env.URLHAUS_KEY
                ? axios.post(
                    'https://urlhaus-api.abuse.ch/v1/url/',
                    new URLSearchParams({ url: cleanUrl }),
                    {
                        headers: { 
                            'Auth-Key': process.env.URLHAUS_KEY,
                            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) vitabot-security-module'
                        },
                        timeout: 10000 // ⏳ Aumentado a 10 segundos
                    }
                ).catch(err => {
                    console.error('[URLhaus Error]:', err.response?.data || err.message);
                    return null;
                })
                : null,

            process.env.GOOGLE_SAFE_BROWSING_KEY
                ? axios.post(
                    `https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${process.env.GOOGLE_SAFE_BROWSING_KEY}`,
                    {
                        client: { clientId: 'vitabot', clientVersion: '3.0' },
                        threatInfo: {
                            threatTypes:      ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'],
                            platformTypes:    ['ANY_PLATFORM'],
                            threatEntryTypes: ['URL'],
                            threatEntries:    [{ url: cleanUrl }]
                        }
                    },
                    { timeout: 5000 }
                ).catch(() => null)
                : null,

            process.env.IPQS_KEY
                ? axios.get(
                    `https://www.ipqualityscore.com/api/json/url/${process.env.IPQS_KEY}/${encodeURIComponent(cleanUrl)}`,
                    { timeout: 5000 }
                ).catch(() => null)
                : null,

            process.env.VIRUSTOTAL_KEY
                ? axios.get(
                    `https://www.virustotal.com/api/v3/urls/${urlIdVT}`,
                    { headers: { 'x-apikey': process.env.VIRUSTOTAL_KEY }, timeout: 8000 }
                ).catch(() => null)
                : null,

            obtenerAnalisisVisual(cleanUrl)
        ]);

        const statsVT          = resVT?.data?.data?.attributes?.last_analysis_stats;
        const esPhishingGoogle = !!resGoogle?.data?.matches;
        const resHausData      = resHaus?.data;
        const resIPQSData      = resIPQS?.data;

        // ── 4. Detección: solo por confirmación de APIs ───────────────────
        if (resHausData?.query_status === 'ok' && resHausData?.url_status === 'online') {
            reporte.detectado = true;
            reporte.motivo    = 'URLhaus: Malware activo confirmado en base de datos';
            reporte.nivel     = 'CRÍTICO';
        } else if (esPhishingGoogle) {
            reporte.detectado = true;
            reporte.motivo    = 'Google Safe Browsing: Phishing o sitio engañoso confirmado';
            reporte.nivel     = 'ALTO';
        } else if ((statsVT?.malicious ?? 0) > 1) {
            reporte.detectado = true;
            reporte.motivo    = `VirusTotal: ${statsVT.malicious} motores de antivirus detectaron amenaza`;
            reporte.nivel     = 'ALTO';
        } else if ((resIPQSData?.risk_score ?? 0) >= 85 || resIPQSData?.phishing || resIPQSData?.malware) {
            reporte.detectado = true;
            reporte.motivo    = `IPQualityScore: Score de riesgo ${resIPQSData.risk_score}/100${resIPQSData.phishing ? ' · Phishing confirmado' : ''}${resIPQSData.malware ? ' · Malware confirmado' : ''}`;
            reporte.nivel     = 'ALTO';
        } else if (tieneExtension) {
            // Extensión ejecutable sin confirmación de APIs: alerta, no detección
            reporte.motivo = `Extensión de riesgo: \`${urlObj.pathname.split('/').pop()}\` (sin confirmación de APIs)`;
        } else if (esServicioNube) {
            reporte.motivo = 'Servicio de almacenamiento externo (sin confirmación de APIs)';
        }

        // ── 5. Score compuesto ────────────────────────────────────────────
        const compuesto = calcularScoreCompuesto({
            statsVT, resIPQS: resIPQSData, esPhishingGoogle,
            resHaus: resHausData, esServicioNube, tieneExtension
        });

        reporte.score  = compuesto.score;
        reporte.nivel  = compuesto.nivel;
        reporte.visual = visual;
        reporte.resultados = {
            statsVT,
            resHaus:         resHausData,
            esPhishingGoogle,
            resIPQS:         resIPQSData,
            scoreCompuesto:  compuesto,
            // Flags para el embed
            esServicioNube,
            tieneExtension
        };

    } catch (error) {
        console.error('[LinkGuard] Error en análisis paralelo:', error.message);
    }

    return reporte;
}

// ─────────────────────────────────────────────
// GESTIÓN DE CUARENTENA
// Solo se activa cuando reporte.detectado === true (confirmación de API).
// ─────────────────────────────────────────────
async function ejecutarCuarentena(message, reporte) {
    const originalContent = message.content;
    await message.delete().catch(() => null);

    const { scoreCompuesto } = reporte.resultados ?? {};

    await message.channel.send(
        `🛡️ **Cuarentena:** Enlace de ${message.author} bloqueado.\n` +
        `Motivo: \`${reporte.motivo}\` | Score: **${scoreCompuesto?.score ?? '?'}/100**`
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

    const { statsVT, resIPQS, esPhishingGoogle, resHaus } = reporte.resultados ?? {};

    const logMsg = await log(message.guild, {
        categoria: 'sistema',
        titulo:    `🚨 Alerta de Seguridad — ${scoreCompuesto?.emoji ?? ''} ${scoreCompuesto?.nivel ?? reporte.nivel}`,
        descripcion: `Enlace bloqueado automáticamente. Un moderador debe revisar en los próximos **10 minutos**.`,
        campos: [
            {
                name:   '⚠️ Score de Riesgo',
                value:  scoreCompuesto
                    ? `${scoreCompuesto.emoji} **${scoreCompuesto.score}/100** — ${scoreCompuesto.nivel}\n${scoreCompuesto.contexto}`
                    : '⚪ No calculado',
                inline: false
            },
            { name: '🛑 Google Safe Browsing', value: esPhishingGoogle ? '🚨 Phishing confirmado' : '✅ Limpio',    inline: true },
            { name: '🛡️ VirusTotal',           value: textoVirusTotal(statsVT),                                      inline: true },
            { name: '📊 IPQualityScore',        value: textoIPQS(resIPQS),                                           inline: true },
            {
                name:   '🦠 URLhaus',
                value:  resHaus?.query_status === 'ok'
                    ? (resHaus.url_status === 'online' ? '🚨 Malware activo en base de datos' : `⚠️ Registrado (${resHaus.url_status})`)
                    : '✅ No encontrado',
                inline: false
            },
            { name: '🚩 Motivo del Bloqueo',   value: `\`${reporte.motivo || 'Sin motivo registrado'}\``,           inline: false },
            { name: '🛤️ Ruta Detectada',       value: reporte.ruta.map(r => `↪️ \`${new URL(r).hostname}\``).join('\n') || '—', inline: false },
            // ⚠️ Nombre exacto requerido por index.js para restaurar el mensaje
            { name: '📝 Contenido Original',   value: originalContent.substring(0, 1024),                           inline: false }
        ],
        usuario:     message.author,
        componentes: [row]
    });

    if (logMsg) {
        setTimeout(async () => {
            const freshMsg = await logMsg.fetch().catch(() => null);
            if (freshMsg?.components.length > 0) {
                await freshMsg.edit({
                    content:    '⏰ **Revisión expirada:** Nadie aprobó ni rechazó el enlace en 10 minutos.',
                    components: []
                }).catch(() => null);
            }
        }, 600_000);
    }
}

module.exports = {
    dominiosSeguros,
    expandirUrl,
    escanearEnlace,
    ejecutarCuarentena,
    textoVirusTotal,
    textoIPQS
};