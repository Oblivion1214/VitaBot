const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { useMainPlayer } = require('discord-player');
const { log } = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Detiene la música y desconecta al bot del canal'),

    async execute(interaction) {
        const { useMainPlayer } = require('discord-player');
        const player = useMainPlayer();
        const queue = player.nodes.get(interaction.guildId);
        const botChannel = interaction.guild.members.me.voice.channelId;

        if (botChannel && interaction.member.voice.channelId !== botChannel) {
            return interaction.reply({ content: "⚠️ **Acceso denegado.**", flags: MessageFlags.Ephemeral });
        }

        if (queue && queue.isPlaying()) {
            queue.delete();
            return interaction.reply('🛑 Música detenida. Motor de la VM apagado.');
        } else if (botChannel) {
            await fetch(`http://100.127.221.32:3000/api/control?action=stop`).catch(()=>null);
            return interaction.reply('🛑 Música detenida. Músculo PC desconectado.');
        } else {
            return interaction.reply({ content: '❌ No hay música activa.', flags: MessageFlags.Ephemeral });
        }
    }

};