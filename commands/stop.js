const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { obtenerSesionActiva, responderError } = require('../utils/interfazMusica');
module.exports = {
    data: new SlashCommandBuilder().setName('stop').setDescription('Detiene el audio y vacía la cola.'),
    async execute(interaction) {
        try {
            const session = obtenerSesionActiva(interaction);
            return await interaction.reply({ content: (session.stop(), '⏹️ Sesión terminada y cola vacía.'), flags: MessageFlags.Ephemeral });
        } catch (error) { return responderError(interaction, error); }
    },
};
