// utils/linkGuard.js — Motor de Seguridad Grado Belka v8.0
const axios = require('axios');
const { expandirUrlPublica, interpretarUrlPublica, coincideHost } = require('./urlPublica');
const { ejecutarCuarentena } = require('./cuarentena');
const { crearPoliticaSolicitudes } = require('./politicaSolicitudes');
const { createHash } = require('node:crypto');
const providerPolicies = Object.fromEntries(Object.entries({ urlhaus: 12, google: 30, ipqs: 10, virustotal: 4 }).map(([name, budget]) =>
    [name, crearPoliticaSolicitudes({ concurrent: 3, queued: 0, perMinute: budget, globalPerMinute: budget })]));

// ─────────────────────────────────────────────
// WHITELIST DE DOMINIOS SEGUROS
// ─────────────────────────────────────────────
const dominiosSeguros = [
    'discord.com', 'discordapp.com', 'discord.gg', 'discord.media',
    'youtube.com', 'youtu.be', 'music.youtube.com', 'googlevideo.com',
    'soundcloud.com', 'apple.com', 'music.apple.com', 'netflix.com', 'vimeo.com',
    'github.com', 'githubusercontent.com', 'gitlab.com', 'bitbucket.org',
    'google.com', 'accounts.google.com', 'googleusercontent.com', 'gstatic.com', 'bing.com',
    'cloudflare.com', 'tenor.com', 'giphy.com',
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
const expandirUrl = expandirUrlPublica;

// ─────────────────────────────────────────────
// ANÁLISIS VISUAL urlscan.io
// ─────────────────────────────────────────────
async function obtenerAnalisisVisual(url) {
    if (!process.env.URLSCAN_KEY || process.env.URLSCAN_ENABLED !== 'true') return null;
    // Never downgrade private scans to public when the provider rejects them.
    if (new URL(url).search) return null;
    try {
        const res = await axios.post('https://urlscan.io/api/v1/scan/', {
            url, visibility: 'private'
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
        contexto = '📦 Almacenamiento externo, sin detecciones confirmadas. Revisa la cobertura.';
    } else if (tieneExtension) {
        contexto = '⚙️ Archivo ejecutable, sin detecciones confirmadas. Revisa la cobertura.';
    } else {
        contexto = 'No hay detecciones confirmadas; revisa la cobertura de los proveedores.';
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
        return `Sin detección (${statsVT.harmless ?? 0} motores lo clasificaron como inofensivo)`;
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
function crearEscanerEnlaces({ scan = analizarEnlaceSinCache, now = Date.now,
    policy = crearPoliticaSolicitudes({ concurrent: 3, queued: 6, waitMs: 5000, perMinute: 12 }), maxEntries = 200 } = {}) {
    const cache = new Map(), pending = new Map();
    return async function scanCached(link, { scope = 'global' } = {}) {
        const canonical = interpretarUrlPublica(link).href;
        const key = createHash('sha256').update(canonical).digest('hex');
        for (const [id, item] of cache) if (item.until <= now()) cache.delete(id);
        if (cache.has(key)) return structuredClone(cache.get(key).value);
        if (pending.has(key)) return structuredClone(await pending.get(key));
        if (pending.size >= 9) throw Error('Analizador ocupado.');
        const work = policy.run(scope, () => scan(canonical));
        pending.set(key, work);
        try {
            const value = await work;
            const complete = Object.values(value.resultados?.cobertura || {}).length > 0 &&
                Object.values(value.resultados.cobertura).every(state => state === 'consultado');
            if (cache.size >= maxEntries) cache.delete(cache.keys().next().value);
            cache.set(key, { value: structuredClone(value), until: now() + (complete ? 120_000 : 30_000) });
            return structuredClone(value);
        } finally { pending.delete(key); }
    };
}
const escanearEnlace = crearEscanerEnlaces();
async function analizarEnlaceSinCache(link) {
    interpretarUrlPublica(link);
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
    const esServicioNube = serviciosNube.some(s => coincideHost(hostname, s));
    // 🌟 FIX: Revisar extensión tanto en la URL original como en la final
    const originalUrlObj = new URL(link);
    const tieneExtension = extensionesRiesgo.some(ext => 
        urlObj.pathname.toLowerCase().endsWith(ext) || 
        originalUrlObj.pathname.toLowerCase().endsWith(ext)
    );
    // ⚠️ Ya NO marcamos reporte.detectado = true aquí.
    //    La cuarentena solo se activa si alguna API confirma la amenaza.

    // ── 2. Whitelist ──────────────────────────────────────────────────────
    // Known domains may host user content: they never bypass analysis.


    // ── 3. Análisis multinivel paralelo ──────────────────────────────────
    const urlIdVT = Buffer.from(cleanUrl).toString('base64').replace(/=/g, '');

    const cobertura = {};
    const limits = { timeout: 8000, maxContentLength: 256 * 1024, maxBodyLength: 16384 };
    async function provider(name, configured, request, valid) {
        if (!configured) { cobertura[name] = 'sin_configurar'; return null; }
        try {
            const result = await providerPolicies[name].run(name, request);
            if (!valid(result?.data)) { cobertura[name] = name === 'virustotal' ? 'sin_analisis' : 'error'; return null; }
            cobertura[name] = 'consultado'; return result;
        } catch (error) {
            cobertura[name] = error.name === 'ErrorServicioOcupado' ? 'limitado'
                : name === 'virustotal' && error.response?.status === 404 ? 'sin_analisis' : 'error';
            return null;
        }
    }
    try {
        const [resHaus, resGoogle, resIPQS, resVT, visual] = await Promise.all([
            provider('urlhaus', process.env.URLHAUS_KEY, () => axios.post('https://urlhaus-api.abuse.ch/v1/url/',
                new URLSearchParams({ url: cleanUrl }), { ...limits, headers: { 'Auth-Key': process.env.URLHAUS_KEY } }),
                data => ['ok', 'no_results'].includes(data?.query_status)),
            provider('google', process.env.GOOGLE_SAFE_BROWSING_KEY, () => axios.post(
                'https://safebrowsing.googleapis.com/v4/threatMatches:find', {
                    client: { clientId: 'vitabot', clientVersion: '4.0' }, threatInfo: {
                        threatTypes: ['MALWARE', 'SOCIAL_ENGINEERING', 'UNWANTED_SOFTWARE'], platformTypes: ['ANY_PLATFORM'],
                        threatEntryTypes: ['URL'], threatEntries: [{ url: cleanUrl }],
                    },
                }, { ...limits, headers: { 'x-goog-api-key': process.env.GOOGLE_SAFE_BROWSING_KEY } }),
                data => data && typeof data === 'object' && !Array.isArray(data) && (data.matches === undefined || Array.isArray(data.matches))),
            provider('ipqs', process.env.IPQS_KEY, () => axios.get(
                'https://www.ipqualityscore.com/api/json/url/' + process.env.IPQS_KEY + '/' + encodeURIComponent(cleanUrl), limits),
                data => data?.success === true && typeof data.risk_score === 'number'),
            provider('virustotal', process.env.VIRUSTOTAL_KEY, () => axios.get('https://www.virustotal.com/api/v3/urls/' + urlIdVT,
                { ...limits, headers: { 'x-apikey': process.env.VIRUSTOTAL_KEY } }),
                data => Object.values(data?.data?.attributes?.last_analysis_stats || {}).some(value => typeof value === 'number' && value > 0)),
            obtenerAnalisisVisual(cleanUrl),
        ]);
        const rawStats = resVT?.data?.data?.attributes?.last_analysis_stats;
        const statsVT = rawStats ? Object.fromEntries(['malicious', 'suspicious', 'harmless'].map(key =>
            [key, typeof rawStats[key] === 'number' ? Math.max(0, Math.min(1000000, rawStats[key])) : 0])) : undefined;
        const esPhishingGoogle = resGoogle ? !!resGoogle.data?.matches?.length : null;
        const resHausData = resHaus ? { query_status: resHaus.data.query_status, url_status: resHaus.data.url_status } : undefined;
        const resIPQSData = resIPQS ? { success: true, risk_score: Math.max(0, Math.min(100, resIPQS.data.risk_score)),
            phishing: resIPQS.data.phishing === true, malware: resIPQS.data.malware === true, suspicious: resIPQS.data.suspicious === true } : undefined;

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
            reporte.motivo = 'Archivo ejecutable: requiere precaución, sin detección confirmada.';
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
            cobertura,
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
        throw Error('No se pudo completar el análisis.');
    }

    return reporte;
}

// ─────────────────────────────────────────────
// GESTIÓN DE CUARENTENA
// Solo se activa cuando reporte.detectado === true (confirmación de API).
// ─────────────────────────────────────────────
module.exports = {
    dominiosSeguros,
    expandirUrl,
    escanearEnlace,
    ejecutarCuarentena,
    textoVirusTotal,
    textoIPQS,
    obtenerAnalisisVisual,
    crearEscanerEnlaces,
};
