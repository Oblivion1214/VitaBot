const { SlashCommandBuilder, EmbedBuilder, AttachmentBuilder, MessageFlags } = require('discord.js');
const { HfInference } = require('@huggingface/inference');
const translate = require('google-translate-api-x');
const { log } = require('../utils/logger'); //

// Inicializamos el motor con tu token del .env
const hf = new HfInference(process.env.HF_TOKEN);

module.exports = {
    cooldown: 20, // 🛡️ Protección contra spam (20 segundos)
    data: new SlashCommandBuilder()
        .setName('imagine')
        .setDescription('Genera arte con múltiples motores de respaldo (Resiliencia VitaBot).')
        .addStringOption(option =>
            option.setName('prompt')
                .setDescription('Describe tu visión creativa')
                .setRequired(true)),

    async execute(interaction) {
        await interaction.deferReply();
        const promptOriginal = interaction.options.getString('prompt');

        // Cascada de Modelos: De mayor calidad a mayor estabilidad
        const modelos = [
            "black-forest-labs/FLUX.1-schnell",         // Calidad Extrema (Inestable)
            "stabilityai/stable-diffusion-xl-base-1.0", // Alta Calidad (Estándar)
            "prompthero/openjourney",                   // Estilo artístico (Estable)
            "runwayml/stable-diffusion-v1-5",           // Clásico (Muy Estable)
            "CompVis/stable-diffusion-v1-4"             // Legado (Máxima Disponibilidad)
        ];

        try {
            // 1. Auditoría Inicial
            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Solicitud de Imagen IA',
                descripcion: `Usuario iniciando proceso de generación.\n**Prompt:** \`${promptOriginal}\``,
                usuario: interaction.user
            });

            // 2. Traducción para mejorar resultados en modelos entrenados en inglés
            const res = await translate(promptOriginal, { to: 'en' });
            const promptEn = res.text;
            const finalPrompt = `${promptEn}, high resolution, 8k, masterpiece, highly detailed`;

            let imageBlob = null;
            let modeloExitoso = "";

            // 3. Bucle de Redundancia: Salto automático entre motores
            for (const modelId of modelos) {
                try {
                    console.log(`[IA] Intentando motor -> ${modelId}...`);
                    
                    imageBlob = await hf.textToImage({
                        model: modelId,
                        inputs: finalPrompt,
                        parameters: {
                            guidance_scale: 7.5,
                            num_inference_steps: modelId.includes('FLUX') ? 4 : 30, // Ajuste dinámico de pasos
                        }
                    });

                    if (imageBlob) {
                        modeloExitoso = modelId;
                        console.log(`[IA] Éxito con: ${modelId}`);
                        break;
                    }
                } catch (err) {
                    // Captura errores de saturación o carga para saltar al siguiente modelo
                    console.warn(`[IA Warning] Motor ${modelId.split('/').pop()} falló: ${err.message}`);
                    continue; 
                }
            }

            if (!imageBlob) throw new Error("Todos los motores de IA (5/5) están saturados.");

            // 4. Preparación de Archivo
            const buffer = Buffer.from(await imageBlob.arrayBuffer());
            const attachment = new AttachmentBuilder(buffer, { name: 'vita-art.png' });

            // 5. Auditoría de Éxito con Motor Identificado
            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Imagen Generada con Éxito',
                descripcion: `Generación completada.\n**Motor utilizado:** \`${modeloExitoso}\``,
                usuario: interaction.user,
                campos: [{ name: 'Prompt Final', value: promptEn.substring(0, 1024) }]
            });

            const embed = new EmbedBuilder()
                .setTitle('🎨 Obra Generada por Vita')
                .addFields(
                    { name: '📝 Tu Prompt', value: `\`${promptOriginal}\``, inline: false },
                    { name: '⚙️ Motor que respondió', value: `\`${modeloExitoso.split('/').pop()}\``, inline: true }
                )
                .setImage('attachment://vita-art.png')
                .setColor('#FF9900')
                .setFooter({ text: 'VitaBot Creative Engine 🔨 — Toluca Lab' });

            await interaction.editReply({ embeds: [embed], files: [attachment] });

        } catch (error) {
            console.error('[IA Error]:', error.message);

            // 6. Auditoría de Fallo Sanitizada
            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Fallo Total en Generación IA',
                descripcion: `Se agotaron todos los modelos de respaldo sin éxito.`,
                usuario: interaction.user,
                error: error.message 
            });

            await interaction.editReply('❌ Todos los motores creativos están saturados en este momento. Intenta de nuevo en unos minutos.');
        }
    },
};