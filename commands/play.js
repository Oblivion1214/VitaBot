const { SlashCommandBuilder, ActionRowBuilder, StringSelectMenuBuilder } = require('discord.js');
const { obtenerCanalVoz, responderError } = require('../utils/interfazMusica');
const { crearSolicitud } = require('../utils/interfazSolicitudes');
const { formatearDuracion, ErrorAudio } = require('../audio/protocolo');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder().setName('play').setDescription('Busca y añade música a la cola.')
        .addStringOption(option => option.setName('cancion').setDescription('Nombre, enlace de YouTube o canción de Spotify').setRequired(true).setMaxLength(500)),
    async execute(interaction) {
        const query = interaction.options.getString('cancion', true);
        const solicitud = { embeds: [crearSolicitud(interaction, '🎵 Solicitud de música', query)], allowedMentions: { parse: [] } };
        try {
            obtenerCanalVoz(interaction);
            await interaction.deferReply();
            const result = await interaction.client.music.resolve(query);
            if (!result.tracks.length) throw new ErrorAudio('No encontré canciones disponibles.', 404);
            if (!result.selection) {
                const channel = obtenerCanalVoz(interaction);
                interaction.client.music.enqueue(channel, interaction.channel, result.tracks, interaction.user.id);
                const content = result.tracks.length === 1 ? '✅ Canción añadida a la cola.' : `✅ Añadidas ${result.tracks.length} canciones a la cola.`;
                return await interaction.editReply({ ...solicitud, content });
            }
            const tracks = result.tracks.slice(0, 5);
            const menu = new StringSelectMenuBuilder().setCustomId('audio_selection').setPlaceholder('Elige una canción')
                .addOptions(tracks.map((track, index) => ({ label: track.title.slice(0, 100), value: String(index),
                    description: `${track.author.slice(0, 65)} · ${formatearDuracion(track.durationSeconds)}` })));
            const message = await interaction.editReply({ ...solicitud, content: 'Elige una canción. El menú expira en 30 segundos.',
                components: [new ActionRowBuilder().addComponents(menu)] });
            const collector = message.createMessageComponentCollector({ filter: item => item.user.id === interaction.user.id && item.customId === 'audio_selection', time: 30_000, max: 1 });
            collector.on('collect', item => {
                (async () => {
                    await item.deferUpdate();
                    const track = tracks[Number(item.values[0])];
                    if (!track) throw new ErrorAudio('Selección inválida.', 400);
                    interaction.client.music.enqueue(obtenerCanalVoz(item), interaction.channel, [track], interaction.user.id);
                    await item.editReply({ ...solicitud, content: '✅ Canción añadida a la cola.', components: [] });
                })().catch(error => responderError(item, error, solicitud.embeds));
            });
            collector.on('end', collected => {
                if (!collected.size) interaction.editReply({ ...solicitud, content: 'La selección expiró. Usa /play para buscar otra vez.', components: [] }).catch(() => null);
            });
        } catch (error) { return responderError(interaction, error, solicitud.embeds); }
    },
};
