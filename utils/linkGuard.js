// utils/linkGuard.js — Motor de Seguridad Grado Belka v6.3
const axios = require('axios');
const { ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { log } = require('./logger');

const dominiosSeguros = [
    'discord.com', 'discordapp.com', 'discord.gg', 'discord.media',
    'youtube.com', 'youtu.be', 'music.youtube.com', 'googlevideo.com',
    'soundcloud.com', 'apple.com', 'music.apple.com', 'netflix.com', 'vimeo.com', 
    'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org',
    'www.google.com', 'google.com.mx', 'accounts.google.com', 'googleusercontent.com', 'gstatic.com', 'bing.com',
    'cloudflare.com', 'steamcommunity.com', 'steampowered.com', 'tenor.com', 'giphy.com'
];

const extensionesRiesgo = ['.exe', '.msi', '.bat', '.ps1', '.vbs', '.zip', '.rar', '.7z', '.iso', '.scr', '.jar', '.apk', '.com', '.dll', '.sys', '.bin', '.cmd', '.js', '.wsf', '.cpl', '.msc', '.reg', '.vb', '.vbe', '.ws', '.wsh', '.hta', '.pif', '.gadget', '.lnk'];
const serviciosNube = ['drive.google.com', 'mediafire.com', 'dropbox.com', 'mega.nz', 'anonfiles.com', 'cuty.io', 'cutt.ly', 'bit.ly', 't.co'];

async function expandirUrl(urlOriginal) {
    let ruta = [urlOriginal];
    try {
        const response = await axios.get(urlOriginal, { 
            maxRedirects: 5, 
            timeout: 4000,
            headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124.0.0.0' },
            responseType: 'stream'
        });
        const urlFinal = response.request.res.responseUrl || urlOriginal;
        if (urlFinal !== urlOriginal) ruta.push(urlFinal);
        return { urlFinal, ruta };
    } catch (e) {
        return { urlFinal: urlOriginal, ruta };
    }
}

async function obtenerVeredictoHibrido(url) {
    if (!process.env.HYBRID_ANALYSIS_KEY) return null;
    try {
        // CORRECCIÓN: Usamos URLSearchParams y ID 330 (Ubuntu 24.04)
        const params = new URLSearchParams();
        params.append('url', url);
        params.append('environment_id', '330'); 

        const res = await axios.post('https://www.hybrid-analysis.com/api/v2/quick-scan/url', params, {
            headers: { 
                'api-key': process.env.HYBRID_ANALYSIS_KEY,
                'User-Agent': 'Falcon', // UA recomendado por la API
                'Content-Type': 'application/x-www-form-urlencoded'
            }
        });
        return res.data;
    } catch (e) {
        // Log detallado para tu consola PM2 en Windows
        console.error('[DEBUG-HYBRID] Error de validación:', e.response?.data || e.message);
        return null;
    }
}


async function obtenerAnalisisVisual(url) {
    if (!process.env.URLSCAN_KEY) return null;
    try {
        const res = await axios.post('https://urlscan.io/api/v1/scan/', {
            url: url,
            visibility: 'public'
        }, {
            headers: { 'API-Key': process.env.URLSCAN_KEY, 'Content-Type': 'application/json' }
        });
        return { reporte: res.data.result };
    } catch (e) {
        return null;
    }
}

async function escanearEnlace(link) {
    const { urlFinal, ruta } = await expandirUrl(link);
    const urlObj = new URL(urlFinal);
    const hostname = urlObj.hostname.replace('www.', '');
    const cleanUrl = urlFinal.replace(/\/$/, "");

    let reporte = { detectado: false, motivo: '', nivel: 'Bajo', cleanUrl, ruta, hibrido: null, visual: null, resultados: {} };

    // 1. Heurística (Prioridad para Drive/Mediafire)
    const esServicioNube = serviciosNube.some(serv => hostname.includes(serv));
    const tieneExtension = extensionesRiesgo.some(ext => urlObj.pathname.toLowerCase().endsWith(ext));

    if (esServicioNube || tieneExtension) {
        reporte.detectado = true;
        reporte.motivo = tieneExtension ? `Heurística: Archivo sospechoso (\`${urlObj.pathname.split('/').pop()}\`)` : 'Alerta: Almacenamiento externo';
        reporte.nivel = tieneExtension ? 'Crítico' : 'Medio';
    }

    // 2. Whitelist
    if (!reporte.detectado && dominiosSeguros.some(d => hostname.endsWith(d))) {
        return { ...reporte, detectado: false, motivo: 'Dominio de confianza', nivel: 'Seguro' };
    }

    // 3. Restauración de Escaneo Cuádruple
    const urlIdVT = Buffer.from(cleanUrl).toString('base64').replace(/=/g, '');
    try {
        const [resHaus, resGoogle, resIPQS, resVT, hibrido, visual] = await Promise.all([
            axios.post('https://urlhaus-api.abuse.ch/v1/url/', new URLSearchParams({ url: cleanUrl })).catch(() => null),
            axios.post(`https://safebrowsing.googleapis.com/v4/threatMatches:find?key=${process.env.GOOGLE_SAFE_BROWSING_KEY}`, {
                client: { clientId: "vitabot", clientVersion: "3.0" },
                threatInfo: { 
                    threatTypes: ["MALWARE", "SOCIAL_ENGINEERING", "UNWANTED_SOFTWARE"], 
                    platformTypes: ["ANY_PLATFORM"], 
                    threatEntryTypes: ["URL"], 
                    threatEntries: [{ url: cleanUrl }] 
                }
            }).catch(() => null),
            axios.get(`https://www.ipqualityscore.com/api/json/url/${process.env.IPQS_KEY}/${encodeURIComponent(cleanUrl)}`).catch(() => null),
            axios.get(`https://www.virustotal.com/api/v3/urls/${urlIdVT}`, { headers: { 'x-apikey': process.env.VIRUSTOTAL_KEY }}).catch(() => null),
            obtenerVeredictoHibrido(cleanUrl),
            obtenerAnalisisVisual(cleanUrl)
        ]);

        const statsVT = resVT?.data?.data?.attributes?.last_analysis_stats;
        const esPhishingGoogle = !!resGoogle?.data?.matches;

        if (hibrido?.verdict === 'malicious') {
            reporte = { ...reporte, detectado: true, motivo: 'Hybrid Analysis: Malware Confirmado', nivel: 'Crítico' };
        } else if (resHaus?.data?.query_status === 'ok' && resHaus.data.url_status === 'online') {
            reporte = { ...reporte, detectado: true, motivo: 'URLhaus: Malware activo', nivel: 'Crítico' };
        } else if (esPhishingGoogle) {
            reporte = { ...reporte, detectado: true, motivo: 'Google: Sitio Engañoso/Phishing', nivel: 'Alto' };
        } else if (statsVT?.malicious > 1) {
            reporte = { ...reporte, detectado: true, motivo: `VirusTotal: ${statsVT.malicious} motores positivos`, nivel: 'Alto' };
        }

        reporte.hibrido = hibrido;
        reporte.visual = visual;
        // Guardamos todos los resultados para un análisis forense completo, los resultados que analizar.js usará para la cuarentena y el log detallado en el canal de seguridad
        reporte.resultados = { statsVT, resHaus: resHaus?.data, esPhishingGoogle, resIPQS: resIPQS?.data };
    } catch (error) {
        console.error('[LinkGuard] Error en APIs:', error.message);
    }

    return reporte;
}

/**
 * 📦 GESTIÓN DE CUARENTENA (Auto-borrado en 10 min)
 */
async function ejecutarCuarentena(message, reporte) {
    const originalContent = message.content;
    await message.delete().catch(() => null);
    
    await message.channel.send(`🛡️ **Cuarentena Belka:** Enlace de ${message.author} ocultado por seguridad. Motivo: \`${reporte.motivo}\`.`);

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId(`approve_link_${message.channel.id}`).setLabel('Aprobar').setStyle(ButtonStyle.Success),
        new ButtonBuilder().setCustomId(`deny_link_${message.id}`).setLabel('Eliminar').setStyle(ButtonStyle.Danger)
    );

    // Extraemos los resultados de las APIs para mostrarlos en el log
    const { statsVT, resIPQS, esPhishingGoogle } = reporte.resultados ?? {};

    const logMsg = await log(message.guild, {
        categoria: 'sistema',
        titulo: '🚨 Alerta de Seguridad Forense v6.1',
        descripcion: `Análisis multinivel completado. Se auto-bloqueará en **10 minutos**.`,
        campos: [
            { name: '🛤️ Ruta detectada', value: reporte.ruta.map(r => `↪️ \`${new URL(r).hostname}\``).join('\n'), inline: false },
            { name: '🔬 Sandbox Windows', value: reporte.hibrido ? `**${reporte.hibrido.verdict.toUpperCase()}**` : '⚪ Sin datos', inline: true },
            { name: '🛑 Google Safe Browsing', value: esPhishingGoogle ? '🚨 Phishing detectado' : '✅ Limpio', inline: true },
            { name: '🛡️ VirusTotal', value: statsVT ? `🚨 Maliciosos: **${statsVT.malicious}** | Sospechosos: **${statsVT.suspicious}**` : '⚪ Sin datos', inline: true },
            { name: '📊 IPQualityScore', value: resIPQS ? `🚩 Riesgo: **${resIPQS.risk_score ?? 0}/100** | Phishing: ${resIPQS.phishing ? '🚨 Sí' : '✅ No'} | Malware: ${resIPQS.malware ? '🚨 Sí' : '✅ No'}` : '⚪ Sin datos', inline: true },
            { name: '🚩 Diagnóstico Principal', value: `\`${reporte.motivo}\``, inline: false },
            { name: '📝 Mensaje Original', value: originalContent.substring(0, 1024), inline: false }
        ],
        usuario: message.author,
        componentes: [row]
    });

    if (logMsg) {
        setTimeout(async () => {
            const freshMsg = await logMsg.fetch().catch(() => null);
            if (freshMsg && freshMsg.components.length > 0) {
                await freshMsg.edit({
                    content: '⏰ **Revisión expirada:** El enlace ha sido purgado permanentemente.',
                    components: []
                }).catch(() => null);
            }
        }, 600000); // 10 minutos para una revisión forense exhaustiva
    }
}

module.exports = { dominiosSeguros, expandirUrl, escanearEnlace, ejecutarCuarentena };