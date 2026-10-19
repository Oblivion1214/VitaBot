const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { obtenerSesionActiva, responderError, crearMensajeCola } = require('../utils/interfazMusica');
module.exports = {
    data: new SlashCommandBuilder().setName('queue').setDescription('Muestra las canciones pendientes.'),
    async execute(interaction) {
        try { return await interaction.reply({ ...crearMensajeCola(obtenerSesionActiva(interaction)), flags: MessageFlags.Ephemeral }); }
        catch (error) { return responderError(interaction, error); }
    },
};
