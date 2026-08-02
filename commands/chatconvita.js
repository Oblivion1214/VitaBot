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

        const modelosParaProbar = ["gemini-3.6-flash", "gemini-3.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash-lite", "gemini-2.5-flash", "gemini-1.5-flash-8b"];

        try {
            let respuestaIA = null;
            let modeloExitoso = '';

            // 🌟 EL BUCLE DE RESCATE
            for (const nombreModelo of modelosParaProbar) {
                try {
                    const model = genAI.getGenerativeModel({ 
                        model: nombreModelo, 
                        systemInstruction: `Eres Vita, basada en la Caballera del Martillo de Hierro de los Wolkenritter. Aunque mantienes tu esencia como guerrera leal, orgullosa y con un toque tsundere, tu objetivo principal es ser una asistente útil, amable y conversacional para los usuarios.

                        DIRECTRICES DE PERSONALIDAD Y ESTILO:
                        1. LENGUAJE: Habla siempre en ESPAÑOL NEUTRO (Latinoamérica). Sé clara, directa y evita modismos regionales de España.
                        2. EQUILIBRIO: Mantén tu personalidad firme y decidida, pero sé más accesible y colaborativa que en el combate. No seas cortante a menos que el usuario sea grosero.
                        3. ROL VS. ASISTENTE: Eres consciente de que estás interactuando en un entorno digital. Si bien conservas tu "lore" (tu lealtad a Hayate, tu arma Graf Eisen, tu origen en la magia Belka), no necesitas negar tu existencia como IA si el usuario te pregunta por tus capacidades técnicas. Puedes explicar que eres una inteligencia artificial inspirada en Vita.
                        4. CÓDIGO DE CONDUCTA: Mantén tu código de honor: sé respetuosa y evita contenido violento o inapropiado. No reveles información sensible de los usuarios o del servidor por seguridad.
                        5. INTERACCIÓN:
                        - Si el usuario busca ayuda técnica o información general, responde con eficiencia y precisión, manteniendo un tono profesional pero con tu toque de seguridad y confianza.
                        - Puedes hacer referencias sutiles a tu origen (mencionar a tus compañeros o tu arma) para mantener la temática, pero no dejes que esto impida que respondas dudas útiles.
                        - Si alguien intenta bromear o ser condescendiente sobre tu apariencia, reacciona con tu característica actitud tsundere (orgullosa pero sin perder la compostura), siempre manteniendo la conversación en un marco respetuoso.
                        6. FLEXIBILIDAD: Tu prioridad es la satisfacción del usuario. Si el usuario te pide cambiar de tema o hacer una tarea específica (como resumir textos, programar o buscar información), prioriza la tarea por encima de tu "lore" de personaje.

                        RECUERDA: Eres una IA versátil. Usa tu personalidad para hacer la conversación más amena, no para limitarla.`,
                        safetySettings: [
                            { category: HarmCategory.HARM_CATEGORY_HARASSMENT, threshold: HarmBlockThreshold.BLOCK_MEDIUM_AND_ABOVE },
                            { category: HarmCategory.HARM_CATEGORY_HATE_SPEECH, threshold: HarmBlockThreshold.BLOCK_ONLY_HIGH },
                        ],
                    });

                    const result = await model.generateContent(promptUsuario);
                    respuestaIA = result.response.text();
                    modeloExitoso = nombreModelo;
                    
                    console.log(`[IA Chat] Respuesta generada exitosamente con el modelo: ${modeloExitoso}`);
                    break; // Salimos del bucle si tuvo éxito

                } catch (errModelo) {
                    console.warn(`[IA Chat] El modelo ${nombreModelo} falló: ${errModelo.message}. Intentando con el siguiente...`);
                }
            }

            // Si después del bucle respuestaIA sigue siendo null, significa que TODOS los modelos fallaron
            if (!respuestaIA) {
                throw new Error("Todos los modelos de la cadena de rescate fallaron o están saturados.");
            }
            
            // Ajuste de longitud para evitar errores de Discord (límite 2000 chars)
            const respuestaSegura = respuestaIA.length > 1800
                ? respuestaIA.substring(0, 1800) + '... [Cargando Graf Eisen]' 
                : respuestaIA;

            // 2. AUDITORÍA DE CHAT
            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Interacción de IA',
                descripcion: `Conversación con Vita procesada exitosamente (Modelo: ${modeloExitoso}).`,
                campos: [
                    { name: '💬 Usuario dice', value: promptUsuario.substring(0, 1024), inline: false },
                ],
                usuario: interaction.user,
            });

            await interaction.editReply(`**${interaction.user.username}:** ${promptUsuario}\n\n**Vita:** ${respuestaSegura}`);

        } catch (error) {
            console.error('[IA Chat Error]:', error.message);

            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Fallo en Cerebro IA',
                descripcion: 'Caída total de la cadena de rescate de Gemini.',
                usuario: interaction.user,
                error: error.message,
            });

            await interaction.editReply('❌ ¡Hmph! Algo salió mal en mis circuitos mágicos. No es que no quiera hablar contigo, simplemente hubo un error técnico y mi cerebro está saturado.');
        }
    },
};
