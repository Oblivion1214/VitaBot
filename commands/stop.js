const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { useMainPlayer } = require('discord-player');
const { log } = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('stop')
        .setDescription('Detiene la música y desconecta al bot del canal'),

    async execute(interaction) {
        const player = useMainPlayer();
        const queue = player.nodes.get(interaction.guildId);

        if (!queue || !queue.isPlaying()) {
            return interaction.reply({
                content: '❌ No estoy reproduciendo nada en este momento.',
                flags: MessageFlags.Ephemeral
            });
        }

        // VALIDACIÓN: Mismo canal de voz
        const botChannel = interaction.guild.members.me.voice.channelId;
        if (botChannel && interaction.member.voice.channelId !== botChannel) {
            return interaction.reply({ 
                content: "⚠️ **Acceso denegado:** No puedes apagar los sistemas de audio desde otro canal.", 
                flags: MessageFlags.Ephemeral 
            });
        }

        const trackActual = queue.currentTrack;
        queue.delete();

        await log(interaction.guild, {
            categoria: 'musica',
            titulo: 'Reproducción detenida',
            descripcion: `La reproducción fue detenida y el bot se desconectó del canal de voz.`,
            campos: trackActual ? [
                { name: '🎵 Última canción', value: trackActual.title, inline: true },
            ] : [],
            usuario: interaction.user,
        });

        await interaction.reply('🛑 Música detenida. Mis sistemas de audio han sido apagados.');
    },
};