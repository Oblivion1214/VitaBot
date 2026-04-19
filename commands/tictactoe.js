// commands/tictactoe.js — Tic-Tac-Toe
const { 
    SlashCommandBuilder, 
    ActionRowBuilder, 
    ButtonBuilder, 
    ButtonStyle, 
    EmbedBuilder,
    MessageFlags
} = require('discord.js');

// RASTREADOR GLOBAL: Evita múltiples partidas por persona
const partidasActivas = new Set();

module.exports = {
    data: new SlashCommandBuilder()
        .setName('tictactoe')
        .setDescription('Juega al gato contra un amigo o contra Vita')
        .addUserOption(option => 
            option.setName('oponente')
            .setDescription('Usuario al que quieres retar (déjalo vacío para jugar contra Vita)')
        ),

    async execute(interaction) {
        // 1. BLOQUEO DE SEGURIDAD: Solo una partida activa por usuario
        if (partidasActivas.has(interaction.user.id)) {
            return interaction.reply({
                content: '⚠️ ¡Hmph! Ya estás en un duelo. Termina ese primero antes de intentar desafiarme de nuevo.',
                flags: MessageFlags.Ephemeral
            });
        }

        const oponente = interaction.options.getUser('oponente') || interaction.client.user;
        const esContraBot = oponente.id === interaction.client.user.id;

        // Registramos al usuario en el laboratorio
        partidasActivas.add(interaction.user.id);

        let tablero = Array(9).fill(null);
        let turnoActual = interaction.user.id;

        const generarTablero = (deshabilitarTodo = false) => {
            const filas = [];
            for (let i = 0; i < 3; i++) {
                const fila = new ActionRowBuilder();
                for (let j = 0; j < 3; j++) {
                    const idx = i * 3 + j;
                    fila.addComponents(
                        new ButtonBuilder()
                            .setCustomId(`ttt_${idx}`)
                            .setLabel(tablero[idx] || '-')
                            .setStyle(tablero[idx] === 'X' ? ButtonStyle.Danger : tablero[idx] === 'O' ? ButtonStyle.Primary : ButtonStyle.Secondary)
                            .setDisabled(deshabilitarTodo || tablero[idx] !== null)
                    );
                }
                filas.push(fila);
            }
            return filas;
        };

        const embed = new EmbedBuilder()
            .setTitle('🎮 Tic-Tac-Toe: Duelo Belka')
            .setDescription(esContraBot ? '¿Crees que puedes ganarle a una Caballera Wolkenritter? ¡No me hagas reír!' : `Duelo entre **${interaction.user.username}** (X) y **${oponente.username}** (O)`)
            .setColor('#FF9900')
            .setFooter({ text: `Turno de: ${interaction.user.username} | Tiempo límite: 5 min` });

        const mensaje = await interaction.reply({ embeds: [embed], components: generarTablero() });

        // TIEMPO LÍMITE: 5 minutos para evitar saturar el servidor
        const colector = mensaje.createMessageComponentCollector({ 
            filter: i => i.customId.startsWith('ttt_'), 
            time: 5 * 60 * 1000 
        });

        colector.on('collect', async i => {
            // Validaciones de turno
            if (!esContraBot && i.user.id !== turnoActual) {
                return i.reply({ content: '❌ ¡No es tu turno! Ten paciencia.', flags: MessageFlags.Ephemeral });
            }
            if (esContraBot && i.user.id !== interaction.user.id) {
                return i.reply({ content: '❌ Este duelo no es contigo.', flags: MessageFlags.Ephemeral });
            }

            const indice = parseInt(i.customId.split('_')[1]);
            tablero[indice] = turnoActual === interaction.user.id ? 'X' : 'O';

            // Comprobar ganador
            if (comprobarVictoria(tablero)) {
                embed.setDescription(`🎉 **¡Victoria para ${i.user.username}!** Graf Eisen reconoce tu destreza.`);
                await i.update({ embeds: [embed], components: generarTablero(true) });
                return colector.stop('victoria');
            }

            if (tablero.every(casilla => casilla !== null)) {
                embed.setDescription('🤝 **Empate.** Un resultado aceptable para un entrenamiento.');
                await i.update({ embeds: [embed], components: generarTablero(true) });
                return colector.stop('empate');
            }

            // Lógica del Bot (O)
            if (esContraBot) {
                const movsDisponibles = tablero.map((v, idx) => v === null ? idx : null).filter(v => v !== null);
                const eleccionBot = movsDisponibles[Math.floor(Math.random() * movsDisponibles.length)];
                tablero[eleccionBot] = 'O';

                if (comprobarVictoria(tablero)) {
                    embed.setDescription('🔨 **¡He ganado!** Vuelve cuando hayas entrenado un siglo más.');
                    await i.update({ embeds: [embed], components: generarTablero(true) });
                    return colector.stop('bot_gana');
                }

                // Si después de que juegue el bot se llena el tablero
                if (tablero.every(casilla => casilla !== null)) {
                    embed.setDescription('🤝 **Empate.** No está mal para ser tú.');
                    await i.update({ embeds: [embed], components: generarTablero(true) });
                    return colector.stop('empate');
                }
            } else {
                turnoActual = turnoActual === interaction.user.id ? oponente.id : interaction.user.id;
                embed.setFooter({ text: `Turno de: ${turnoActual === interaction.user.id ? interaction.user.username : oponente.username}` });
            }

            await i.update({ embeds: [embed], components: generarTablero() });
        });

        // LIMPIEZA AL TERMINAR: Liberar al usuario
        colector.on('end', async (collected, reason) => {
            partidasActivas.delete(interaction.user.id);
            
            if (reason === 'time') {
                embed.setDescription('⏰ **Duelo cancelado por inactividad.** Mi tiempo es valioso, no lo desperdicies.');
                await interaction.editReply({ embeds: [embed], components: generarTablero(true) }).catch(() => null);
            }
        });
    }
};

function comprobarVictoria(t) {
    const lineas = [
        [0,1,2], [3,4,5], [6,7,8], // Horizontales
        [0,3,6], [1,4,7], [2,5,8], // Verticales
        [0,4,8], [2,4,6]           // Diagonales
    ];
    return lineas.some(([a, b, c]) => t[a] && t[a] === t[b] && t[a] === t[c]);
}