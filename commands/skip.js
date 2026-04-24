const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('skip')
        .setDescription('Salta la canción actual y pasa a la siguiente.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);
        const botChannel = interaction.guild.members.me.voice.channelId;

        if (botChannel && interaction.member.voice.channelId !== botChannel) {
            return interaction.reply({ content: "⚠️ **Acceso denegado.**", flags: MessageFlags.Ephemeral });
        }

        if (queue && queue.isPlaying()) {
            const trackSaltada = queue.currentTrack;
            queue.node.skip();
            return interaction.reply({ content: `⏭️ Se ha saltado: **${trackSaltada.title}** (VM)` });
        } else if (botChannel) {
            await fetch(`http://100.127.221.32:3000/api/control?action=skip`).catch(()=>null);
            return interaction.reply({ content: `⏭️ Canción saltada. *(Aviso: El motor PC no tiene sistema de colas integrado, la reproducción ha finalizado).*` });
        } else {
            return interaction.reply({ content: '❌ No hay música para saltar.', flags: MessageFlags.Ephemeral });
        }
    }

};