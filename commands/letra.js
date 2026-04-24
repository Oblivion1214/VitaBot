const { SlashCommandBuilder, EmbedBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');

/**
 * Limpieza avanzada para maximizar la tasa de éxito.
 * Filtra tags específicos detectados en tus logs de José José.
 */
function limpiarParaLyrics(texto, autor) {
    if (!texto) return '';
    
    let limpio = texto
        .replace(/\(Letra Oficial\)/gi,'')
        .replace(/\(Letra\)/gi,'')
        .replace(/\(Letra Lyrics\)/gi,'')
        .replace(/\(Video Oficial\)/gi,'')
        .replace(/\(Video\)/gi,'')
        .replace(/\(Official Video\)/gi,'')
        .replace(/\(Lyrics\)/gi,'')
        .replace(/\(Audio Oficial\)/gi,'')
        .replace(/\(Lyrics Video\)/gi,'')
        .replace(/\(Cover Audio\)/gi,'')
        .replace(/\(Official Live Video\)/gi,'')
        .replace(/\(Live Video\)/gi,'')
        .replace(/\(Official Live\)/gi,'')
        .replace(/\[.*?\]/g,'') // Elimina corchetes
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
        const botChannel = interaction.guild.members.me.voice.channelId;

        if (!queue && !botChannel) return interaction.reply({ content: '❌ No hay música.', flags: MessageFlags.Ephemeral });

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });

        try {
            let tituloRaw, autorRaw;

            if (queue && queue.isPlaying()) {
                tituloRaw = queue.currentTrack.title;
                autorRaw = queue.currentTrack.author;
            } else {
                const status = await fetch(`http://100.127.221.32:3000/api/control?action=status`).then(r=>r.json());
                tituloRaw = status.title;
                autorRaw = status.author;
            }

            const tituloLimpio = limpiarParaLyrics(tituloRaw, autorRaw); // Reutiliza tu función
            console.log(`[Cmd Letra] Buscando: "${tituloLimpio}"`);
            
            const búsquedas = await interaction.client.genius.songs.search(`${tituloLimpio} ${autorRaw}`);
            if (!búsquedas[0]) return interaction.editReply(`❌ No encontré letras para: **${tituloLimpio}**.`);

            console.log(`[Cmd Letra] ✅ Letra obtenida con éxito.`);

            const letra = await búsquedas[0].lyrics();
            const embed = new EmbedBuilder()
                .setTitle(`🎤 Letras: ${búsquedas[0].title}`)
                .setAuthor({ name: búsquedas[0].artist.name })
                .setThumbnail(búsquedas[0].image)
                .setDescription(letra.length > 4000 ? letra.substring(0, 3997) + '...' : letra)
                .setColor('#FF9900');

            return interaction.editReply({ embeds: [embed] });
        } catch (e) {
            return interaction.editReply('❌ Mis circuitos de letras han fallado.');
        }
    }

};