// index.js — VitaBot
// Punto de entrada: inicialización, carga de comandos y dispatcher de interacciones

// 1. CARGA DE ENTORNO (siempre lo primero)
require('dotenv').config();

// 2. IMPORTACIONES
const { Client, Collection, GatewayIntentBits, MessageFlags, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const fs = require('fs');
const Genius = require('genius-lyrics');
const { log, sanitizeErrorMessage, obtenerConfigServidor } = require('./utils/logger');
const { inicializarPlayer } = require('./utils/musicPlayer');
const { manejarBotonesMusica } = require('./utils/musicButtons');
const { registrarGuildCreate, reconciliarServidores } = require('./utils/guildSetup');
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
    } else if (interaction.isButton() && interaction.customId.startsWith('musica_')) {
        await manejarBotonesMusica(interaction, player);

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
    console.log(`[DEBUG] Enlace detectado de: ${message.author.tag}`); // Debug 1
    const config = obtenerConfigServidor(message.guildId);
    console.log(`[DEBUG] Estado del módulo Seguridad: ${config.categorias.seguridad}`); // Debug 2
    if (!config.categorias.seguridad) return;
    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const links = message.content.match(urlRegex);
    if (!links) return;

    console.log(`[DEBUG] Analizando ${links.length} enlace(s) en el mensaje de ${message.author.tag}...`); // Debug 3

    for (const link of links) {
        try {
            const urlObj = new URL(link);
            const hostname = urlObj.hostname.replace('www.', '');

            // Filtro rápido de Whitelist
            if (dominiosSeguros.some(d => hostname.endsWith(d))) continue;

            const reporte = await escanearEnlace(link);
            if (reporte.detectado) {
                await ejecutarCuarentena(message, reporte);
            }
        } catch (e) {
            console.error('[Security-Shield] Error:', e.message);
        }
    }
});

// 10. ANTI-CRASH GLOBAL
process.on('unhandledRejection', (reason) => {
    console.error('[Anti-Crash] Rechazo no manejado:', reason);
});

process.on('uncaughtException', (err) => {
    console.error('[Anti-Crash] Excepción no capturada:', err);
});

// 11. LOGIN
client.login(process.env.TOKEN);