// commands/analizar.js — Reporte Forense Belka v6.0
const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { dominiosSeguros, escanearEnlace } = require('../utils/linkGuard');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('analizar')
        .setDescription('Realiza un escaneo forense multinivel (VT + Google + IPQS + Hybrid Analysis + Visual).')
        .addStringOption(option => 
            option.setName('url')
            .setDescription('La URL o link sospechoso a examinar')
            .setRequired(true)),

    async execute(interaction) {
        const url = interaction.options.getString('url');
        
        try {
            // 1. Verificación de Whitelist Refinada
            const urlObj = new URL(url);
            const hostname = urlObj.hostname.replace('www.', '');

            if (dominiosSeguros.some(dominio => hostname.endsWith(dominio))) {
                return interaction.reply({ 
                    content: `✅ **${hostname}** es un dominio de confianza registrado en la Whitelist. No requiere análisis forense.`, 
                    flags: MessageFlags.Ephemeral 
                });
            }
        } catch (e) {
            return interaction.reply({ 
                content: '❌ URL malformada. Asegúrate de que el enlace sea válido e incluya el protocolo (http/https).', 
                flags: MessageFlags.Ephemeral 
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            // 2. Ejecución del motor centralizado
            const reporte = await escanearEnlace(url);
            const { hibrido, visual, ruta, resultados } = reporte;
            const { statsVT, resIPQS, esPhishingGoogle } = resultados;

            // Generamos el ID de VirusTotal para el enlace final
            const urlIdVT = Buffer.from(reporte.cleanUrl).toString('base64').replace(/=/g, '');

            // 3. Construcción del Panel Forense
            const embed = new EmbedBuilder()
                .setTitle('🔬 Informe Forense de Seguridad Multinivel')
                .setURL(visual ? visual.reporte : `https://www.virustotal.com/gui/url/${urlIdVT}`)
                .setColor(reporte.detectado ? '#ED4245' : '#57F287')
                .setThumbnail(reporte.detectado 
                    ? 'https://cdn-icons-png.flaticon.com/512/753/753345.png' 
                    : 'https://cdn-icons-png.flaticon.com/512/845/845646.png')
                .addFields(
                    { name: '🛤️ Ruta de Redirección', value: ruta.map(r => `↪️ \`${new URL(r).hostname}\``).join('\n'), inline: false },
                    { name: '🔬 Hybrid Analysis', value: hibrido ? `**${hibrido.verdict.toUpperCase()}**` : '⚪ No disponible', inline: true },
                    { name: '🛑 Google Safe Browsing', value: esPhishingGoogle ? '🚨 Phishing' : '✅ Limpio', inline: true },
                    { name: '📸 urlscan.io (Visual)', value: visual ? `[Ver Captura](${visual.reporte})` : '⚪ Sin datos', inline: true },
                    { name: '🛡️ VirusTotal', value: statsVT ? `🚨 Maliciosos: ${statsVT.malicious}` : '⚪ Sin datos', inline: true },
                    { name: '📊 IPQualityScore', value: `🚩 Riesgo: ${resIPQS?.risk_score || 0}/100`, inline: true },
                    { name: '🔗 URL Desenmascarada', value: `\`${reporte.cleanUrl.substring(0, 1000)}\``, inline: false }
                )
                .setFooter({ text: 'Graf Eisen Shield — Protocolo Forense Activo v6.0' })
                .setTimestamp();

            await interaction.editReply({ embeds: [embed] });

        } catch (error) {
            console.error('[Analizar Error]:', error.message);
            await interaction.editReply('❌ Se produjo un fallo crítico en la cadena de análisis forense.');
        }
    },
};