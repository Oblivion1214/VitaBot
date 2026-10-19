const { MessageFlags } = require('discord.js');
const { ErrorAudio } = require('../audio/protocolo');
const { obtenerSesionActiva, responderError, crearMensajeCola, mostrarLetra } = require('./interfazMusica');

async function manejarBotonesMusica(interaction) {
    try {
        const session = obtenerSesionActiva(interaction);
        if (interaction.customId.startsWith('musica_queue_page_')) {
            return interaction.update(crearMensajeCola(session, Number(interaction.customId.slice('musica_queue_page_'.length))));
        }
        const [action, generation] = interaction.customId.split(':');
        if (!generation || Number(generation) !== session.current?.generation || interaction.message.id !== session.panel?.id) {
            throw new ErrorAudio('Este panel expiró. Usa el panel más reciente o los comandos de música.', 409);
        }
        if (action === 'musica_queue') return interaction.reply({ ...crearMensajeCola(session), flags: MessageFlags.Ephemeral });
        if (action === 'musica_lyrics') return await mostrarLetra(interaction, session.current.track);
        let content;
        if (action === 'musica_pausa') content = session.pause() ? '⏸️ Música pausada.' : '▶️ Música reanudada.';
        else if (action === 'musica_salto') { session.skip(); content = '⏭️ Pista omitida.'; }
        else if (action === 'musica_stop') { session.stop(); content = '⏹️ Sesión terminada y cola vacía.'; }
        else if (action === 'musica_shuffle') { session.shuffle(); content = '🔀 Cola mezclada.'; }
        else throw new ErrorAudio('Control no disponible.', 400);
        return await interaction.reply({ content, flags: MessageFlags.Ephemeral });
    } catch (error) { return responderError(interaction, error); }
}
module.exports = { manejarBotonesMusica };
