const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { obtenerCanalVoz, responderError } = require('../utils/interfazMusica');
module.exports = {
    data: new SlashCommandBuilder().setName('decir').setDescription('Haz que Vita pronuncie un mensaje en el canal de voz.')
        .addStringOption(option => option.setName('mensaje').setDescription('Mensaje de hasta 200 caracteres').setRequired(true).setMaxLength(200)),
    async execute(interaction) {
        try {
            const channel = obtenerCanalVoz(interaction);
            await interaction.deferReply({ flags: MessageFlags.Ephemeral });
            await interaction.client.music.speak(channel, interaction.channel, interaction.options.getString('mensaje'));
            return await interaction.editReply('📢 Mensaje de voz terminado.');
        } catch (error) { return responderError(interaction, error); }
    },
};
