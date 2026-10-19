const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { obtenerSesionActiva, responderError } = require('../utils/interfazMusica');
module.exports = {
    data: new SlashCommandBuilder().setName('skip').setDescription('Salta a la siguiente pista.'),
    async execute(interaction) {
        try {
            const session = obtenerSesionActiva(interaction);
            return await interaction.reply({ content: (session.skip(), '⏭️ Pista omitida.'), flags: MessageFlags.Ephemeral });
        } catch (error) { return responderError(interaction, error); }
    },
};
