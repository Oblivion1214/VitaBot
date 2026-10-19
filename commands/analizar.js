const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { escanearEnlace, textoVirusTotal, textoIPQS } = require('../utils/linkGuard');
const { gemini } = require('../utils/servicioGemini');
const { interpretarUrlPublica } = require('../utils/urlPublica');
function coverageText(state) {
    return { sin_configurar: '⚪ Proveedor no configurado', error: '⚠️ Consulta fallida', sin_analisis: '⚪ Sin análisis registrado', limitado: '⏳ Límite local de consultas' }[state];
}
module.exports = {
    data: new SlashCommandBuilder().setName('analizar').setDescription('Consulta la reputación de un enlace y la cobertura de cada proveedor')
        .addStringOption(option => option.setName('url').setDescription('URL HTTP(S) pública').setRequired(true).setMaxLength(4096)),
    async execute(interaction) {
        const input = interaction.options.getString('url');
        try { interpretarUrlPublica(input); }
        catch { return interaction.reply({ content: 'Solo puedo analizar URLs HTTP(S) públicas, sin credenciales y con puerto estándar.', flags: MessageFlags.Ephemeral }); }
        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        try {
            const scope = interaction.guildId || 'dm:' + interaction.user.id;
            const report = await escanearEnlace(input, { scope });
            const { cobertura = {}, statsVT, resIPQS, esPhishingGoogle, resHaus, scoreCompuesto, tieneExtension, esServicioNube } = report.resultados;
            const consulted = Object.values(cobertura).filter(state => state === 'consultado').length;
            const complete = consulted === 4;
            const indicators = report.score > 0 || (statsVT?.malicious || 0) > 0 || (statsVT?.suspicious || 0) > 0 || resIPQS?.suspicious;
            let verdict = report.detectado ? '🔨 Hay detecciones confirmadas. ' + report.motivo
                : indicators ? 'Hay indicadores para revisar, sin confirmación suficiente para cuarentena.'
                    : 'No hay detecciones confirmadas. Esto no garantiza que el enlace sea seguro.';
            if (!complete) verdict += ' Cobertura incompleta: ' + consulted + '/4 proveedores consultados.';
            if (gemini.configured('analysis')) {
                try {
                    const result = await gemini.generate({ kind: 'analysis', scope, contents: JSON.stringify({
                        dominio: new URL(report.cleanUrl).hostname,
                        rutaDeDominios: report.ruta.map(url => new URL(url).hostname),
                        deteccionConfirmada: report.detectado, score: report.score, cobertura,
                        archivoEjecutable: tieneExtension, almacenamientoExterno: esServicioNube,
                        virusTotal: statsVT || null, ipqs: resIPQS ? { riesgo: resIPQS.risk_score, phishing: resIPQS.phishing, malware: resIPQS.malware } : null,
                        google: esPhishingGoogle, urlhaus: resHaus?.url_status || null,
                    }) });
                    if (result.status === 'ok') verdict += '\n\n' + result.text;
                } catch { /* The deterministic report remains available when language generation is busy. */ }
            }
            const title = report.detectado ? '🚨 Amenaza detectada' : !complete ? '⚪ Análisis incompleto'
                : indicators ? '⚠️ Indicadores para revisar' : 'Sin detecciones en los proveedores consultados';
            const embed = new EmbedBuilder().setTitle(title).setColor(report.detectado ? '#ED4245' : complete ? '#57F287' : '#FEE75C')
                .addFields(
                    { name: 'Lectura de Vita', value: verdict.slice(0, 1024).toWellFormed() },
                    { name: 'Google Safe Browsing', value: coverageText(cobertura.google) || (esPhishingGoogle ? '🚨 Amenaza detectada' : 'Sin detección'), inline: true },
                    { name: 'VirusTotal', value: coverageText(cobertura.virustotal) || textoVirusTotal(statsVT), inline: true },
                    { name: 'IPQS', value: coverageText(cobertura.ipqs) || textoIPQS(resIPQS), inline: true },
                    { name: 'URLhaus', value: coverageText(cobertura.urlhaus) || (resHaus?.url_status === 'online' ? '🚨 Malware activo' : 'Sin detección'), inline: true },
                    { name: 'Indicadores', value: (tieneExtension ? 'Archivo ejecutable. ' : '') + (esServicioNube ? 'Almacenamiento externo. ' : '') + 'Riesgo: ' + (scoreCompuesto?.score || 0) + '/100', inline: false },
                    { name: 'Redirecciones', value: report.ruta.map(url => new URL(url).hostname).join(' → ').slice(0, 1024), inline: false }
                ).setFooter({ text: 'Un resultado sin detecciones no garantiza seguridad. Las consultas fallidas o ausentes se muestran explícitamente.' }).setTimestamp();
            await interaction.editReply({ embeds: [embed], allowedMentions: { parse: [] } });
        } catch {
            await interaction.editReply('El analizador está ocupado o el destino no está permitido. Intenta de nuevo más tarde.');
        }
    },
};
module.exports.coverageText = coverageText;
