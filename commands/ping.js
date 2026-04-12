const { SlashCommandBuilder } = require('discord.js');
const { log } = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('ping')
        .setDescription('Comprueba la velocidad de respuesta de VitaBot'),
        
    async execute(interaction) {
        await interaction.reply('Calculando...');
        const sent = await interaction.fetchReply();
        const latencia = sent.createdTimestamp - interaction.createdTimestamp;

        await log(interaction.guild, {
            categoria: 'general',
            titulo: 'Ping ejecutado',
            descripcion: `Se comprobó la latencia del bot.`,
            campos: [
                { name: '🏓 Latencia', value: `${latencia}ms`, inline: true },
            ],
            usuario: interaction.user,
        });

        await interaction.editReply(`🏓 ¡Pong! La latencia es de ${latencia}ms.`);
    },
};