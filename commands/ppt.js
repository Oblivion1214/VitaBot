const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, MessageFlags } = require('discord.js');
const { log } = require('../utils/logger');

module.exports = {
    cooldown: 5,
    data: new SlashCommandBuilder()
        .setName('ppt')
        .setDescription('Juega una partida de Piedra, Papel o Tijera contra VitaBot'),

    async execute(interaction) {
        const btnPiedra = new ButtonBuilder().setCustomId('piedra').setLabel('Piedra').setEmoji('🪨').setStyle(ButtonStyle.Primary);
        const btnPapel = new ButtonBuilder().setCustomId('papel').setLabel('Papel').setEmoji('📄').setStyle(ButtonStyle.Primary);
        const btnTijera = new ButtonBuilder().setCustomId('tijera').setLabel('Tijera').setEmoji('✂️').setStyle(ButtonStyle.Primary);

        const fila = new ActionRowBuilder().addComponents(btnPiedra, btnPapel, btnTijera);

        const embedInicial = new EmbedBuilder()
            .setTitle('🪨 📄 ✂️ ¡Piedra, Papel o Tijera!')
            .setDescription('Tienes **30 segundos** para elegir tu jugada usando los botones de abajo.')
            .setColor('#0099ff');

        await interaction.reply({ embeds: [embedInicial], components: [fila] });
        const respuesta = await interaction.fetchReply();

        const collector = respuesta.createMessageComponentCollector({ time: 30000 });

        collector.on('collect', async i => {
            // Verificación de usuario
            if (i.user.id !== interaction.user.id) {
                return i.reply({ 
                    content: '❌ ¡Esta no es tu partida! Usa `/ppt` para iniciar la tuya.', 
                    flags: MessageFlags.Ephemeral 
                });
            }

            const eleccionUsuario = i.customId;
            const opciones = ['piedra', 'papel', 'tijera'];
            const eleccionBot = opciones[Math.floor(Math.random() * opciones.length)];
            const emojis = { piedra: '🪨', papel: '📄', tijera: '✂️' };

            let resultado = '';
            let color = '';

            if (eleccionUsuario === eleccionBot) {
                resultado = '¡Es un Empate! 🤝';
                color = '#FFFF00';
            } else if (
                (eleccionUsuario === 'piedra' && eleccionBot === 'tijera') ||
                (eleccionUsuario === 'papel' && eleccionBot === 'piedra') ||
                (eleccionUsuario === 'tijera' && eleccionBot === 'papel')
            ) {
                resultado = '¡Ganaste! 🎉';
                color = '#00FF00';
            } else {
                resultado = '¡Perdiste! 💀';
                color = '#FF0000';
            }

            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Partida de PPT completada',
                descripcion: `Una partida de Piedra, Papel o Tijera ha concluido.`,
                campos: [
                    { name: '🎮 Resultado', value: resultado, inline: true },
                    { name: '👤 Jugador eligió', value: `${emojis[eleccionUsuario]} ${eleccionUsuario}`, inline: true },
                    { name: '🤖 Bot eligió', value: `${emojis[eleccionBot]} ${eleccionBot}`, inline: true },
                ],
                usuario: interaction.user,
            });

            const embedFinal = new EmbedBuilder()
                .setTitle(`Resultado: ${resultado}`)
                .addFields(
                    { name: 'Tu jugada', value: `${emojis[eleccionUsuario]} ${eleccionUsuario}`, inline: true },
                    { name: 'Mi jugada', value: `${emojis[eleccionBot]} ${eleccionBot}`, inline: true }
                )
                .setColor(color);

            // Desactivamos los botones ANTES de responder para evitar doble clic
            btnPiedra.setDisabled(true);
            btnPapel.setDisabled(true);
            btnTijera.setDisabled(true);
            const filaDesactivada = new ActionRowBuilder().addComponents(btnPiedra, btnPapel, btnTijera);

            try {
                // Usamos update para que los botones se vean desactivados inmediatamente
                await i.update({ embeds: [embedFinal], components: [filaDesactivada] });
                collector.stop(); // Terminamos el colector manualmente
            } catch (err) {
                console.error('Error al actualizar PPT:', err.message);
            }
        });

        collector.on('end', collected => {
            if (collected.size === 0) {
                embedInicial.setDescription('⏳ El tiempo se acabó. Te dio miedo jugar.');
                embedInicial.setColor('#808080');
                
                btnPiedra.setDisabled(true);
                btnPapel.setDisabled(true);
                btnTijera.setDisabled(true);
                const filaDesactivada = new ActionRowBuilder().addComponents(btnPiedra, btnPapel, btnTijera);

                interaction.editReply({ embeds: [embedInicial], components: [filaDesactivada] }).catch(console.error);
            }
        });
    }
};