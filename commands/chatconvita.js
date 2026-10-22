const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { gemini } = require('../utils/servicioGemini');
const { esSolicitudTecnica, esRespuestaTecnica, RESPUESTA_TEMA_TECNICO, RESPUESTA_TEMA_NO_PERMITIDO } = require('../utils/charlaVita');

const usoGlobal = new Map();
const solicitudesEnCurso = new Set();
const COOLDOWN_MS = 5000;
const RESPUESTA_NO_DISPONIBLE = 'Hmph… Ahora no puedo responder. Dame un momento e inténtalo de nuevo.';

function limitarRespuesta(texto) {
    const prefijo = '**Vita:** ';
    const sufijo = '\n… ¡Eso da para otra charla!';
    if (prefijo.length + texto.length <= 2000) return prefijo + texto;
    let recorte = texto.slice(0, 2000 - prefijo.length - sufijo.length);
    // No dejar medio emoji al cortar una cadena UTF-16.
    if (/[\uD800-\uDBFF]$/.test(recorte)) recorte = recorte.slice(0, -1);
    return prefijo + recorte + sufijo;
}

module.exports = {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('chatconvita')
        .setDescription('Charla y diviértete con Vita en este canal')
        .addStringOption(option => option
            .setName('mensaje')
            .setDescription('Lo que quieres decirle a Vita')
            .setRequired(true)
            .setMinLength(1)
            .setMaxLength(1000)),

    async execute(interaction) {
        const promptUsuario = interaction.options.getString('mensaje').trim();
        if (!promptUsuario || promptUsuario.length > 1000) {
            return interaction.reply({
                content: '¡Oye! Escríbeme un mensaje de entre 1 y 1000 caracteres.',
                flags: MessageFlags.Ephemeral,
            });
        }

        if (esSolicitudTecnica(promptUsuario)) {
            return interaction.reply({ content: limitarRespuesta(RESPUESTA_TEMA_TECNICO), allowedMentions: { parse: [] } });
        }

        if (!gemini.configured()) {
            return interaction.reply({ content: RESPUESTA_NO_DISPONIBLE, flags: MessageFlags.Ephemeral });
        }

        const scope = interaction.guildId ?? `dm:${interaction.user.id}`;
        const ahora = Date.now();
        if (solicitudesEnCurso.has(scope) || ahora - (usoGlobal.get(scope) ?? 0) < COOLDOWN_MS) {
            return interaction.reply({
                content: '¡No me presiones! Dame un momento para terminar lo que estoy haciendo.',
                flags: MessageFlags.Ephemeral,
            });
        }

        solicitudesEnCurso.add(scope);
        usoGlobal.set(scope, ahora);
        setTimeout(() => usoGlobal.delete(scope), COOLDOWN_MS).unref();

        try {
            await interaction.deferReply();
            const result = await gemini.generate({ contents: promptUsuario, scope });
            const respuesta = result.status === 'blocked' ? RESPUESTA_TEMA_NO_PERMITIDO
                : result.text && esRespuestaTecnica(result.text) ? RESPUESTA_TEMA_TECNICO : result.text;

            // No se guardan mensajes, respuestas ni identificadores del usuario en los logs de chat.
            return await interaction.editReply({
                content: respuesta ? limitarRespuesta(respuesta) : RESPUESTA_NO_DISPONIBLE,
                allowedMentions: { parse: [] },
            });
        } catch {
            return interaction.editReply({ content: RESPUESTA_NO_DISPONIBLE, allowedMentions: { parse: [] } });
        } finally {
            solicitudesEnCurso.delete(scope);
        }
    },
};
