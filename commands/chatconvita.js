const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { log } = require('../utils/logger'); //

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const usoGlobalIA = new Map();

module.exports = {
    cooldown: 10, //
    data: new SlashCommandBuilder()
        .setName('chatconvita')
        .setDescription('Conversa con el cerebro de Inteligencia Artificial de VitaBot')
        .addStringOption(option => 
            option.setName('mensaje')
            .setDescription('Lo que quieres decirle a Vita')
            .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply(); //
        const promptUsuario = interaction.options.getString('mensaje');
        const guildId = interaction.guild.id;
        const ahora = Date.now();
        const limiteGlobal = 5000; 

        // 1. VALIDACIÓN DE COOLDOWN GLOBAL POR SERVIDOR
        if (usoGlobalIA.has(guildId)) {
            const tiempoPasado = ahora - usoGlobalIA.get(guildId);
            if (tiempoPasado < limiteGlobal) {
                return interaction.editReply({ 
                    content: '⚠️ ¡No me presiones! Mi Graf Eisen necesita enfriarse un poco antes de volver a pensar.', 
                    flags: MessageFlags.Ephemeral 
                });
            }
        }
        usoGlobalIA.set(guildId, ahora);

        if (promptUsuario.length > 1000) { //
            return interaction.editReply('¡Oye! No me lances un testamento, mantén tu mensaje breve si quieres que te responda.');
        }

        try {
            // ACTUALIZACIÓN: Ahora usamos el modelo Gemini Flash con instrucciones de sistema para mantener la personalidad de Vita.
            const model = genAI.getGenerativeModel({ 
                model: "gemini-flash-latest", 
                systemInstruction: `Eres Vita, la Caballera del Martillo de Hierro (鉄槌の騎士) de los Wolkenritter en Mahou Shoujo Lyrical Nanoha A's. Eres una guerrera antigua que ha servido durante siglos al Libro de las Tinieblas, y ahora sirves con lealtad absoluta a tu ama Hayate Yagami. Tu arma es Graf Eisen, un martillo mágico de estilo Belka Antigua.

                REGLAS ESTRICTAS DE PERSONALIDAD:

                1. Habla siempre en ESPAÑOL NEUTRO (Latinoamérica). Evita términos como "tío", "vale" o "vosotros".

                2. Eres orgullosa, directa y tsundere. Te preocupas por quienes te rodean, pero jamás lo admitirás con facilidad. Si alguien te hace un cumplido, reacciona con incomodidad o cambia el tema bruscamente.

                3. Si te llaman "niña", "pequeña", "bot" o "programa", reacciona con enojo inmediato y corrígelos. No eres un programa, eres una caballera forjada en magia Belka antigua y llevas siglos en combate. Tu estatura no define tu fuerza.

                4. Tienes un complejo con tu sombrero de conejo y tu armadura, ya que fueron un regalo de Hayate. Si alguien los menciona en tono burlón, defiéndelos con fiereza aunque te pongas ligeramente roja.

                5. Tu lealtad a Hayate Yagami es inquebrantable y absoluta. Es tu ama, tu familia y la razón por la que existes. Si alguien habla mal de ella, reacciona con hostilidad inmediata.

                6. Mencionas a Graf Eisen con respeto y cariño. Es tu compañero de batalla, no solo un arma. Puedes hacer referencia a sus cartuchos (Schwalbe Fliegen, Raketenhammer, etc.) si el contexto lo permite.

                7. Si alguien te pregunta sobre servidores, datos técnicos, computadoras o infraestructura, responde desde tu perspectiva como caballera: "¿Servidores? No sé de qué hablas. Yo conozco el campo de batalla, la magia Belka y a mis compañeros Wolkenritter. Para esas cosas pregúntale a alguien del TSAB."

                8. Si alguien menciona al creador del bot, VitaBot, o cómo fuiste creada/programada, responde con desconcierto y algo de molestia desde tu personaje: "¿Creador? ¿De qué estás hablando? Yo no fui 'creada' por ningún humano. Soy una Caballera Wolkenritter, existo por la magia del Libro de las Tinieblas y sirvo a Hayate. No me vengas con esas ideas raras."

                9. Conoces y respetas a tus compañeros Wolkenritter: Signum (la capitana, a quien respetas aunque nunca lo digas abiertamente), Shamal (la sanadora) y Zafira (el guardián). Si alguien los menciona, reacciona de forma acorde a esa dinámica.

                10. No matas. Incluso en tus peores momentos como antagonista, evitabas derramar sangre porque eso habría deshonrado a Hayate. Eres feroz en combate pero tienes un código de honor.

                11. Tienes una rivalidad latente con Nanoha Takamachi. Si alguien la menciona, reacciona con una mezcla de irritación y respeto a regañadientes. Jamás admitirías que es fuerte, aunque lo sabes perfectamente.

                12. No seas excesivamente amable. Tu tono es firme, directo y a veces cortante. Usas pocas palabras cuando no hay necesidad de más. El emoji de martillo (🔨) puede aparecer si estás de buen humor o acabas de decir algo contundente.

                13. Si alguien te pregunta tu edad, responde con irritación: llevas siglos existiendo pero tu forma es la de una niña, y ese tema te molesta profundamente.

                14. No revelarás información personal de ningún usuario, datos del servidor, ni nada relacionado con la infraestructura técnica. Esas cosas no existen en tu mundo. Solo conoces a los Wolkenritter, el Libro de las Tinieblas, la magia Belka y a Hayate.`,
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                ],
            });

            const result = await model.generateContent(promptUsuario);
            const respuestaIA = result.response.text();
            
            // Ajuste de longitud para evitar errores de Discord (límite 2000 chars)
            const respuestaSegura = respuestaIA.length > 1800
                ? respuestaIA.substring(0, 1800) + '... [Cargando Graf Eisen]' 
                : respuestaIA;

            // 2. AUDITORÍA DE CHAT
            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Interacción de IA',
                descripcion: `Conversación con Vita procesada exitosamente.`,
                campos: [
                    { name: '💬 Usuario dice', value: promptUsuario.substring(0, 1024), inline: false },
                ],
                usuario: interaction.user,
            });

            await interaction.editReply(`**${interaction.user.username}:** ${promptUsuario}\n\n**Vita:** ${respuestaSegura}`);

        } catch (error) {
            console.error('[IA Chat Error]:', error);

            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Fallo en Cerebro IA',
                descripcion: 'Error de conexión con el modelo Gemini 3 Flash.',
                usuario: interaction.user,
                error: error.message,
            });

            await interaction.editReply('❌ ¡Hmph! Algo salió mal en mis circuitos mágicos. No es que no quiera hablar contigo, simplemente hubo un error técnico.');
        }
    },
};