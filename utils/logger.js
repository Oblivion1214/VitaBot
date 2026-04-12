// utils/logger.js — Sistema de auditoría de VitaBot
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

// Categoría de cada comando
const CATEGORIAS_COMANDOS = {
    play: 'musica',
    stop: 'musica',
    clear: 'moderacion',
    roles: 'moderacion',
    chatconvita: 'general',
    gacha: 'general',
    ping: 'general',
    ppt: 'general',
    bola8: 'general',
};

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
        // Por defecto todas las categorías activas
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

// --- CANAL DE LOGS ---

async function obtenerCanalLog(guild) {
    const canalExistente = guild.channels.cache.find(
        c => c.name === LOG_CHANNEL_NAME && c.type === ChannelType.GuildText
    );
    if (canalExistente) return canalExistente;

    const permisosOverwrites = [
        { id: guild.roles.everyone.id, deny: [PermissionFlagsBits.ViewChannel] }
    ];

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

    const canal = await guild.channels.create({
        name: LOG_CHANNEL_NAME,
        type: ChannelType.GuildText,
        topic: '📋 Registro de auditoría de VitaBot — Solo visible para administradores y moderadores.',
        permissionOverwrites: permisosOverwrites,
    });

    await canal.send({
        embeds: [
            new EmbedBuilder()
                .setTitle('📋 Canal de Auditoría Creado')
                .setDescription('Este canal registra automáticamente el uso de comandos y errores del bot.\n\nUsa `/auditoria` para configurar qué categorías auditar.')
                .addFields(
                    { name: `${EMOJIS.musica} Música`, value: 'Comandos de reproducción', inline: true },
                    { name: `${EMOJIS.moderacion} Moderación`, value: 'Comandos de moderación', inline: true },
                    { name: `${EMOJIS.sistema} Sistema`, value: 'Errores y eventos críticos', inline: true },
                    { name: `${EMOJIS.general} General`, value: 'Resto de comandos', inline: true },
                )
                .setColor('#57F287')
                .setTimestamp()
                .setFooter({ text: 'VitaBot Logger 🔨' })
        ]
    });

    return canal;
}

// --- FUNCIÓN PRINCIPAL DE LOG ---

async function log(guild, { categoria = 'general', titulo, descripcion, campos = [], usuario, error, comando }) {
    try {
        const configServidor = obtenerConfigServidor(guild.id);

        // Si la auditoría global está desactivada, salimos
        if (!configServidor.activo) return;

        // Si la categoría está desactivada, salimos
        if (!configServidor.categorias[categoria]) return;

        const canal = await obtenerCanalLog(guild);

        const embed = new EmbedBuilder()
            .setTitle(`${EMOJIS[categoria] || '⚙️'} ${titulo}`)
            .setDescription(descripcion)
            .setColor(COLORS[categoria] || COLORS.general)
            .setTimestamp()
            .setFooter({ text: 'VitaBot Logger 🔨' });

        if (usuario) {
            embed.setAuthor({
                name: usuario.tag,
                iconURL: usuario.displayAvatarURL({ dynamic: true })
            });
        }

        if (campos.length > 0) embed.addFields(campos);

        if (error) {
            embed.addFields({ name: '❌ Error', value: `\`\`\`${error.substring(0, 1000)}\`\`\`` });
        }

        await canal.send({ embeds: [embed] });
    } catch(e) {
        console.error('[Logger] Error al enviar log:', e.message);
    }
}

module.exports = { log, obtenerConfigServidor, actualizarConfigServidor, CATEGORIAS_COMANDOS };