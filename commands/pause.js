const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pausa o reanuda la reproducción actual.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);

        if (!queue || !queue.isPlaying()) {
            return interaction.reply({ 
                content: '❌ No hay música activa para pausar.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        // VALIDACIÓN: Mismo canal de voz
        const botChannel = interaction.guild.members.me.voice.channelId;
        if (botChannel && interaction.member.voice.channelId !== botChannel) {
            return interaction.reply({ 
                content: "⚠️ **Acceso denegado:** Debes estar en el mismo canal para controlar la pausa.", 
                flags: MessageFlags.Ephemeral 
            });
        }

        const estadoActual = queue.node.isPaused();
        queue.node.setPaused(!estadoActual);

        return interaction.reply({ 
            content: !estadoActual ? '⏸️ Música **pausada**.' : '▶️ Música **reanudada**.' 
        });
    },
};