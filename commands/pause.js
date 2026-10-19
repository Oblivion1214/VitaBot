const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { obtenerSesionActiva, responderError } = require('../utils/interfazMusica');
module.exports = {
    data: new SlashCommandBuilder().setName('pause').setDescription('Pausa o reanuda el audio.'),
    async execute(interaction) {
        try {
            const session = obtenerSesionActiva(interaction);
            return await interaction.reply({ content: session.pause() ? '⏸️ Música pausada.' : '▶️ Música reanudada.', flags: MessageFlags.Ephemeral });
        } catch (error) { return responderError(interaction, error); }
    },
};
