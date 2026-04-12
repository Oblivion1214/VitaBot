// utils/logger.js — Sistema de auditoría reforzado de VitaBot
const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');

const LOG_CHANNEL_NAME = 'vitabot-logs';
const CONFIG_PATH = path.join(__dirname, '../audit-config.json');

// Colores por categoría
const COLORS = {
    musica: '#FF9900',
    moderacion: '#5865F2',
    sistema: '#ED4245',
    general: '#57F287',
};

// Emojis por categoría
const EMOJIS = {
    musica: '🎵',
    moderacion: '🛡️',
    sistema: '🚨',
    general: '⚙️',
};

// --- UTILIDADES DE SEGURIDAD ---

/**
 * Elimina rutas locales (C:\Users\... o /home/...) de los mensajes de error
 * para evitar fugas de información del servidor.
 */
function sanitizeErrorMessage(message) {
    if (!message) return 'Error desconocido';
    // Regex para detectar patrones de rutas en Windows y Linux
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
    fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
}

function obtenerConfigServidor(guildId) {
    const config = cargarConfig();
    if (!config[guildId]) {
        config[guildId] = {
            activo: true,
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
    const canalExistente = guild.channels.cache.find(
        c => c.name === LOG_CHANNEL_NAME && c.type === ChannelType.GuildText
    );
    if (canalExistente) return canalExistente;

    const permisosOverwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
    ];

    // Solo roles con permisos de gestión pueden ver el canal
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
}

// --- FUNCIÓN PRINCIPAL DE LOG ---

/**
 * Envía un log al canal de auditoría con sanitización automática.
 */
async function log(guild, { categoria = 'general', titulo, descripcion, campos = [], usuario, error }) {
    try {
        const configServidor = obtenerConfigServidor(guild.id);
        if (!configServidor.activo || !configServidor.categorias[categoria]) return;

        const canal = await obtenerCanalLog(guild);

        const embed = new EmbedBuilder()
            .setTitle(`${EMOJIS[categoria] || '⚙️'} ${titulo}`)
            .setDescription(descripcion)
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

        // APLICACIÓN DE SEGURIDAD: Sanitizamos el error antes de mostrarlo
        if (error) {
            const errorLimpio = sanitizeErrorMessage(error);
            embed.addFields({ 
                name: '❌ Detalle Técnico (Sanitizado)', 
                value: `\`\`\`${errorLimpio.substring(0, 1000)}\`\`\`` 
            });
        }

        await canal.send({ embeds: [embed] });
    } catch(e) {
        // En caso de error en el logger, usamos la consola para no entrar en bucle
        console.error('[Logger Critical Error]:', e.message);
    }
}

module.exports = { 
    log, 
    obtenerConfigServidor, 
    actualizarConfigServidor,
    sanitizeErrorMessage // Exportamos por si necesitas usarla en otros archivos
};