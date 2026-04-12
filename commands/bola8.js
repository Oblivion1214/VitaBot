const { SlashCommandBuilder, EmbedBuilder } = require('discord.js');
const { log } = require('../utils/logger');

const respuestas = [
    "Es cierto.", "Definitivamente.", "Sin duda.", "Sí, absolutamente.", "Puedes contar con ello.",
    "Como yo lo veo, sí.", "Lo más probable.", "Se ve bien.", "Sí.", "Las señales apuntan a que sí.",
    "Respuesta confusa, intenta otra vez.", "Pregunta de nuevo más tarde.", "Mejor no decirte ahora.", "No se puede predecir ahora.", "Concéntrate y pregunta de nuevo.",
    "No cuentes con ello.", "Mi respuesta es no.", "Mis fuentes dicen que no.", "Se ve muy mal.", "Muy dudoso."
];

module.exports = {
    cooldown: 3,
    data: new SlashCommandBuilder()
        .setName('bola8')
        .setDescription('Hazle una pregunta a la misteriosa Bola 8 Mágica')
        .addStringOption(option => 
            option.setName('pregunta')
            .setDescription('Lo que quieres preguntarle a la bola mágica')
            .setRequired(true)
        ),

    async execute(interaction) {
        const preguntaUsuario = interaction.options.getString('pregunta');
        const respuestaMistica = respuestas[Math.floor(Math.random() * respuestas.length)];

        const embed = new EmbedBuilder()
            .setTitle('🎱 La Bola 8 Mágica ha hablado...')
            .setColor('#2b2d31')
            .addFields(
                { name: '❓ Pregunta', value: preguntaUsuario },
                { name: '🔮 Respuesta', value: `**${respuestaMistica}**` }
            )
            .setFooter({ 
                text: `Consultado por ${interaction.user.username}`, 
                iconURL: interaction.user.displayAvatarURL() 
            });

        await log(interaction.guild, {
            categoria: 'general',
            titulo: 'Bola 8 consultada',
            descripcion: `Un usuario consultó la Bola 8 Mágica.`,
            campos: [
                { name: '❓ Pregunta', value: preguntaUsuario.substring(0, 1024), inline: false },
                { name: '🔮 Respuesta', value: respuestaMistica, inline: true },
            ],
            usuario: interaction.user,
        });

        await interaction.reply({ embeds: [embed] });
    },
};