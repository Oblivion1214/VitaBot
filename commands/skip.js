const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Salta la canción actual y pasa a la siguiente.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);

        if (!queue || !queue.isPlaying()) {
            return interaction.reply({ 
                content: '❌ No hay ninguna canción sonando para saltar.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        // VALIDACIÓN: Mismo canal de voz
        const botChannel = interaction.guild.members.me.voice.channelId;
        if (botChannel && interaction.member.voice.channelId !== botChannel) {
            return interaction.reply({ 
                content: "⚠️ **Acceso denegado:** Debes estar en el mismo canal de voz que Graf Eisen para saltar canciones.", 
                flags: MessageFlags.Ephemeral 
            });
        }

        const trackSaltada = queue.currentTrack;
        queue.node.skip();

        return interaction.reply({ 
            content: `⏭️ Se ha saltado: **${trackSaltada.title}**` 
        });
    },
};