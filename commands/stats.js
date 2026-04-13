const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const os = require('os');
const osu = require('os-utils');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stats')
        .setDescription('Muestra el estado técnico de VitaBot y el servidor.'),

    async execute(interaction) {
        // Obtenemos datos del bot y del sistema
        const uptimeBot = process.uptime();
        const memBot = process.memoryUsage().heapUsed / 1024 / 1024; // MB
        const memTotal = os.totalmem() / 1024 / 1024 / 1024; // GB
        const memLibre = os.freemem() / 1024 / 1024 / 1024; // GB
        const memUso = memTotal - memLibre;

        // Función para formatear el tiempo
        const formatUptime = (seconds) => {
            const d = Math.floor(seconds / (3600 * 24));
            const h = Math.floor(seconds % (3600 * 24) / 3600);
            const m = Math.floor(seconds % 3600 / 60);
            return `${d}d ${h}h ${m}m`;
        };

        // Medición de CPU (toma un segundo para ser precisa)
        osu.cpuUsage(async (v) => {
            const cpuUso = (v * 100).toFixed(2);

            const embed = new EmbedBuilder()
                .setTitle('📊 Estado de los Sistemas - VitaBot')
                .setThumbnail(interaction.client.user.displayAvatarURL())
                .setColor('#FF9900')
                .addFields(
                    { name: '🖥️ Servidor', value: `\`\`\`OS: ${os.platform()} ${os.release()}\nArquitectura: ${os.arch()}\`\`\``, inline: false },
                    { name: '⚙️ CPU', value: `\`${cpuUso}%\` de uso`, inline: true },
                    { name: '💾 RAM del Sistema', value: `\`${memUso.toFixed(2)}GB / ${memTotal.toFixed(1)}GB\``, inline: true },
                    { name: '🤖 RAM de VitaBot', value: `\`${memBot.toFixed(2)} MB\``, inline: true },
                    { name: '⏱️ Uptime del Bot', value: `\`${formatUptime(uptimeBot)}\``, inline: true },
                    { name: '📡 Latencia', value: `\`${interaction.client.ws.ping}ms\``, inline: true },
                    { name: '📦 Versiones', value: `\`Node: ${process.version}\`\n\`Discord.js: v14.x\``, inline: true }
                )
                .setFooter({ text: `Consultado por: ${interaction.user.tag} 🔨` })
                .setTimestamp();

            return interaction.reply({ embeds: [embed], flags: MessageFlags.Ephemeral });
        });
    },
};