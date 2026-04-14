const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { HfInference } = require('@huggingface/inference');
const translate = require('google-translate-api-x');
const { log } = require('../utils/logger'); // Tu sistema de auditoría

// Inicializamos el motor con tu token del .env
const hf = new HfInference(process.env.HF_TOKEN);

module.exports = {
    data: new SlashCommandBuilder()
        .setName('imagine')
        .setDescription('Genera arte de alta fidelidad (Integrado con Auditoría de VitaBot).')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('Describe tu visión creativa')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();
        const promptOriginal = interaction.options.getString('prompt');

        // Definimos los modelos (Pesado vs Ligero)
        const modelos = [
            "black-forest-labs/FLUX.1-schnell",
            "stabilityai/stable-diffusion-xl-base-1.0"
        ];

        try {
            // 1. Auditoría Inicial: Registro de solicitud
            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Solicitud de Imagen IA',
                descripcion: `Usuario iniciando proceso de generación.\n**Prompt:** \`${promptOriginal}\``,
                usuario: interaction.user
            });

            // 2. Traducción automática
            const res = await translate(promptOriginal, { to: 'en' });
            const promptEn = res.text;
            const finalPrompt = `${promptEn}, high resolution, 8k, masterpiece, highly detailed, anime aesthetic`;

            let imageBlob = null;
            let modeloExitoso = "";

            // 3. Intento de Generación con Redundancia
            for (const modelId of modelos) {
                try {
                    console.log(`[IA] Solicitando a Hugging Face (Router) -> ${modelId}...`);
                    
                    imageBlob = await hf.textToImage({
                        model: modelId,
                        inputs: finalPrompt,
                        parameters: {
                            guidance_scale: 3.5,
                            num_inference_steps: 4, // Optimizado para velocidad en FLUX
                        }
                    });

                    if (imageBlob) {
                        modeloExitoso = modelId;
                        break;
                    }
                } catch (err) {
                    console.warn(`[IA Warning] El modelo ${modelId} no respondió o está cargando.`);
                    // Si el error indica que está cargando, lo reportamos al log de admin
                    if (err.message.includes("loading")) continue;
                }
            }

            if (!imageBlob) throw new Error("Los motores de IA están saturados o fuera de línea.");

            // 4. Convertimos el Blob a Buffer para Discord
            const buffer = Buffer.from(await imageBlob.arrayBuffer());
            const attachment = new AttachmentBuilder(buffer, { name: 'vita-art.png' });

            // 5. Auditoría de Éxito
            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Imagen Generada con Éxito',
                descripcion: `Generación completada.\n**Motor:** \`${modeloExitoso}\``,
                usuario: interaction.user,
                campos: [{ name: 'Prompt IA', value: promptEn }]
            });

            const embed = new EmbedBuilder()
                .setTitle('🎨 Obra Generada')
                .addFields(
                    { name: '📝 Prompt', value: promptOriginal, inline: false },
                    { name: '⚙️ Motor', value: `\`${modeloExitoso.split('/').pop()}\``, inline: true }
                )
                .setImage('attachment://vita-art.png')
                .setColor('#FF9900')
                .setFooter({ text: 'VitaBot Creative Engine 🔨' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (error) {
            console.error('[IA Error]:', error.message);

            // 6. Auditoría de Fallo Sanitizada
            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Fallo en Generación IA',
                descripcion: `No se pudo completar la imagen para el usuario.`,
                usuario: interaction.user,
                error: error.message // logger.js protege tus rutas locales
            });

            await interaction.editReply('❌ No se pudo procesar tu solicitud creativa en este momento. Los motores externos están fuera de servicio.');
        }
    },
};