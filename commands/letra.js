const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

/**
 * Limpieza avanzada para maximizar la tasa de éxito.
 * Filtra tags específicos detectados en tus logs de José José.
 */
function limpiarParaLyrics(texto, autor) {
    if (!texto) return '';
    
    let limpio = texto
        .replace(/\(Letra Oficial\)/gi, '')
        .replace(/\(Video Oficial\)/gi, '')
        .replace(/\(Letra\)/gi, '')
        .replace(/\(Official Video\)/gi, '')
        .replace(/\(Lyrics\)/gi, '')
        .replace(/\[.*?\]/g, '') // Elimina corchetes
        .replace(/"/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (limpio.includes('-')) {
        const partes = limpio.split('-');
        if (autor && partes[0].toLowerCase().includes(autor.toLowerCase())) {
            limpio = partes[partes.length - 1].trim();
        } else {
            limpio = partes[partes.length - 1].trim();
        }
    }
    
    return limpio;
}

module.exports = {
    data: new SlashCommandBuilder()
        .setName('letra')
        .setDescription('Busca la letra de la canción actual directamente en Genius.'),

    async execute(interaction) {
        const queue = useQueue(interaction.guildId);

        // 1. Verificación de música activa
        if (!queue || !queue.isPlaying()) {
            return interaction.reply({ 
                content: '❌ No hay ninguna canción sonando para buscar su letra.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            const track = queue.currentTrack; //
            const tituloLimpio = limpiarParaLyrics(track.title, track.author);

            // 2. Búsqueda usando el SDK de Genius (client.genius definido en index.js)
            console.log(`[Cmd Letra] Buscando en Genius: "${tituloLimpio}" de "${track.author}"`);
            
            const búsquedas = await interaction.client.genius.songs.search(`${tituloLimpio} ${track.author}`);
            const canciónEncontrada = búsquedas[0];

            if (!canciónEncontrada) {
                console.log(`[Cmd Letra] ❌ Sin resultados para: ${tituloLimpio}`);
                return interaction.editReply(`❌ No encontré letras para: **${tituloLimpio}**.`);
            }

            // 3. Obtención de la letra
            const letra = await canciónEncontrada.lyrics();

            if (!letra) {
                return interaction.editReply(`❌ Encontré la canción, pero la letra no está disponible.`);
            }

            console.log(`[Cmd Letra] ✅ Letra obtenida con éxito.`);

            // 4. Formateo del Embed (Discord límite 4096)
            const embed = new EmbedBuilder()
                .setTitle(`🎤 Letras: ${canciónEncontrada.title}`)
                .setAuthor({ name: canciónEncontrada.artist.name })
                .setThumbnail(canciónEncontrada.image)
                .setDescription(letra.length > 4000 
                    ? letra.substring(0, 3997) + '...' 
                    : letra)
                .setColor('#FF9900')
                .setFooter({ text: 'Sincronizado vía Genius SDK por VitaBot 🔨' });

            return interaction.editReply({ embeds: [embed] });

        } catch (e) {
            console.error('[Lyrics Command Error]:', e.message);
            return interaction.editReply('❌ Mis circuitos de letras han fallado. Revisa la consola para más detalles.');
        }
    },
};