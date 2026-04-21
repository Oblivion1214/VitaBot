// commands/analizar.js — Reporte Forense Belka v8.0
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { dominiosSeguros, escanearEnlace, textoVirusTotal, textoIPQS } = require('../utils/linkGuard');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('analizar')
        .setDescription('Escaneo de seguridad: URLhaus + Google Safe Browsing + VirusTotal + IPQS.')
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
                content: '❌ URL malformada. Incluye el protocolo completo (ej: `https://ejemplo.com`).',
                flags: MessageFlags.Ephemeral
            });
        }

        // ── 2. Whitelist ───────────────────────────────────────────────────
        const hostname = urlObj.hostname.replace('www.', '');
        if (dominiosSeguros.some(d => hostname.endsWith(d))) {
            return interaction.reply({
                content: `✅ **${hostname}** está en la lista de dominios de confianza. No requiere análisis.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            // ── 3. Ejecutar análisis ───────────────────────────────────────
            const reporte = await escanearEnlace(url);
            const { visual, ruta, resultados } = reporte;
            const { statsVT, resIPQS, esPhishingGoogle, resHaus, scoreCompuesto, esServicioNube, tieneExtension } = resultados;

            // ── 4. Título dinámico según resultado ─────────────────────────
            let titulo;
            if (reporte.detectado) {
                titulo = `🚨 Amenaza Confirmada — ${scoreCompuesto?.nivel ?? reporte.nivel}`;
            } else if ((scoreCompuesto?.score ?? 0) >= 25) {
                titulo = `⚠️ Alerta Preventiva — Revisar con precaución`;
            } else {
                titulo = `✅ Sin Amenazas Detectadas`;
            }

            // ── 5. Color según nivel ───────────────────────────────────────
            const colores = { CRÍTICO: '#ED4245', ALTO: '#FFA500', MEDIO: '#FEE75C', BAJO: '#57F287' };
            const nivelKey = scoreCompuesto?.nivel ?? reporte.nivel ?? 'BAJO';

            // ID de VirusTotal para link directo
            const urlIdVT = Buffer.from(reporte.cleanUrl).toString('base64').replace(/=/g, '');
            const urlVT   = `https://www.virustotal.com/gui/url/${urlIdVT}`;

            // ── 7. Texto de URLhaus (maneja todos los estados posibles) ───
            let textoHaus;
            if (!resHaus) {
                textoHaus = '⚪ Sin consulta (error de red)';
            } else if (resHaus.query_status === 'ok' && resHaus.url_status === 'online') {
                textoHaus = '🚨 **Malware activo** en URLhaus';
            } else if (resHaus.query_status === 'ok' && resHaus.url_status) {
                textoHaus = `⚠️ Registrado (${resHaus.url_status})`;
            } else {
                // query_status === 'no_results' o cualquier otro valor = no encontrado
                textoHaus = '✅ No encontrado en URLhaus';
            }

            // ── 8. Texto de ruta ───────────────────────────────────────────
            // Si la URL no redirige a ningún lado, decirlo explícitamente
            const textoRuta = ruta.length > 1
                ? ruta.map(r => `↪️ \`${new URL(r).hostname}\``).join('\n')
                : '↪️ Sin redirecciones detectadas';

            // ── 9. Alertas heurísticas (solo informativas, no = amenaza) ──
            const alertasExtra = [];
            if (tieneExtension) alertasExtra.push(`📎 Apunta a un archivo ejecutable: \`${urlObj.pathname.split('/').pop()}\``);
            if (esServicioNube) alertasExtra.push('📦 Usa un servicio de almacenamiento o acortador externo');

            // ── 10. Construir embed ────────────────────────────────────────
            // ⚠️ Se eliminó setThumbnail: las URLs de flaticon.com bloquean hotlinking
            //    y muestran una imagen rota. El color del embed ya comunica el nivel.
            const embed = new EmbedBuilder()
                .setTitle(titulo)
                .setURL(visual?.reporte ?? urlVT)
                .setColor(colores[nivelKey] ?? '#57F287')
                .addFields(
                    // Veredicto unificado — explica el score Y las fuentes que lo causaron
                    {
                        name:   '📊 Veredicto de Riesgo',
                        value:  scoreCompuesto
                            ? `${scoreCompuesto.emoji} **${scoreCompuesto.score}/100** — Nivel **${scoreCompuesto.nivel}**\n${scoreCompuesto.contexto}`
                            : '⚪ No calculado',
                        inline: false
                    },
                    // Las 3 fuentes en una fila — datos crudos para quien quiera verificar
                    {
                        name:   '🛑 Google Safe Browsing',
                        value:  esPhishingGoogle ? '🚨 Phishing' : '✅ Limpio',
                        inline: true
                    },
                    {
                        name:   '🛡️ VirusTotal',
                        value:  textoVirusTotal(statsVT),
                        inline: true
                    },
                    {
                        name:   '📊 IPQS',
                        value:  textoIPQS(resIPQS),
                        inline: true
                    },
                    // URLhaus + urlscan en segunda fila
                    {
                        name:   '🦠 URLhaus',
                        value:  textoHaus,
                        inline: true
                    },
                    {
                        name:   '📸 urlscan.io',
                        value:  visual ? `[Ver captura](${visual.reporte})` : '⚪ Sin captura',
                        inline: true
                    },
                    // Alertas heurísticas solo si aplica
                    ...(alertasExtra.length > 0 ? [{
                        name:   '⚠️ Notas Adicionales',
                        value:  alertasExtra.join('\n'),
                        inline: false
                    }] : []),
                    // Ruta + URL al final
                    {
                        name:   '🛤️ Redirecciones',
                        value:  textoRuta,
                        inline: false
                    },
                    {
                        name:   '🔗 URL Analizada',
                        value:  `\`${reporte.cleanUrl.substring(0, 1000)}\``,
                        inline: false
                    }
                )
                .setFooter({ text: `Graf Eisen Shield v8.0  •  Ver reporte completo` })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Analizar Error]:', error.message);
            await interaction.editReply('❌ Fallo en la cadena de análisis. Intenta de nuevo en unos segundos.');
        }
    },
};