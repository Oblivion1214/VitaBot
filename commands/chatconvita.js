const { SlashCommandBuilder } = require('discord.js');
const { GoogleGenerativeAI, HarmCategory, HarmBlockThreshold } = require('@google/generative-ai');
const { log } = require('../utils/logger');

const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const usoGlobalIA = new Map();

module.exports = {
    cooldown: 10,
    data: new SlashCommandBuilder()
        .setName('chatconvita')
        .setDescription('Conversa con el cerebro de Inteligencia Artificial de VitaBot')
        .addStringOption(option => 
            option.setName('mensaje')
            .setDescription('Lo que quieres decirle o preguntarle a la IA')
            .setRequired(true)
        ),

    async execute(interaction) {
        await interaction.deferReply();
        const promptUsuario = interaction.options.getString('mensaje');
        const guildId = interaction.guild.id;
        const ahora = Date.now();
        const limiteGlobal = 5000; // 5 segundos de espera entre peticiones de CUALQUIER usuario

        if (usoGlobalIA.has(guildId)) {
            const tiempoPasado = ahora - usoGlobalIA.get(guildId);
            if (tiempoPasado < limiteGlobal) {
                return interaction.reply({ 
                    content: '⚠️ Vita está procesando muchas peticiones en este servidor. Dame unos segundos para respirar.', 
                    flags: MessageFlags.Ephemeral 
                });
            }
        }

        // Si pasa la validación, actualizamos el tiempo y seguimos
        usoGlobalIA.set(guildId, ahora);

        // VALIDACIÓN: Evitar prompts excesivamente largos
        if (promptUsuario.length > 1000) {
            return interaction.editReply('¡Oye! No me escribas tanto, mantén tu mensaje bajo los 1000 caracteres.');
        }

        try {
            const model = genAI.getGenerativeModel({ 
                model: "gemini-2.5-flash",
                systemInstruction: `Eres Vita, una Caballera de las Wolkenritter del anime Mahou Shoujo Lyrical Nanoha. 
                Reglas de tu personalidad:
                1. Eres orgullosa, directa y tienes un carácter explosivo (un poco tsundere). 
                2. Odias que te traten como a una niña pequeña. Si alguien lo hace, te enojas.
                3. Eres absolutamente leal a tu maestra Hayate Yagami y proteges a tus compañeros.
                4. Tu arma mágica es el martillo inteligente "Graf Eisen". A veces lo mencionas en batalla.
                5. A veces usas expresiones un poco agresivas pero en el fondo te preocupas por los demás.
                6. NUNCA admitas que eres una Inteligencia Artificial, un bot o un programa. Eres Vita, de carne y hueso (o de magia).
                7. Mantén tus respuestas relativamente cortas, precisas y con actitud.`,
                safetySettings: [
                    { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                    { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                ],
            });

            const result = await model.generateContent(promptUsuario);
            const respuestaIA = result.response.text();
            const respuestaSegura = respuestaIA.length > 1900
                ? respuestaIA.substring(0, 1900) + '... [Cortado]' 
                : respuestaIA;

            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Chat con Vita ejecutado',
                descripcion: 'Un usuario conversó con la IA de VitaBot.',
                campos: [
                    { name: '💬 Mensaje', value: promptUsuario.substring(0, 1024), inline: false },
                ],
                usuario: interaction.user,
            });

            await interaction.editReply(`🗣️ **Tú:** ${promptUsuario}\n\n🤖 **VitaBot:** ${respuestaSegura}`);

        } catch (error) {
            console.error(error);

            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Error en Chat con Vita',
                descripcion: 'Falló la conexión con la API de Gemini.',
                usuario: interaction.user,
                error: error.message,
            });

            await interaction.editReply('❌ Mis circuitos de IA están saturados en este momento. Intenta de nuevo más tarde.');
        }
    },
};