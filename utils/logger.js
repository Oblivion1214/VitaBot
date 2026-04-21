// utils/logger.js — Sistema de auditoría v4.0 (Sin permisos de Admin)
const { EmbedBuilder, PermissionFlagsBits, ChannelType } = require('discord.js');
const fs = require('fs');
const path = require('path');

const LOG_CHANNEL_NAME = 'vitabot-logs';
const CONFIG_PATH = path.join(__dirname, '../config/audit-config.json');

const COLORS = {
    musica:      '#FF9900',
    moderacion:  '#5865F2',
    sistema:     '#ED4245',
    general:     '#57F287',
    seguridad:   '#FFA500',
};

const EMOJIS = {
    musica:      '🎵',
    moderacion:  '🛡️',
    sistema:     '🚨',
    general:     '⚙️',
    seguridad:   '🔒',
};

// ─────────────────────────────────────────────
// SEGURIDAD: sanitizar rutas del sistema en mensajes de error
// ─────────────────────────────────────────────
function sanitizeErrorMessage(message) {
    if (!message) return 'Error desconocido';
    const pathRegex = /([a-zA-Z]:\\(?:[^\\\s]+\\)+|(?:\/[^/\s]+)+\/)/g;
    return message.replace(pathRegex, '[RUTA_PROTEGIDA]/');
}

/**
 * Registra el ID del mensaje de setup para poder invalidarlo después.
 */
function registrarMensajeSetup(guildId, messageId, channelId = null) {
    const config = cargarConfig();
    if (config[guildId]) {
        config[guildId]._setupMessageRef = { messageId, channelId };
        guardarConfig(config);
    }
}

/**
 * Edita el mensaje de bienvenida original para cerrarlo si se configuró por otro medio.
 */
async function invalidarPanelSetup(client, guildId) {
    const config = obtenerConfigServidor(guildId);
    if (config._setupMessageRef) {
        try {
            const { messageId, channelId } = config._setupMessageRef;
            let canal;
            
            if (channelId) {
                canal = await client.channels.fetch(channelId).catch(() => null);
            } else {
                const guild = client.guilds.cache.get(guildId);
                const owner = await guild.fetchOwner();
                canal = owner.dmChannel || await owner.createDM();
            }

            if (canal) {
                const msg = await canal.messages.fetch(messageId).catch(() => null);
                if (msg) {
                    await msg.edit({
                        content: '🛑 **Este panel ha sido invalidado.** La configuración se realizó mediante el comando maestro `/config`.',
                        embeds: [],
                        components: []
                    });
                    console.log(`[Rastreo Logger] Panel de bienvenida invalidado en ${guildId}.`);
                }
            }
        } catch (e) {
            console.error(`[Logger] No se pudo invalidar el panel: ${e.message}`);
        }
        actualizarConfigServidor(guildId, { _setupMessageRef: null });
    }
}

// ─────────────────────────────────────────────
// GESTIÓN DE CONFIGURACIÓN (audit-config.json)
// ─────────────────────────────────────────────
function cargarConfig() {
    try {
        if (!fs.existsSync(CONFIG_PATH)) return {};
        return JSON.parse(fs.readFileSync(CONFIG_PATH, 'utf-8'));
    } catch {
        return {};
    }
}

function guardarConfig(config) {
    try {
        // Asegurarse de que el directorio /config existe
        const dir = path.dirname(CONFIG_PATH);
        if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
        fs.writeFileSync(CONFIG_PATH, JSON.stringify(config, null, 2), 'utf-8');
    } catch (e) {
        console.error('[Logger] Error al escribir audit-config.json:', e.message);
    }
}

/**
 * Obtiene la config de un servidor. Si no existe, la crea con defaults.
 * Guarda el nombre del servidor para identificar cada entrada en el JSON.
 */
function obtenerConfigServidor(guildId, idiomaDefecto = 'es', guildName = null) {
    const config = cargarConfig();
    if (!config[guildId]) {
        config[guildId] = {
            guildName:      guildName || guildId, // ← nombre legible del servidor
            activo:         true,
            idioma:         idiomaDefecto,
            canalLogId:     null,  // null = crear canal propio; ID = canal elegido por admin
            canalLogMode:   'auto', // 'auto' | 'custom'
            categorias: {
                musica:      true,
                moderacion:  true,
                general:     true,
                sistema:     true,
                seguridad:   true,
            }
        };
        guardarConfig(config);
    } else if (guildName && config[guildId].guildName !== guildName) {
        // Actualizar nombre si el servidor cambió de nombre
        config[guildId].guildName = guildName;
        guardarConfig(config);
    }
    return config[guildId];
}

function actualizarConfigServidor(guildId, nuevaConfig, guildName = null) {
    const config = cargarConfig();
    const actual = obtenerConfigServidor(guildId, 'es', guildName);
    config[guildId] = { ...actual, ...nuevaConfig };
    if (guildName) config[guildId].guildName = guildName;
    guardarConfig(config);
}

// ─────────────────────────────────────────────
// OBTENER CANAL DE LOG
// Sin permisos de Admin: no intentamos crear overwrites de roles.
// Solo bot + owner tienen acceso al canal creado por nosotros.
// Si el admin eligió un canal existente, lo usamos directamente.
// ─────────────────────────────────────────────
async function obtenerCanalLog(guild) {
    if (!guild) return null;
    const config = obtenerConfigServidor(guild.id, 'es', guild.name);
    const me = guild.members.me;
    console.log(`[Rastreo Logger] Verificando canal de logs para "${guild.name}"...`);

    if (config.canalLogId) {
        let canalElegido = guild.channels.cache.get(config.canalLogId);

        // Si no está en caché, intentamos buscarlo directamente en la API de Discord
        if (!canalElegido) {
            console.log(`[Logger] Canal ${config.canalLogId} no encontrado en caché, intentando fetch...`);
            canalElegido = await guild.channels.fetch(config.canalLogId).catch(() => null);
        }

        if (canalElegido) {
            const permisos = canalElegido.permissionsFor(me);
            // Validación extendida de permisos para evitar fallos en canales privados
            if (!permisos.has([PermissionFlagsBits.ViewChannel, PermissionFlagsBits.SendMessages, PermissionFlagsBits.EmbedLinks])) {
                console.warn(`[Logger] FALLO DE PERMISOS en #${canalElegido.name} (${guild.name}).`);
                const systemChan = guild.systemChannel || guild.channels.cache.find(c => c.permissionsFor(me).has(PermissionFlagsBits.SendMessages));
                if (systemChan) {
                    await systemChan.send(`🚨 **Error de Configuración:** No tengo acceso al canal <#${canalElegido.id}>. Por favor, añádeme a sus permisos.`).catch(() => null);
                }
                return null;
            }
            return canalElegido;
        } else {
            // Si el fetch falla (canal borrado), reseteamos la config para evitar bucles
            console.warn(`[Logger] El canal configurado (${config.canalLogId}) parece haber sido borrado en "${guild.name}". Reseteando a auto.`);
            actualizarConfigServidor(guild.id, { canalLogId: null, canalLogMode: 'auto' }, guild.name);
        }
    }

    // 2. Modo auto: buscar canal existente 'vitabot-logs'
    const canalExistente = guild.channels.cache.find(c => c.name === LOG_CHANNEL_NAME && c.type === ChannelType.GuildText);
    if (canalExistente) {
        console.log(`[Logger] Canal automático encontrado: #${LOG_CHANNEL_NAME}`);
        return canalExistente;
    }

    // 3. Crear canal propio. Con los permisos limitados (ManageChannels)
    //    NO podemos crear overwrites de roles — eso requiere ManageRoles.
    //    Solo añadimos overwrite para el bot mismo.
    if (!guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels)) {
        console.error(`[Logger] Sin permiso ManageChannels en "${guild.name}". No puedo crear el canal de logs.`);
        return null;
    }

    try {
        // 1. Filtrar roles de moderación (quienes tengan Gestionar Mensajes o Administrador)
        const rolesModeradores = guild.roles.cache.filter(role => 
            role.permissions.has([PermissionFlagsBits.ManageMessages]) || 
            role.permissions.has([PermissionFlagsBits.Administrator])
        );

        const permisosOverwrites = [
            // BLOQUEO CRÍTICO: Esto activa el modo "Canal Privado" en la UI de Discord
            {
                id: guild.roles.everyone.id,
                deny: [PermissionFlagsBits.ViewChannel]
            },
            // PERMISOS DEL BOT: Vita necesita ver, escribir y mandar embeds
            {
                id: guild.members.me.id,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.EmbedLinks,
                    PermissionFlagsBits.ReadMessageHistory
                ]
            },
            // PERMISOS DEL DUEÑO: Siempre debe tener acceso al canal de logs
            {
                id: guild.ownerId,
                allow: [
                    PermissionFlagsBits.ViewChannel,
                    PermissionFlagsBits.SendMessages,
                    PermissionFlagsBits.ReadMessageHistory
                ]
            }
        ];

        // DAR ACCESO A MODERADORES: Se añaden dinámicamente según sus roles
        rolesModeradores.forEach(role => {
            permisosOverwrites.push({
                id: role.id,
                allow: [PermissionFlagsBits.ViewChannel, PermissionFlagsBits.ReadMessageHistory]
            });
        });

        console.log(`[Logger] Creando canal PRIVADO #${LOG_CHANNEL_NAME} en "${guild.name}"`);

        return await guild.channels.create({
            name: LOG_CHANNEL_NAME,
            type: ChannelType.GuildText,
            topic: '📋 Auditoría Privada de VitaBot — Solo personal autorizado.',
            permissionOverwrites: permisosOverwrites,
        });

    } catch (e) {
        console.error('[Logger] Fallo al crear canal privado:', sanitizeErrorMessage(e.message));
        return null;
    }
}

// ─────────────────────────────────────────────
// FUNCIÓN PRINCIPAL DE LOG
// ─────────────────────────────────────────────
async function log(guild, { categoria = 'general', titulo, descripcion, campos = [], usuario, error, componentes = [] }) {
    if (!guild) return;

    try {
        const configServidor = obtenerConfigServidor(guild.id, 'es', guild.name);
        if (!configServidor.activo || !configServidor.categorias?.[categoria]) return;

        const canal = await obtenerCanalLog(guild);
        if (!canal) return;

        const embed = new EmbedBuilder()
            .setTitle(`${EMOJIS[categoria] ?? '⚙️'} ${titulo}`)
            .setDescription(descripcion || 'Sin descripción disponible.')
            .setColor(COLORS[categoria] ?? COLORS.general)
            .setTimestamp()
            .setFooter({ text: 'VitaBot Shield 🔨 — Logs Sanitizados' });

        if (usuario) {
            embed.setAuthor({
                name: usuario.tag ?? usuario.username,
                iconURL: usuario.displayAvatarURL?.({ dynamic: true })
            });
        }

        if (campos.length > 0) embed.addFields(campos);

        if (error) {
            embed.addFields({
                name: '❌ Detalle Técnico (Sanitizado)',
                value: `\`\`\`${sanitizeErrorMessage(error).substring(0, 1000)}\`\`\``
            });
        }

        return await canal.send({
            embeds: [embed],
            components: componentes
        }).catch(err => console.error('[Logger] Error al enviar mensaje:', err.message));

    } catch (e) {
        console.error('[Logger Critical Error]:', e.message);
    }
}

module.exports = {
    log,
    obtenerConfigServidor,
    actualizarConfigServidor,
    obtenerCanalLog,
    sanitizeErrorMessage,
    registrarMensajeSetup, // ← Exportado
    invalidarPanelSetup
};