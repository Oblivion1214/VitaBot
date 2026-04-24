const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('pause')
        .setDescription('Pausa o reanuda la reproducción actual.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);
        const botChannel = interaction.guild.members.me.voice.channelId;

        // Validar que el usuario esté en el canal
        if (botChannel && interaction.member.voice.channelId !== botChannel) {
            return interaction.reply({ content: "⚠️ **Acceso denegado:** Debes estar en el mismo canal.", flags: MessageFlags.Ephemeral });
        }

        if (queue && queue.isPlaying()) {
            // MODO VM
            const estadoActual = queue.node.isPaused();
            queue.node.setPaused(!estadoActual);
            return interaction.reply({ content: !estadoActual ? '⏸️ Música **pausada** (VM).' : '▶️ Música **reanudada** (VM).' });
        } else if (botChannel) {
            // MODO PC
            try {
                const status = await fetch(`http://100.127.221.32:3000/api/control?action=status`).then(r => r.json());
                if (status.error) return interaction.reply({ content: '❌ No hay música activa.', flags: MessageFlags.Ephemeral });
                
                const action = status.isPaused ? 'resume' : 'pause';
                await fetch(`http://100.127.221.32:3000/api/control?action=${action}`);
                return interaction.reply({ content: status.isPaused ? '▶️ Música **reanudada** (Músculo PC).' : '⏸️ Música **pausada** (Músculo PC).' });
            } catch {
                return interaction.reply('❌ Fallo de conexión con la PC local.');
            }
        } else {
            return interaction.reply({ content: '❌ No hay música activa.', flags: MessageFlags.Ephemeral });
        }
    }

};