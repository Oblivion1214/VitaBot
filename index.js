// index.js — VitaBot
// 1. CARGA DE ENTORNO (siempre lo primero)
require('dotenv').config();

// 2. IMPORTACIONES
const { Client, Collection, GatewayIntentBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const express = require('express'); // <-- AÑADIMOS EXPRESS AQUÍ
const fs = require('fs');
const Genius = require('genius-lyrics');
const { log, sanitizeErrorMessage, obtenerConfigServidor } = require('./utils/logger');
const { inicializarPlayer } = require('./utils/musicPlayer');
const { manejarBotonesMusica } = require('./utils/musicButtons');
const { registrarGuildCreate, reconciliarServidores, setupCollectors } = require('./utils/guildSetup');
const axios = require('axios'); // Para análisis de enlaces en tiempo real
const { escanearEnlace, ejecutarCuarentena, dominiosSeguros } = require('./utils/linkGuard');

// 3. CLIENTE
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// 4. GENIUS (letras de canciones)
client.genius = new Genius.Client(process.env.GENIUS_TOKEN);
console.log('» | Motor de letras (Genius SDK) sincronizado.');

// 5. MÚSICA
const player = inicializarPlayer(client);

// 6. EVENTOS DE SERVIDOR
registrarGuildCreate(client);

// 7. CARGA DE COMANDOS
client.commands = new Collection();
client.cooldowns = new Collection();

const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    client.commands.set(command.data.name, command);
}

// 8. EVENTO: BOT LISTO
client.once('clientReady', async () => {
    console.log(`» | VitaBot encendido como: ${client.user.tag}`);
    console.log(`» | ${client.commands.size} comandos listos.`);
    client.user.setActivity('/play | v3.0 Hi-Fi', { type: 2 });

    await reconciliarServidores(client);
});

// 9. DISPATCHER DE INTERACCIONES
client.on('interactionCreate', async (interaction) => {
    // ── SLASH COMMANDS ──
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        // Manejo de Cooldowns
        const { cooldowns } = client;
        if (!cooldowns.has(command.data.name)) cooldowns.set(command.data.name, new Collection());

        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const cooldownAmount = (command.cooldown ?? 3) * 1000;

        if (timestamps.has(interaction.user.id)) {
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
            if (now < expirationTime) {
                const tiempoVisual = Math.round((expirationTime + 2000) / 1000);
                return interaction.reply({
                    content: `⏳ Vita está recargando Graf Eisen. Espera <t:${tiempoVisual}:R> para usar \`/${command.data.name}\`.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error('[Error de Ejecución]:', error);

            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Error en comando',
                descripcion: `Falló el comando \`/${interaction.commandName}\`.`,
                usuario: interaction.user,
                error: sanitizeErrorMessage(error.message),
            }).catch(() => null);

            const msgError = {
                content: '❌ Mis circuitos mágicos han fallado al ejecutar este comando.',
                flags: MessageFlags.Ephemeral
            };

            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp(msgError);
                } else {
                    await interaction.reply(msgError).catch(() => null);
                }
            } catch (interactionError) {
                console.error('[Anti-Crash] La interacción expiró:', interactionError.message);
            }
        }

    // ── BOTONES DE MÚSICA ──
    } else if (interaction.isButton() && (interaction.customId.startsWith('musica_'))) {
        await manejarBotonesMusica(interaction, player);

    // ── SETUP DE BIENVENIDA (guildCreate): confirm, change_lang, cancel ──
    // ⚠️ IMPORTANTE: estos botones son manejados por el collector de guildSetup.js
    // cuando el bot está activo. El dispatcher global solo debe actuar como FALLBACK
    // si el collector ya no existe (bot reiniciado después del guildCreate).
    //
    // Problema en DMs: interaction.guildId es NULL en mensajes directos.
    // Por eso el Map se indexa por DOS claves en guildSetup.js:
    //   - guild.id   → para interacciones desde canal público
    //   - msg.id     → para interacciones desde DM
    // Aquí buscamos por ambas para cubrir los dos casos.
    } else if (
        interaction.isButton() && (
            interaction.customId.startsWith('confirm_setup_') ||
            interaction.customId.startsWith('change_lang_') ||
            interaction.customId.startsWith('cancel_setup_')
        )
    ) {
        // Buscar collector activo por guildId (canal público) o por messageId (DM)
        const guildId   = interaction.guildId ?? interaction.guild?.id;
        const messageId = interaction.message?.id;
        const hayCollector = setupCollectors.has(guildId) || setupCollectors.has(messageId);

        // Si hay un collector activo, dejarlo manejarlo — no hacer nada aquí
        if (hayCollector) return;

        // Sin collector activo = bot fue reiniciado, el panel es un zombie
        await interaction.reply({
            content: '⚠️ El panel de configuración inicial expiró (el bot fue reiniciado). Usa `/config` para ajustar la configuración.',
            flags: MessageFlags.Ephemeral
        }).catch(() => null);

    // ── BOTONES DE ROLES (NUEVO) ──
    } else if (interaction.isButton() && interaction.customId.startsWith('dar_rol_')) {
        const roleId = interaction.customId.replace('dar_rol_', '');
        const role = interaction.guild.roles.cache.get(roleId);
        const member = interaction.member;

        if (!role) {
            return interaction.reply({ 
                content: '❌ No pude encontrar ese rol en mis registros mágicos.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        try {
            // Lógica de alternancia (Add/Remove)
            if (member.roles.cache.has(roleId)) {
                await member.roles.remove(roleId);
                await interaction.reply({ content: `✅ Te he quitado el rol **${role.name}**.`, flags: MessageFlags.Ephemeral });
            } else {
                await member.roles.add(roleId);
                await interaction.reply({ content: `✅ Ahora tienes el rol **${role.name}**.`, flags: MessageFlags.Ephemeral });
            }

            // Auditoría de moderación
            await log(interaction.guild, {
                categoria: 'moderacion',
                titulo: 'Asignación de Rol Interactiva',
                descripcion: `El usuario ${member.user.tag} ha actualizado su rol: **${role.name}**.`,
                usuario: member.user
            });

        } catch (error) {
            console.error('[Error de Roles]:', error);
            await interaction.reply({ 
                content: '❌ No tengo poder suficiente para gestionar ese rol. ¡Asegúrate de que mi rol esté por encima del que intentas dar!', 
                flags: MessageFlags.Ephemeral 
            });
        }
    }else if (interaction.isButton() && interaction.customId.startsWith('approve_link_')) {
        // Para aprobar, restauramos el mensaje original en el canal y actualizamos el log de auditoría
        try {
            const canalId = interaction.customId.replace('approve_link_', '');
            const canalOriginal = interaction.guild.channels.cache.get(canalId);
            
            // Extraemos los datos del embed que enviamos al log
            const embedLog = interaction.message.embeds[0];
            const contenidoOriginal = embedLog.fields.find(f => f.name === '📝 Contenido Original')?.value;
            const autorOriginal = embedLog.author.name;

            if (canalOriginal && contenidoOriginal) {
                // Re-posteamos el mensaje en el canal original
                await canalOriginal.send({
                    content: `✅ **Mensaje Restaurado:** El enlace enviado por **${autorOriginal}** fue verificado por un moderador.\n\n> ${contenidoOriginal}`
                });

                // Actualizamos el log de auditoría
                await interaction.update({ 
                    content: `✅ **Aprobado:** El mensaje de \`${autorOriginal}\` ha sido restaurado en <#${canalId}>.`, 
                    components: [] 
                });
            } else {
                throw new Error('No se pudo encontrar el canal o el contenido original.');
            }
        } catch (error) {
            console.error('[Security-Shield] Error al restaurar:', error.message);
            await interaction.reply({ content: '❌ Error al intentar restaurar el mensaje.', flags: MessageFlags.Ephemeral });
        }

    } else if (interaction.isButton() && interaction.customId.startsWith('deny_link_')) {
        // Para denegar, simplemente deshabilitamos el log de auditoría
        await interaction.update({ 
            content: '🚨 **Acción Confirmada:** El mensaje malicioso ha sido purgado de los registros activos.', 
            components: [] 
        });
    }
});


// 10. Monitor de Enlaces en Tiempo Real
client.on('messageCreate', async (message) => {
    if (message.author.bot || !message.content.includes('http')) return;

    const config = obtenerConfigServidor(message.guildId, 'es', message.guild?.name);
    if (!config.categorias.seguridad) return;

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const links = message.content.match(urlRegex);
    if (!links) return;

    for (const link of links) {
        console.log(`[Security] Analizando enlace de ${message.author.tag}: ${link}`);
        try {
            const urlObj = new URL(link);
            const hostname = urlObj.hostname.replace('www.', '');
            if (dominiosSeguros.some(d => hostname.endsWith(d))) continue;

            const reporte = await escanearEnlace(link);
            if (reporte.detectado) {
                console.warn(`[Security] MALWARE DETECTADO: ${link} en "${message.guild.name}"`);
                await ejecutarCuarentena(message, reporte);
            }
        } catch (e) {
            console.error('[Security-Shield] Error:', e.message);
        }
    }
});

// 11. ANTI-CRASH GLOBAL
process.on('unhandledRejection', (reason) => {
    console.error('[Anti-Crash] Rechazo no manejado:', reason);
});
process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash] Excepción no capturada:', err);
});

// 12. LOGIN
client.login(process.env.TOKEN);

// ─────────────────────────────────────────────────────────────────
// 13. SERVIDOR DE WEBHOOKS (Escucha a la PC Local para actualizar Paneles)
// ─────────────────────────────────────────────────────────────────
const app = express();
app.use(express.json());

const mensajesActivos = new Map();

app.post('/webhook/track-change', async (req, res) => {
    const { guildId, channelId, track } = req.body;
    
    // 🌟 LOG DE RECEPCIÓN
    console.log(`[Webhook] 📥 Recibido cambio de pista: ${track?.title}`);
    
    if (!guildId || !channelId || !track) return res.status(400).send('Faltan datos');

    try {
        const guild = client.guilds.cache.get(guildId);
        const canal = guild?.channels.cache.get(channelId);
        
        if (!canal) {
            console.warn(`[Webhook] ⚠️ No pude encontrar el canal de texto ${channelId}`);
            return res.status(404).send('Canal no encontrado');
        }

        const msgViejoId = mensajesActivos.get(guildId);
        if (msgViejoId) {
            const msgViejo = await canal.messages.fetch(msgViejoId).catch(() => null);
            if (msgViejo) await msgViejo.edit({ components: [] }).catch(() => null);
        }

        const embed = new EmbedBuilder()
            .setTitle('🎵 Reproduciendo Ahora')
            .setDescription(`**[${track.title}](${track.url})**\nAutor: ${track.author}`)
            .setFooter({ text: 'Motor: 🏠 PC Local (Hi-Fi)' })
            .setColor('#00C853');

        if (track.thumbnail) embed.setThumbnail(track.thumbnail);

        const fila1 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('musica_pausa').setEmoji('⏯️').setStyle(ButtonStyle.Primary),
            new ButtonBuilder().setCustomId('musica_salto').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('musica_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
            new ButtonBuilder().setCustomId('musica_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
            new ButtonBuilder().setCustomId('musica_queue').setEmoji('📜').setStyle(ButtonStyle.Secondary)
        );
        const fila2 = new ActionRowBuilder().addComponents(
            new ButtonBuilder().setCustomId('musica_lyrics').setLabel('Ver Letras').setEmoji('🎤').setStyle(ButtonStyle.Secondary)
        );

        const nuevoMsg = await canal.send({ embeds: [embed], components: [fila1, fila2] });
        mensajesActivos.set(guildId, nuevoMsg.id);
        
        console.log(`[Webhook] ✅ Panel con botones dibujado en Discord.`);
        res.status(200).send('Panel actualizado');
    } catch (error) {
        console.error('[Webhook] 🔴 Error al actualizar panel:', error.message);
        res.status(500).send('Error interno');
    }
});

app.listen(8080, '0.0.0.0', () => {
    console.log('📡 | Receptor de Telemetría (Webhook) escuchando en puerto 8080');
});