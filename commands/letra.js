const { SlashCommandBuilder } = require('discord.js');
const { obtenerSesionActiva, responderError, mostrarLetra } = require('../utils/interfazMusica');
module.exports = {
    data: new SlashCommandBuilder().setName('letra').setDescription('Busca la letra de la canción actual.'),
    async execute(interaction) {
        try { return await mostrarLetra(interaction, obtenerSesionActiva(interaction).current?.track); }
        catch (error) { return responderError(interaction, error); }
    },
};
