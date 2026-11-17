const { EmbedBuilder, escapeMarkdown } = require('discord.js');

function crearSolicitud(interaction, titulo, texto) {
    const { user, member } = interaction;
    return new EmbedBuilder()
        .setAuthor({ name: member?.displayName ?? user.displayName, iconURL: user.displayAvatarURL() })
        .setTitle(titulo)
        .setDescription(escapeMarkdown(texto, { maskedLink: true }))
        .setColor('#C62828');
}

module.exports = { crearSolicitud };
