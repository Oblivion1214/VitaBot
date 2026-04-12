const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { log } = require('../utils/logger');
const fs = require('fs');
const path = require('path');

// Definimos la ruta del archivo
const RUTA_PERSONAJES = path.join(__dirname, '../personajes.json');

module.exports = {
    cooldown: 10, // Cooldown de seguridad aumentado
    data: new SlashCommandBuilder()
        .setName('gacha')
        .setDescription('Realiza una tirada para obtener un personaje aleatorio'),
        
    async execute(interaction) {
        let personajes;
        
        // SEGURIDAD: Intentamos leer el archivo en cada ejecución para evitar datos en caché
        try {
            const data = fs.readFileSync(RUTA_PERSONAJES, 'utf-8');
            personajes = JSON.parse(data);
        } catch (error) {
            console.error('[Gacha Error]: No se pudo acceder a la base de datos.');
            return interaction.reply({ 
                content: '❌ Error: La base de datos de personajes no está disponible en el servidor.', 
                flags: MessageFlags.Ephemeral 
            });
        }

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
                content: `⚠️ Ups, tiraste y sacaste rareza **${rarezaObtenida}**, pero no hay personajes cargados.`, 
                flags: MessageFlags.Ephemeral 
            });
        }
        
        const personajeGanado = personajesPosibles[Math.floor(Math.random() * personajesPosibles.length)];

        const embed = new EmbedBuilder()
            .setTitle(`¡Has obtenido a ${personajeGanado.nombre}!`)
            .setDescription(`**Franquicia:** ${personajeGanado.franquicia}\n**Rareza:** ${personajeGanado.estrellas}`)
            .setColor(personajeGanado.color || '#FFFFFF')
            .setFooter({ text: `Tirada de ${interaction.user.username}`, iconURL: interaction.user.displayAvatarURL() });

        await log(interaction.guild, {
            categoria: 'general',
            titulo: 'Tirada de Gacha',
            descripcion: `${interaction.user.tag} obtuvo a ${personajeGanado.nombre}.`,
            usuario: interaction.user,
        });

        await interaction.reply({ embeds: [embed] });
    },
};