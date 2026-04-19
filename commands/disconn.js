// commands/disconn.js — Protocolo de Retirada Belka (Versión Reforzada)
const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const { useQueue } = require('discord-player');
const { getVoiceConnection } = require('@discordjs/voice');
const { log } = require('../utils/logger');
// Importamos el mapa de conexiones para poder limpiar el timeout de 2 min
const { conexionesTTS } = require('./decir.js'); 

module.exports = {
    data: new SlashCommandBuilder()
        .setName('disconn')
        .setDescription('Desconecta a Vita del canal de voz y limpia la cola.'),

    async execute(interaction) {
        const guildId = interaction.guildId;
        const queue = useQueue(guildId);
        const ttsInfo = conexionesTTS.get(guildId);
        const connection = getVoiceConnection(guildId);

        // 1. Verificación absoluta: ¿Hay algo de qué desconectarse?
        if (!queue && !ttsInfo && !connection) {
            return interaction.reply({ 
                content: '❌ Ni siquiera estoy en un canal de voz. ¿Acaso intentas confundir mis circuitos?', 
                flags: MessageFlags.Ephemeral 
            });
        }

        // 2. Limpiar sesión de música si existe
        if (queue) {
            queue.delete();
        }

        // 3. Limpiar sesión de TTS y su temporizador de espera
        if (ttsInfo) {
            // Cancelamos el timeout de 2 minutos para que no intente borrar algo ya destruido
            clearTimeout(ttsInfo.timeout); 
            ttsInfo.connection.destroy();
            conexionesTTS.delete(guildId);
            console.log(`[TTS] Conexión manual de ${interaction.guild.name} terminada por /disconn.`);
        } else if (connection) {
            // Caso de seguridad: Si hay conexión pero no está en el mapa de TTS
            connection.destroy();
        }

        // Registro en auditoría
        await log(interaction.guild, {
            categoria: 'musica',
            titulo: 'Desconexión Forzada',
            descripcion: 'El sistema ha sido retirado del canal manualmente, limpiando procesos de música y voz.',
            usuario: interaction.user
        });

        return interaction.reply('✅ **Graf Eisen: Standby.** Me retiro del canal de voz inmediatamente.');
    },
};