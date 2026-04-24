// commands/analizar.js — Reporte Forense Belka v8.0 + Gemini AI (Vita Personality)
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { dominiosSeguros, escanearEnlace, textoVirusTotal, textoIPQS } = require('../utils/linkGuard');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');

// Inicializamos el motor de Gemini usando tu variable de entorno
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('analizar')
        .setDescription('Escaneo de seguridad: URLhaus + Google + VirusTotal + IPQS evaluado por Vita.')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('La URL o link a examinar')
                .setRequired(true)
        ),

    async execute(interaction) {
        const url = interaction.options.getString('url');

        // ── 1. Validar formato ─────────────────────────────────────────────
        let urlObj;
        try {
            urlObj = new URL(url);
        } catch {
            return interaction.reply({
                content: '❌ ¡Oye! Esa URL está malformada. Incluye el protocolo completo (ej: `https://ejemplo.com`). No me hagas perder el tiempo.',
                flags: MessageFlags.Ephemeral
            });
        }

        // ── 2. Whitelist ───────────────────────────────────────────────────
        const hostname = urlObj.hostname.replace('www.', '');
        if (dominiosSeguros.some(d => hostname.endsWith(d))) {
            return interaction.reply({
                content: `✅ **${hostname}** está en la lista de dominios seguros de Hayate. No requiere que use a Graf Eisen para esto.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            // ── 3. Ejecutar análisis matemático (Los sensores) ─────────────
            const reporte = await escanearEnlace(url);
            const { visual, ruta, resultados } = reporte;
            const { statsVT, resIPQS, esPhishingGoogle, resHaus, scoreCompuesto, esServicioNube, tieneExtension } = resultados;

            // ── 4. EL CEREBRO DE VITA (Gemini AI con Cadena de Rescate) ────────
            let veredictoIA = '⏳ Procesando datos mágicos...';
            
            // Definimos nuestros modelos de mayor a menor prioridad
            const modelosParaProbar = ["gemini-flash-latest","gemini-2.0-flash", "gemini-1.5-flash", "gemini-1.5-flash-8b"];
            let aiResult = null;

            const promptForense = `
            Analiza este enlace: "${url}"
            Datos extraídos por los sensores de Graf Eisen:
            - Redirecciones ocultas: ${ruta.length > 1 ? ruta.join(' -> ') : 'Ninguna'}
            - Archivo ejecutable/sospechoso directo: ${tieneExtension ? 'Sí' : 'No'}
            - Alojado en nube pública (ej. Mediafire, Mega): ${esServicioNube ? 'Sí' : 'No'}
            - VirusTotal: ${statsVT ? `Maliciosos: ${statsVT.malicious}, Sospechosos: ${statsVT.suspicious}, Limpios: ${statsVT.harmless}` : 'Sin datos'}
            - IPQualityScore: ${resIPQS ? `Riesgo: ${resIPQS.risk_score}/100, Phishing: ${resIPQS.phishing}, Malware: ${resIPQS.malware}` : 'Sin datos'}
            - Google Safe Browsing: ${esPhishingGoogle ? 'DETECTA PHISHING' : 'Limpio'}
            - URLhaus: ${resHaus?.url_status === 'online' ? 'MALWARE ACTIVO' : 'Limpio'}
            
            Danos tu veredicto final.`;

            for (const nombreModelo of modelosParaProbar) {
                try {
                    const model = genAI.getGenerativeModel({ 
                        model: nombreModelo,
                        systemInstruction: `Eres Vita, la Caballera del Martillo de Hierro. Tienes una personalidad tsundere, directa, firme y orgullosa. 
                        Para este comando, estás operando tu martillo mágico 'Graf Eisen' en modo 'Análisis Forense' para proteger el servidor.
                        Tu trabajo es leer los datos técnicos de un enlace y darle al usuario un veredicto claro, rápido y sin rodeos de si es seguro o peligroso.
                        Usa máximo 3 o 4 oraciones. Sé contundente. Si el enlace es peligroso, adviérteles bruscamente y usa el emoji de tu martillo (🔨) para indicar que lo aplastarás si lo envían públicamente. Si es seguro, diles que pueden pasar pero que no se confíen demasiado.`,
                        safetySettings: [
                            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                        ],
                    });

                    // Intentamos generar el contenido
                    aiResult = await model.generateContent(promptForense);
                    
                    // Si llegamos aquí, el modelo funcionó. Guardamos y salimos del bucle.
                    console.log(`[Gemini AI] Análisis exitoso usando el modelo: ${nombreModelo}`);
                    veredictoIA = aiResult.response.text();
                    break; 

                } catch (aiError) {
                    console.warn(`[Gemini AI] El modelo ${nombreModelo} falló o está saturado (${aiError.message}). Intentando con el siguiente...`);
                }
            }

            // Si el bucle terminó y aiResult sigue siendo null, significa que los 3 modelos fallaron
            if (!aiResult) {
                console.error('[Gemini AI] Caída total: Todos los modelos de la cadena de rescate fallaron.');
                veredictoIA = '⚠️ *¡Hmph! Todos mis circuitos de análisis están saturados en este momento. Tendrás que leer los datos técnicos por ti mismo abajo.*';
            }
            // ───────────────────────────────────────────────────────────────────

            // ── 5. Título y colores ────────────────────────────────────────
            let titulo;
            if (reporte.detectado) titulo = `🚨 Amenaza Confirmada — Nivel ${scoreCompuesto?.nivel ?? reporte.nivel}`;
            else if ((scoreCompuesto?.score ?? 0) >= 25) titulo = `⚠️ Alerta Preventiva — Revisar con precaución`;
            else titulo = `✅ Sin Amenazas Detectadas`;

            const colores = { CRÍTICO: '#ED4245', ALTO: '#FFA500', MEDIO: '#FEE75C', BAJO: '#57F287' };
            const nivelKey = scoreCompuesto?.nivel ?? reporte.nivel ?? 'BAJO';

            const urlIdVT = Buffer.from(reporte.cleanUrl).toString('base64').replace(/=/g, '');
            const urlVT   = `https://www.virustotal.com/gui/url/${urlIdVT}`;

            let textoHaus;
            if (!resHaus) textoHaus = '⚪ Sin consulta (error de red)';
            else if (resHaus.query_status === 'ok' && resHaus.url_status === 'online') textoHaus = '🚨 **Malware activo** en URLhaus';
            else if (resHaus.query_status === 'ok' && resHaus.url_status) textoHaus = `⚠️ Registrado (${resHaus.url_status})`;
            else textoHaus = '✅ No encontrado en URLhaus';

            const textoRuta = ruta.length > 1
                ? ruta.map(r => `↪️ \`${new URL(r).hostname}\``).join('\n')
                : '↪️ Sin redirecciones detectadas';

            const alertasExtra = [];
            if (tieneExtension) alertasExtra.push(`📎 Apunta a un archivo ejecutable: \`${urlObj.pathname.split('/').pop()}\``);
            if (esServicioNube) alertasExtra.push('📦 Usa un servicio de almacenamiento o acortador externo');

            // ── 6. Construir embed ────────────────────────────────────────
            const embed = new EmbedBuilder()
                .setTitle(titulo)
                .setURL(visual?.reporte ?? urlVT)
                .setColor(colores[nivelKey] ?? '#57F287')
                .addFields(
                    // 🌟 AQUÍ COLOCAMOS EL VEREDICTO DE VITA COMO LO MÁS IMPORTANTE
                    {
                        name: '🧠 Veredicto de Vita (IA)',
                        value: veredictoIA,
                        inline: false
                    },
                    // Los datos duros por si algún moderador humano quiere verificar
                    {
                        name: '🛑 Google Safe Browsing',
                        value: esPhishingGoogle ? '🚨 Phishing' : '✅ Limpio',
                        inline: true
                    },
                    {
                        name: '🛡️ VirusTotal',
                        value: textoVirusTotal(statsVT),
                        inline: true
                    },
                    {
                        name: '📊 IPQS',
                        value: textoIPQS(resIPQS),
                        inline: true
                    },
                    {
                        name: '🦠 URLhaus',
                        value: textoHaus,
                        inline: true
                    },
                    {
                        name: '📸 urlscan.io',
                        value: visual ? `[Ver captura](${visual.reporte})` : '⚪ Sin captura',
                        inline: true
                    },
                    ...(alertasExtra.length > 0 ? [{
                        name: '⚠️ Notas Adicionales',
                        value: alertasExtra.join('\n'),
                        inline: false
                    }] : []),
                    {
                        name: '🛤️ Redirecciones',
                        value: textoRuta,
                        inline: false
                    }
                )
                .setFooter({ text: `Graf Eisen Shield v8.0 + Cerebro IA` })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Analizar Error]:', error.message);
            await interaction.editReply('❌ ¡Hmph! Algo rompió mi cadena de análisis. Intenta de nuevo en unos segundos.');
        }
    },
};