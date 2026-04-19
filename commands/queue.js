// commands/queue.js — VitaBot
// Comando /queue con paginación por botones (◀️ / ▶️)
const {
    SlashCommandBuilder,
    EmbedBuilder,
    MessageFlags,
    ActionRowBuilder,
    ButtonBuilder,
    ButtonStyle
} = require('discord.js');
const { useQueue } = require('discord-player');

// ─────────────────────────────────────────────
// HELPER: construye el embed y los botones de una página.
// Reutilizado en la respuesta inicial y en cada clic de paginación.
// ─────────────────────────────────────────────
const TRACKS_POR_PAGINA = 10;

function construirPaginaCola(queue, interaction, paginaActual) {
    const currentTrack = queue.currentTrack;
    const tracks       = queue.tracks.toArray();
    const totalPaginas = Math.max(1, Math.ceil(tracks.length / TRACKS_POR_PAGINA));

    paginaActual = Math.max(0, Math.min(paginaActual, totalPaginas - 1));

    const inicio       = paginaActual * TRACKS_POR_PAGINA;
    const tracksPagina = tracks.slice(inicio, inicio + TRACKS_POR_PAGINA);

    let listado = tracksPagina.map((track, i) => {
        const tituloSeguro    = track.title.replace(/[\[\]]/g, '');
        const tituloRecortado = tituloSeguro.length > 70
            ? tituloSeguro.substring(0, 67) + '...'
            : tituloSeguro;
        return `**${inicio + i + 1}.** [${tituloRecortado}](${track.url}) - \`${track.duration}\``;
    }).join('\n');

    if (listado.length > 1000) listado = listado.substring(0, 997) + '...';

    const embed = new EmbedBuilder()
        .setTitle(`🎼 Cola de Reproducción — ${interaction.guild.name}`)
        .setColor('#FF9900')
        .setThumbnail(currentTrack.thumbnail?.startsWith('http') ? currentTrack.thumbnail : null)
        .addFields(
            {
                name: '▶️ Reproduciendo Ahora',
                value: `**[${currentTrack.title.replace(/[\[\]]/g, '')}](${currentTrack.url})**\nAutor: \`${currentTrack.author}\` | Pedida por: ${currentTrack.requestedBy ?? 'Desconocido'}`,
                inline: false
            },
            {
                name: `⏭️ Próximas Canciones (página ${paginaActual + 1}/${totalPaginas})`,
                value: listado || '_No hay más canciones en la cola._',
                inline: false
            }
        )
        .setFooter({
            text: `Total: ${tracks.length} canciones | ${queue.durationFormatted || 'calculando...'} restantes`
        })
        .setTimestamp();

    const componentes = [];
    if (totalPaginas > 1) {
        componentes.push(new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`queue_page_${paginaActual - 1}`)
                .setEmoji('◀️')
                .setLabel('Anterior')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(paginaActual === 0),
            new ButtonBuilder()
                .setCustomId(`queue_page_${paginaActual + 1}`)
                .setEmoji('▶️')
                .setLabel('Siguiente')
                .setStyle(ButtonStyle.Secondary)
                .setDisabled(paginaActual >= totalPaginas - 1)
        ));
    }

    return { embed, componentes, totalPaginas };
}

// ─────────────────────────────────────────────
// COMANDO
// ─────────────────────────────────────────────
module.exports = {
    data: new SlashCommandBuilder()
        .setName('queue')
        .setDescription('Muestra la lista de canciones próximas en la cola.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);

        if (!queue || !queue.isPlaying()) {
            return interaction.reply({
                content: '❌ No hay música reproduciéndose actualmente.',
                flags: MessageFlags.Ephemeral
            });
        }

        const { embed, componentes } = construirPaginaCola(queue, interaction, 0);

        // Respuesta pública con fetchReply para poder crear el collector
        const msg = await interaction.reply({
            embeds: [embed],
            components: componentes,
            fetchReply: true
        });

        // Sin páginas extra → no hay nada que coleccionar
        if (componentes.length === 0) return;

        // ── COLLECTOR DE PAGINACIÓN ────────────────────────────────────────
        // Solo el invocador puede paginar. Expira en 2 minutos.
        const collector = msg.createMessageComponentCollector({
            filter: i => {
                if (!i.customId.startsWith('queue_page_')) return false;
                if (i.user.id !== interaction.user.id) {
                    i.reply({
                        content: '⚠️ Solo quien usó `/queue` puede navegar las páginas.',
                        flags: MessageFlags.Ephemeral
                    });
                    return false;
                }
                return true;
            },
            time: 120_000
        });

        collector.on('collect', async i => {
            const pagina = parseInt(i.customId.replace('queue_page_', '')) || 0;

            const queueActual = useQueue(interaction.guildId);
            if (!queueActual || !queueActual.isPlaying()) {
                await i.update({ content: '❌ La reproducción ha terminado.', embeds: [], components: [] });
                collector.stop();
                return;
            }

            const { embed: nuevoEmbed, componentes: nuevosComponentes } = construirPaginaCola(queueActual, interaction, pagina);

            // deferUpdate() + editReply() — correcto para mensajes NO efímeros con botones
            await i.deferUpdate();
            await i.editReply({ embeds: [nuevoEmbed], components: nuevosComponentes });
        });

        collector.on('end', async () => {
            // Deshabilitar botones cuando el collector expire (ya no responden)
            await interaction.editReply({ components: [] }).catch(() => null);
        });
    },
};