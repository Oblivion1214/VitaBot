// index.js — VitaBot
// El límite de errores se instala antes del entorno, las dependencias y el login.
const manejoErrores = require('./utils/manejoErrores').instalarManejoErrores();
// 1. CARGA DE ENTORNO
require('dotenv').config({ override: true, quiet: true });
require('./utils/identidadEjecucion').validarIdentidadEjecucion();
const { iniciarSesionSegura, esServidorPermitido, esEntornoPruebas } = require('./utils/identidadEjecucion');

// 2. IMPORTACIONES
const { Client, Collection, GatewayIntentBits, MessageFlags } = require('discord.js');
const fs = require('fs');
const Genius = require('genius-lyrics');
const { log, obtenerConfigServidor } = require('./utils/logger');
const { ServicioMusica } = require('./utils/servicioMusica');
const { vincularInterfazMusica } = require('./utils/interfazMusica');
const { manejarBotonesMusica } = require('./utils/musicButtons');
const { registrarGuildCreate, reconciliarServidores, setupCollectors } = require('./utils/guildSetup');
const { escanearEnlace, ejecutarCuarentena } = require('./utils/linkGuard');
const { manejarRolAutoservicio } = require('./utils/rolesAutoservicio');
const { manejarBotonCuarentena } = require('./utils/cuarentena');
const { iniciarMantenimiento } = require('./utils/mantenimiento');

// 3. CLIENTE
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});
manejoErrores.registrarLimpieza(() => client.destroy());

// 4. GENIUS (letras de canciones)
client.genius = new Genius.Client(process.env.GENIUS_TOKEN);
console.log('» | Motor de letras (Genius SDK) sincronizado.');

// 5. MÚSICA
client.music = new ServicioMusica(client, { maxSessions: esEntornoPruebas() ? 1 : 3 });
manejoErrores.registrarLimpieza(() => client.music.close());
const maintenance = iniciarMantenimiento();
manejoErrores.registrarLimpieza(() => maintenance.close());
vincularInterfazMusica(client.music);
client.on('voiceStateUpdate', (oldState, newState) => {
    if (esServidorPermitido(newState.guild?.id)) client.music.handleVoiceState(oldState, newState);
});

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
    client.user.setActivity(esEntornoPruebas() ? 'Pruebas | /play' : '/play | v4.0', { type: 2 });

    await reconciliarServidores(client);
});

// 9. DISPATCHER DE INTERACCIONES
client.on('interactionCreate', async (interaction) => {
    if (manejoErrores.estaCerrando() || !esServidorPermitido(interaction.guildId)) return;
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
                }).catch(() => manejoErrores.registrarError('interaccion'));
            }
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            await command.execute(interaction);
        } catch {
            manejoErrores.registrarError('comando');

            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Error en comando',
                descripcion: `Falló el comando \`/${interaction.commandName}\`.`,
                usuario: interaction.user,
                error: 'Ocurrió un error interno al ejecutar el comando.',
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
            } catch {
                manejoErrores.registrarError('interaccion');
            }
        }

    // ── BOTONES DE MÚSICA ──
    } else if (interaction.isButton() && (interaction.customId.startsWith('musica_'))) {
        await manejarBotonesMusica(interaction);

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

    } else if (interaction.isButton() && interaction.customId.startsWith('dar_rol_')) {
        await manejarRolAutoservicio(interaction);
    } else if (interaction.isButton() && /^(approve|deny|view)_link_/.test(interaction.customId)) {
        await manejarBotonCuarentena(interaction);
    }
});


// 10. Monitor de Enlaces en Tiempo Real
client.on('messageCreate', async (message) => {
    if (manejoErrores.estaCerrando() || !esServidorPermitido(message.guildId)) return;
    if (!message.guild || message.author.bot || !message.content.includes('http')) return;

    const config = obtenerConfigServidor(message.guildId, 'es', message.guild?.name);
    if (!config.activo || !config.categorias?.seguridad) return;

    const urlRegex = /(https?:\/\/[^\s]+)/g;
    const links = message.content.match(urlRegex);
    if (!links) return;

    for (const link of links) {
        try {

            const reporte = await escanearEnlace(link, { scope: message.guildId });
            if (reporte.detectado) {
                await ejecutarCuarentena(message, reporte);
                break;
            }
        } catch (e) {
            console.warn('[Security-Shield] Enlace no analizable o proveedor no disponible.');
        }
    }
});

// 11. LOGIN: un rechazo tampoco puede exponer el error del proveedor.
iniciarSesionSegura(client).catch(() => manejoErrores.fatal('inicioSesion'));
