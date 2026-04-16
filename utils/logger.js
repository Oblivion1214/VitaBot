// utils/logger.js — Sistema de auditoría reforzado de VitaBot
const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');

const LOG_CHANNEL_NAME = 'vitabot-logs';
const CONFIG_PATH = path.join(__dirname, '../config/audit-config.json');

const COLORS = {
    musica: '#FF9900',
    moderacion: '#5865F2',
    sistema: '#ED4245',
    general: '#57F287',
};

const EMOJIS = {
    musica: '🎵',
    moderacion: '🛡️',
    sistema: '🚨',
    general: '⚙️',
};

// --- UTILIDADES DE SEGURIDAD ---

function sanitizeErrorMessage(message) {
    if (!message) return 'Error desconocido';
    const pathRegex = /([a-zA-Z]:\\(?:[^\\\s]+\\)+|(?:\/[^/\s]+)+\/)/g;
    return message.replace(pathRegex, '[RUTA_PROTEGIDA]/');
}

// --- GESTIÓN DE CONFIGURACIÓN ---

function cargarConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return {};
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch(e) {
        return {};
    }
}

function guardarConfig(config) {
    try {
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
        console.error('[Logger] Error al escribir audit-config.json:', e.message);
    }
}

// Corregido: Se asegura de que el parámetro tenga un valor por defecto claro y se maneja la creación de la configuración inicial de manera más robusta.
function obtenerConfigServidor(guildId, idiomaDefecto = 'es') {
    const config = cargarConfig();
    if (!config[guildId]) {
        config[guildId] = {
            activo: true,
            idioma: idiomaDefecto, 
            categorias: {
                musica: true,
                moderacion: true,
                general: true,
                sistema: true,
            }
        };
        guardarConfig(config);
    }
    return config[guildId];
}

function actualizarConfigServidor(guildId, nuevaConfig) {
    const config = cargarConfig();
    config[guildId] = { ...obtenerConfigServidor(guildId), ...nuevaConfig };
    guardarConfig(config);
}

// --- GESTIÓN DEL CANAL DE AUDITORÍA ---

async function obtenerCanalLog(guild) {
    if (!guild) return null;

    // Buscamos si ya existe el canal
    let canal = guild.channels.cache.find(
        c => c.name === LOG_CHANNEL_NAME && c.type === ChannelType.GuildText
    );

    if (canal) return canal;

    // Verificación de seguridad: ¿El bot tiene permisos para crear canales?
    if (!guild.members.me || !guild.members.me.permissions.has(PermissionFlagsBits.ManageChannels)) {
        console.error(`[Logger] Error: No tengo permisos de 'ManageChannels' en ${guild.name}.`);
        return null;
    }

    try {
        const permisosOverwrites = [
            // Ocultar a todos
            { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] },
            // Dar acceso explícito al Owner (Tú)
            { id: guild.ownerId, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory, PermissionFlagsBits.SendMessages] },
            // Dar acceso al propio Bot para que pueda escribir
            { id: guild.members.me.id, allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks] }
        ];

        // Incluimos roles con permisos de moderación
        const rolesMod = guild.roles.cache.filter(rol =>
            rol.permissions.has(PermissionFlagsBits.ManageMessages) ||
            rol.permissions.has(PermissionFlagsBits.ManageGuild)
        );

        rolesMod.forEach(rol => {
            permisosOverwrites.push({
                id: rol.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory],
            });
        });

        return await guild.channels.create({
            name: LOG_CHANNEL_NAME,
            type: ChannelType.GuildText,
            topic: '📋 Auditoría de VitaBot — Protección de rutas y logs de sistema activos.',
            permissionOverwrites: permisosOverwrites,
        });
    } catch (e) {
        console.error('[Logger] Fallo al crear canal de logs:', e.message);
        return null;
    }
}

// --- FUNCIÓN PRINCIPAL DE LOG ---

async function log(guild, { categoria = 'general', titulo, descripcion, campos = [], usuario, error }) {
    if (!guild) return;

    try {
        const configServidor = obtenerConfigServidor(guild.id);
        if (!configServidor.activo || !configServidor.categorias[categoria]) return;

        const canal = await obtenerCanalLog(guild);
        
        // CORRECCIÓN CRÍTICA: Verificamos si el canal existe antes de intentar enviar
        if (!canal) return;

        const embed = new EmbedBuilder()
            .setTitle(`${EMOJIS[categoria] || '⚙️'} ${titulo}`)
            .setDescription(descripcion || 'Sin descripción disponible.')
            .setColor(COLORS[categoria] || COLORS.general)
            .setTimestamp()
            .setFooter({ text: 'VitaBot Shield 🔨 — Logs Sanitizados' });

        if (usuario) {
            embed.setAuthor({
                name: usuario.tag,
                iconURL: usuario.displayAvatarURL({ dynamic: true })
            });
        }

        if (campos.length > 0) embed.addFields(campos);

        if (error) {
            const errorLimpio = sanitizeErrorMessage(error);
            embed.addFields({ 
                name: '❌ Detalle Técnico (Sanitizado)', 
                value: `\`\`\`${errorLimpio.substring(0, 1024)}\`\`\`` 
            });
        }

        await canal.send({ embeds: [embed] }).catch(err => console.error('[Logger] Error al enviar mensaje:', err.message));
    } catch(e) {
        console.error('[Logger Critical Error]:', e.message);
    }
}

module.exports = { 
    log, 
    obtenerConfigServidor, 
    actualizarConfigServidor,
    obtenerCanalLog,
    sanitizeErrorMessage 
};