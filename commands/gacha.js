const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { log } = require('../utils/logger');

const personajes = require('../personajes.json');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('gacha')
        .setDescription('Realiza una tirada para obtener un personaje aleatorio'),
        
    async execute(interaction) {
        const tirada = Math.random() * 100;
        let rarezaObtenida = '';

        if (tirada <= 10) {
            rarezaObtenida = 'Legendario';
        } else if (tirada <= 40) {
            rarezaObtenida = 'Raro';
        } else {
            rarezaObtenida = 'Común';
        }

        const personajesPosibles = personajes.filter(p => p.rareza === rarezaObtenida);
        
        if (personajesPosibles.length === 0) {
            return interaction.reply({ 
                content: `⚠️ Ups, tiraste y sacaste rareza **${rarezaObtenida}**, pero aún no hay personajes de esa categoría en la base de datos.`, 
                flags: MessageFlags.Ephemeral 
            });
        }
        
        const personajeGanado = personajesPosibles[Math.floor(Math.random() * personajesPosibles.length)];

        const embed = new EmbedBuilder()
            .setTitle(`¡Has obtenido a ${personajeGanado.nombre}!`)
            .setDescription(`**Franquicia:** ${personajeGanado.franquicia}\n**Rareza:** ${personajeGanado.estrellas}`)
            .setColor(personajeGanado.color)
            .setFooter({ text: `Tirada realizada por ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

        await log(interaction.guild, {
            categoria: 'general',
            titulo: 'Tirada de Gacha realizada',
            descripcion: `Un usuario realizó una tirada de gacha.`,
            campos: [
                { name: '🎰 Rareza obtenida', value: rarezaObtenida, inline: true },
                { name: '🎭 Personaje', value: personajeGanado.nombre, inline: true },
                { name: '📺 Franquicia', value: personajeGanado.franquicia, inline: true },
            ],
            usuario: interaction.user,
        });

        await interaction.reply({ embeds: [embed] });
    },
};