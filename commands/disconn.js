const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { obtenerSesionActiva, responderError } = require('../utils/interfazMusica');
module.exports = {
    data: new SlashCommandBuilder().setName('disconn').setDescription('Desconecta a Vita y limpia la cola.'),
    async execute(interaction) {
        try {
            const session = obtenerSesionActiva(interaction);
            return await interaction.reply({ content: (session.stop(), '👋 Desconectada del canal de voz.'), flags: MessageFlags.Ephemeral });
        } catch (error) { return responderError(interaction, error); }
    },
};
