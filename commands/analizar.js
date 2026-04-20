// commands/analizar.js — Reporte Forense Belka v7.0
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { dominiosSeguros, escanearEnlace } = require('../utils/linkGuard');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('analizar')
        .setDescription('Escaneo forense multinivel: URLhaus + Google + VirusTotal + IPQS + Visual.')
        .addStringOption(option =>
            option.setName('url')
                .setDescription('La URL o link sospechoso a examinar')
                .setRequired(true)
        ),

    async execute(interaction) {
        const url = interaction.options.getString('url');

        // ── 1. Validar formato de URL ──────────────────────────────────────
        let urlObj;
        try {
            urlObj = new URL(url);
        } catch {
            return interaction.reply({
                content: '❌ URL malformada. Asegúrate de que el enlace sea válido e incluya el protocolo (http/https).',
                flags: MessageFlags.Ephemeral
            });
        }

        // ── 2. Verificar Whitelist ─────────────────────────────────────────
        const hostname = urlObj.hostname.replace('www.', '');
        if (dominiosSeguros.some(d => hostname.endsWith(d))) {
            return interaction.reply({
                content: `✅ **${hostname}** es un dominio registrado en la Whitelist de confianza. No requiere análisis forense.`,
                flags: MessageFlags.Ephemeral
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            // ── 3. Ejecutar motor de análisis ──────────────────────────────
            const reporte = await escanearEnlace(url);
            const { visual, ruta, resultados } = reporte;
            const { statsVT, resIPQS, esPhishingGoogle, resHaus, scoreCompuesto } = resultados;

            // ID de VirusTotal para enlace directo al reporte
            const urlIdVT = Buffer.from(reporte.cleanUrl).toString('base64').replace(/=/g, '');
            const urlVT   = `https://www.virustotal.com/gui/url/${urlIdVT}`;

            // ── 4. Color e icono según nivel de riesgo ─────────────────────
            const colores = { CRÍTICO: '#ED4245', ALTO: '#FFA500', MEDIO: '#FEE75C', BAJO: '#57F287' };
            const iconos  = {
                CRÍTICO: 'https://cdn-icons-png.flaticon.com/512/753/753345.png',
                ALTO:    'https://cdn-icons-png.flaticon.com/512/1680/1680012.png',
                MEDIO:   'https://cdn-icons-png.flaticon.com/512/1303/1303847.png',
                BAJO:    'https://cdn-icons-png.flaticon.com/512/845/845646.png'
            };
            const nivelKey = reporte.nivel || 'BAJO';

            // ── 5. Construir embed forense ─────────────────────────────────
            const embed = new EmbedBuilder()
                .setTitle('🔬 Informe Forense de Seguridad Multinivel')
                .setURL(visual?.reporte ?? urlVT)
                .setColor(colores[nivelKey] ?? '#57F287')
                .setThumbnail(iconos[nivelKey] ?? iconos.BAJO)
                .addFields(
                    // Fila 1: Score compuesto — el veredicto más importante, ancho completo
                    {
                        name: '⚠️ Score de Riesgo Compuesto',
                        value: scoreCompuesto
                            ? `${scoreCompuesto.emoji} **${scoreCompuesto.score}/100** — Nivel: **${scoreCompuesto.nivel}**\n` +
                              `${reporte.detectado ? `🚩 Motivo: \`${reporte.motivo}\`` : '✅ Sin amenazas confirmadas por APIs'}\n\n` +
                              `${scoreCompuesto.contexto || ''}`
                            : '⚪ No calculado',
                        inline: false
                    },
                    // Fila 2: 3 fuentes principales en inline (alineadas en una sola fila)
                    {
                        name: '🛑 Google Safe Browsing',
                        value: esPhishingGoogle ? '🚨 Phishing/Engaño' : '✅ Limpio',
                        inline: true
                    },
                    {
                        name: '🛡️ VirusTotal',
                        value: statsVT
                            ? `🚨 Maliciosos: **${statsVT.malicious}**\n⚠️ Sospechosos: **${statsVT.suspicious}**`
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
                    // Fila 3: URLhaus + Visual (2 inline = fila limpia)
                    {
                        name: '🦠 URLhaus',
                        value: resHaus?.query_status === 'ok'
                            ? (resHaus.url_status === 'online' ? '🚨 Malware activo' : `⚠️ Registrado (${resHaus.url_status})`)
                            : '✅ No encontrado',
                        inline: true
                    },
                    {
                        name: '📸 urlscan.io',
                        value: visual ? `[Ver Captura Visual](${visual.reporte})` : '⚪ Sin datos',
                        inline: true
                    },
                    // Fila 4: Ruta de redirección (ancho completo)
                    {
                        name: '🛤️ Ruta de Redirección',
                        value: ruta.map(r => `↪️ \`${new URL(r).hostname}\``).join('\n') || '—',
                        inline: false
                    },
                    // Fila 5: URL limpia analizada (ancho completo)
                    {
                        name: '🔗 URL Analizada',
                        value: `\`${reporte.cleanUrl.substring(0, 1000)}\``,
                        inline: false
                    }
                )
                .setFooter({ text: 'Graf Eisen Shield — Protocolo Forense Activo v7.0' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Analizar Error]:', error.message);
            await interaction.editReply('❌ Se produjo un fallo crítico en la cadena de análisis forense.');
        }
    },
};