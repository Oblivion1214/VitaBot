const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder } = require('discord.js');
const { imagenes } = require('../utils/servicioImagenes');
module.exports = {
    cooldown: 20,
    data: new SlashCommandBuilder().setName('imagine').setDescription('Genera una imagen con Vita')
        .addStringOption(option => option.setName('prompt').setDescription('Describe la imagen').setRequired(true).setMinLength(1).setMaxLength(1000)),
    async execute(interaction) {
        await interaction.deferReply();
        try {
            const { blob } = await imagenes.generate(interaction.options.getString('prompt'), interaction.guildId || 'dm:' + interaction.user.id);
            const extension = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp' }[blob.type];
            const name = 'vita-art.' + extension;
            const attachment = new AttachmentBuilder(Buffer.from(await blob.arrayBuffer()), { name });
            const embed = new EmbedBuilder().setTitle('🎨 Obra de Vita').setImage('attachment://' + name).setColor('#FF9900');
            await interaction.editReply({ embeds: [embed], files: [attachment], allowedMentions: { parse: [] } });
        } catch {
            await interaction.editReply('Ahora no puedo generar esa imagen. El servicio está ocupado o no está disponible; intenta de nuevo más tarde.');
        }
    },
};
