// utils/guildSetup.js — VitaBot v4.0
// Protocolo de bienvenida con selección de canal de logs y sin requerir Admin

const {
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle,
    StringSelectMenuBuilder, ChannelType, PermissionFlagsBits,
    MessageFlags
} = require('discord.js');
const { log, obtenerConfigServidor, actualizarConfigServidor, obtenerCanalLog, registrarMensajeSetup } = require('./logger');

// ─────────────────────────────────────────────
// TRADUCCIONES
// ─────────────────────────────────────────────
const i18n = {
    es: {
        welcome_title:   '✨ Vita Graf Eisen: Conectada',
        welcome_desc:    '¡Hola! Soy un sistema multifunción enfocado en **audio Hi-Fi** y auditoría de seguridad.',
        kbps_advice:     '💡 **Tip:** Para audio Hi-Fi, sube el bitrate de los canales de voz a 96kbps o más si tienes Server Boost.',
        channel_prompt:  '📋 **¿Dónde quieres que envíe los logs de auditoría?**\nElige un canal existente de la lista, o selecciona **"Crear canal propio (vitabot-logs)"** para que yo cree uno.',
        setup_button:    'Confirmar Canal y Activar',
        lang_button:     'Change to English 🇺🇸',
        cancel_button:   'Abandonar',
        channel_select:  'Elige el canal de logs...',
        own_channel:     '📁 Crear canal propio (vitabot-logs)',
        own_channel_desc:'El bot creará un canal #vitabot-logs',
        no_perms:        '⚠️ No tengo permiso para crear canales. Por favor elige un canal existente.',
        timeout_warn:    '⚠️ **Acción Requerida:** Si no hay respuesta en 10 min, me retiraré.'
    },
    en: {
        welcome_title:   '✨ Vita Graf Eisen: Connected',
        welcome_desc:    'Hello! I am a multi-function system focused on **Hi-Fi audio** and security auditing.',
        kbps_advice:     '💡 **Tip:** For Hi-Fi audio, set voice channel bitrate to 96kbps or higher if you have Server Boost.',
        channel_prompt:  '📋 **Where should I send audit logs?**\nPick an existing channel from the list, or select **"Create own channel (vitabot-logs)"**.',
        setup_button:    'Confirm Channel & Activate',
        lang_button:     'Cambiar a Español 🇲🇽',
        cancel_button:   'Leave',
        channel_select:  'Choose the log channel...',
        own_channel:     '📁 Create own channel (vitabot-logs)',
        own_channel_desc:'The bot will create a #vitabot-logs channel',
        no_perms:        '⚠️ I don\'t have permission to create channels. Please select an existing channel.',
        timeout_warn:    '⚠️ **Action Required:** If no response in 10 min, I will leave.'
    }
};

// ─────────────────────────────────────────────
// REGISTRO DE COLLECTORS ACTIVOS DE SETUP
// Permite que index.js sepa si un collector de guildCreate está vivo
// antes de intentar responder él mismo a los botones del panel.
// Clave: guildId → collector activo
// ─────────────────────────────────────────────
const setupCollectors = new Map();

/**
 * Envía el mensaje de bienvenida/confirmación al canal de logs configurado.
 * Se llama tanto desde el setup inicial como desde /config al cambiar el canal.
 * @param {import('discord.js').TextChannel} canal
 * @param {import('discord.js').Guild} guild
 * @param {import('discord.js').User|null} configuradoPor
 */
async function enviarMensajeBienvenidaLog(canal, guild, configuradoPor = null) {
    const embed = new EmbedBuilder()
        .setTitle('🛡️ Canal de Auditoría Configurado')
        .setDescription(
            `Este canal ha sido designado para recibir los logs de **VitaBot**.\n\n` +
            `**Servidor:** ${guild.name}\n` +
            (configuradoPor ? `**Configurado por:** ${configuradoPor.tag ?? configuradoPor.username}\n` : '') +
            `\nAquí recibirás registros de música, moderación, seguridad y sistema.`
        )
        .setColor('#57F287')
        .setFooter({ text: 'VitaBot Shield 🔨 — Logs Sanitizados' })
        .setTimestamp();

    await canal.send({ embeds: [embed] })
        .catch(e => console.error(`[guildSetup] No pude enviar bienvenida al canal de logs: ${e.message}`));
}

/**
 * Construye el menú de selección de canal con todos los canales de texto visibles
 * para el bot (incluyendo los ocultos a @everyone que el bot sí puede ver).
 */
function construirMenuCanales(guild, lang) {
    // Tomamos hasta 24 canales de texto que el bot pueda ver (límite de Discord: 25 opciones)
    const canalesTexto = guild.channels.cache
        .filter(c =>
            c.type === ChannelType.GuildText &&
            c.permissionsFor(guild.members.me)?.has(PermissionFlagsBits.SendMessages)
        )
        .sort((a, b) => a.position - b.position)
        .first(24);

    const opciones = [
        // Opción especial: crear canal propio
        {
            label: i18n[lang].own_channel,
            description: i18n[lang].own_channel_desc,
            value: 'CREATE_OWN',
            emoji: '📁'
        },
        // Canales existentes del servidor
        ...canalesTexto.map(c => ({
            label: `#${c.name}`.substring(0, 100),
            description: c.topic ? c.topic.substring(0, 100) : 'Sin descripción',
            value: c.id,
            emoji: '💬'
        }))
    ];

    return new StringSelectMenuBuilder()
        .setCustomId('setup_canal_log')
        .setPlaceholder(i18n[lang].channel_select)
        .addOptions(opciones);
}

/**
 * Genera el embed y los componentes del panel de bienvenida.
 */
function generarPanel(lang, guild) {
    const t = i18n[lang];
    const tieneMC = guild.members.me?.permissions.has(PermissionFlagsBits.ManageChannels);

    const embed = new EmbedBuilder()
        .setTitle(t.welcome_title)
        .setDescription(
            `${t.welcome_desc}\n\n` +
            `${t.kbps_advice}\n\n` +
            `${t.channel_prompt}\n\n` +
            (!tieneMC ? `${t.no_perms}\n\n` : '') +
            `${t.timeout_warn}`
        )
        .setColor('#FF9900')
        .setFooter({ text: 'Sistema de Laboratorio VitaBot 🔨' });

    const menuCanales   = construirMenuCanales(guild, lang);
    const rowMenu       = new ActionRowBuilder().addComponents(menuCanales);

    const rowBotones = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`confirm_setup_${guild.id}`)
            .setLabel(t.setup_button)
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
        new ButtonBuilder()
            .setCustomId(`change_lang_${lang === 'es' ? 'en' : 'es'}`)
            .setLabel(t.lang_button)
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`cancel_setup_${guild.id}`)
            .setLabel(t.cancel_button)
            .setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [rowMenu, rowBotones] };
}

// ─────────────────────────────────────────────
// EVENTO: guildCreate
// ─────────────────────────────────────────────
function registrarGuildCreate(client) {
    client.on('guildCreate', async (guild) => {
        console.log(`[Rastreo] » | Vita detectada en: ${guild.name}. Iniciando protocolos.`);

        // 1. ANUNCIO PÚBLICO INDEPENDIENTE (Siempre se manda)
        // Esto soluciona que el mensaje no llegue si el DM es exitoso.
        const canalAnuncio = guild.systemChannel || guild.channels.cache.find(c => 
            c.type === ChannelType.GuildText && 
            c.permissionsFor(guild.members.me).has(PermissionFlagsBits.SendMessages)
        );

        if (canalAnuncio) {
            await canalAnuncio.send({
                content: `✨ **Vita Graf Eisen ha llegado.**\nHe enviado el panel de configuración al Dueño por DM. Si no responde, cualquier Admin puede usar \`/config\` para activarme.`
            }).catch(e => console.error(`[Error Rastreo] Anuncio fallido en ${guild.name}: ${e.message}`));
        }

        // 2. Idioma y Configuración inicial
        const sugerenciaLang = guild.preferredLocale?.startsWith('es') ? 'es' : 'en';
        const config = obtenerConfigServidor(guild.id, sugerenciaLang, guild.name);
        let currentLang = (config.idioma === 'es' || config.idioma === 'en') ? config.idioma : sugerenciaLang;

        let canalLogSeleccionado = null;
        let msg = null;
        let envioPorDM = false;

        // 3. Intento de DM al Owner (Panel Privado)
        try {
            const owner = await guild.fetchOwner();
            msg = await owner.send(generarPanel(currentLang, guild));
            envioPorDM = true;
            registrarMensajeSetup(guild.id, msg.id, null); // Registrar mensaje para rastreo
            console.log(`[Rastreo] » | Panel enviado por DM al owner de "${guild.name}".`);
        } catch {
            // Fallback si los DMs están cerrados: usar el canal de anuncio para el panel
            if (canalAnuncio) {
                const owner = await guild.fetchOwner().catch(() => null);
                msg = await canalAnuncio.send({
                    content: `${owner ? `${owner} — ` : ''}⚠️ *No pude enviarte el panel por DM. Responde aquí (solo admins):*`,
                    ...generarPanel(currentLang, guild)
                });
                // FIX: era canalPublico.id (ReferenceError) → canalAnuncio.id
                registrarMensajeSetup(guild.id, msg.id, canalAnuncio.id);
                console.log(`[Rastreo] » | DM bloqueado. Usando canal público para setup en "${guild.name}".`);
            } else {
                console.error(`[Rastreo] » | CRÍTICO: Sin canal ni DM para configurar en "${guild.name}".`);
                return;
            }
        }

        // 4. Timeout de auto-limpieza (10 min)
        const timeout = setTimeout(async () => {
            if (guild.available && msg) {
                console.log(`[Rastreo] » | Tiempo agotado en ${guild.name}. Saliendo.`);
                await msg.edit({ content: '⏰ Tiempo agotado sin respuesta. Vita se retira.', embeds: [], components: [] }).catch(() => null);
                await new Promise(r => setTimeout(r, 1500));
                await guild.leave().catch(() => null);
            }
        }, 10 * 60 * 1000);

        // 5. Collector de interacciones
        const collector = msg.createMessageComponentCollector({
            filter: async (i) => {
                if (envioPorDM) return true;
                const esAdmin = i.member?.permissions.has(PermissionFlagsBits.Administrator);
                if (!esAdmin) {
                    await i.reply({
                        content: currentLang === 'es' ? '⛔ Solo los administradores pueden configurar a Vita.' : '⛔ Only administrators can configure Vita.',
                        flags: MessageFlags.Ephemeral
                    }).catch(() => null);
                    return false;
                }
                return true;
            },
            time: 10 * 60 * 1000
        });

        // Registrar el collector activo para que index.js no interfiera.
        // Se indexa por DOS claves:
        //   - guild.id: para interacciones desde canal público (guildId disponible)
        //   - msg.id:   para interacciones desde DM (guildId es null, solo messageId está disponible)
        setupCollectors.set(guild.id, collector);
        setupCollectors.set(msg.id, collector);

        collector.on('collect', async (interaction) => {
            try {
                // ── Selección de canal de logs (Validación Persistente) ──
                if (interaction.customId === 'setup_canal_log') {
                    canalLogSeleccionado = interaction.values[0];
                    const t = i18n[currentLang];
                    
                    let tienePermisos = true;
                    let avisoEstado = currentLang === 'es' 
                        ? 'Analizando permisos del canal...' 
                        : 'Analyzing channel permissions...';

                    // 1. Verificación de permisos si no es el modo "Crear Propio"
                    if (canalLogSeleccionado !== 'CREATE_OWN') {
                        const canalObj = guild.channels.cache.get(canalLogSeleccionado);
                        const permisos = canalObj?.permissionsFor(guild.members.me);
                        
                        // Comprobamos permisos críticos: Ver, Hablar y Enlaces
                        tienePermisos = permisos?.has([
                            PermissionFlagsBits.ViewChannel,
                            PermissionFlagsBits.SendMessages,
                            PermissionFlagsBits.EmbedLinks
                        ]);

                        const esPrivado = !canalObj?.permissionsFor(guild.roles.everyone).has(PermissionFlagsBits.ViewChannel);
                        
                        if (esPrivado && !tienePermisos) {
                            avisoEstado = currentLang === 'es'
                                ? `\n\n🔒 **Error de Acceso:** Añade mi rol en Ajustes del Canal > Permisos > Añadir miembros o roles > Rol **Vita-Bot** y Miembro **Vita-Bot** para continuar.`
                                : `\n\n🔒 **Access Error:** The channel is private and I dont have permission. Please add my role in Channel Settings > Permissions > Add members or roles > **Vita-Bot** role and **Vita-Bot** member to continue.`;
                        } else if (esPrivado && tienePermisos) {
                            avisoEstado = currentLang === 'es'
                                ? `\n\n✅ **Canal Privado:** Permisos verificados.`
                                : `\n\n✅ **Private Channel:** Permissions verified.`;
                        } else {
                            avisoEstado = ''; // Limpiamos si es público y todo está bien
                        }
                    }

                    // 2. Generar panel base y filtrar componentes según permisos
                    const panelBase = generarPanel(currentLang, guild);

                    // Si NO tiene permisos, reconstruimos la fila de botones SIN el botón confirmar.
                    // No mutamos .components directamente (es la estructura interna de ActionRowBuilder
                    // en discord.js v14 y no es un array mutable de esa forma).
                    if (!tienePermisos) {
                        const botonesOriginales = panelBase.components[1].components;
                        const botonesFiltrados = botonesOriginales.filter(
                            btn => !btn.data?.custom_id?.startsWith('confirm_setup')
                        );
                        panelBase.components[1] = new ActionRowBuilder().addComponents(botonesFiltrados);
                    }

                    const nombreDisplay = canalLogSeleccionado === 'CREATE_OWN' ? t.own_channel : `<#${canalLogSeleccionado}>`;
                    
                    // 3. ACTUALIZACIÓN PERSISTENTE (interaction.update)
                    // No usamos flags: MessageFlags.Ephemeral para que el owner vea el progreso
                    await interaction.update({
                        content: tienePermisos 
                            ? `✅ **Canal seleccionado:** ${nombreDisplay}. Presiona **"${t.setup_button}"** para finalizar.` 
                            : `⚠️ **Configuración Bloqueada:** ${avisoEstado}`,
                        embeds: panelBase.embeds,
                        components: panelBase.components
                    });
                    return;
                }

                // ── Confirmar setup (Finalización y Auditoría) ──
                if (interaction.customId.startsWith('confirm_setup')) {
                    console.log(`[guildSetup] Configuración confirmada en "${guild.name}" por ${interaction.user.tag}.`);
                    clearTimeout(timeout);

                    // Resolver el canal ANTES de responder a la interacción
                    let canalLog = null;
                    if (canalLogSeleccionado && canalLogSeleccionado !== 'CREATE_OWN') {
                        canalLog = guild.channels.cache.get(canalLogSeleccionado);
                        actualizarConfigServidor(guild.id, {
                            _setupCompleto: true,
                            canalLogId:    canalLogSeleccionado,
                            canalLogMode:  'custom'
                        }, guild.name);
                    } else {
                        canalLog = await obtenerCanalLog(guild);
                        actualizarConfigServidor(guild.id, {
                            _setupCompleto: true,
                            canalLogId:    canalLog?.id ?? null,
                            canalLogMode:  'auto'
                        }, guild.name);
                    }

                    // ⚠️ ORDEN CRÍTICO: update() PRIMERO, stop() DESPUÉS.
                    // collector.stop() dispara on('end') sincrónicamente, lo que elimina
                    // el collector del Map y puede interferir con la respuesta pendiente.
                    await interaction.update({
                        content: `✅ **Sincronización Completada.** Los logs se enviarán a ${canalLog ? `<#${canalLog.id}>` : '`#vitabot-logs`'}.`,
                        embeds: [],
                        components: []
                    });

                    // Ahora sí detenemos el collector — la interacción ya fue respondida
                    collector.stop('confirmed');

                    // Enviar mensaje de bienvenida al canal de logs configurado
                    if (canalLog) {
                        await enviarMensajeBienvenidaLog(canalLog, guild, interaction.user);
                    }
                    return;
                }

                // ── Cambiar idioma (Actualización de Panel) ──
                if (interaction.customId.startsWith('change_lang')) {
                    currentLang = interaction.customId.split('_')[2];
                    actualizarConfigServidor(guild.id, { idioma: currentLang }, guild.name);
                    await interaction.update(generarPanel(currentLang, guild));
                    return;
                }

                // ── Abandonar (Cierre de proceso) ──
                if (interaction.customId.startsWith('cancel_setup')) {
                    clearTimeout(timeout);

                    // ⚠️ ORDEN CRÍTICO: update() PRIMERO, stop() DESPUÉS.
                    await interaction.update({
                        content: '👋 Operación cancelada. Vita se retira del servidor.',
                        embeds: [],
                        components: []
                    });

                    collector.stop('cancelled');

                    // Delay para que Discord procese el mensaje antes de que el bot salga
                    await new Promise(r => setTimeout(r, 1500));
                    await guild.leave().catch(() => null);
                }

            } catch (e) {
                console.error(`[guildSetup] Error crítico en collector:`, e.message);
            }
        });

        collector.on('end', async (_, reason) => {
            // Limpiar AMBAS entradas del Map al terminar
            setupCollectors.delete(guild.id);
            setupCollectors.delete(msg.id);

            if (reason !== 'confirmed' && reason !== 'cancelled') {
                console.log(`» | Collector cerrado (${reason}) en ${guild.name}.`);
                if (msg) {
                    await msg.edit({ components: [] }).catch(() => null);
                }
            }
        });
    });
}

// ─────────────────────────────────────────────
// RECONCILIACIÓN AL ARRANCAR
// ─────────────────────────────────────────────
async function reconciliarServidores(client) {
    console.log(`» | Reconciliando ${client.guilds.cache.size} servidor(es)...`);

    for (const guild of client.guilds.cache.values()) {
        const config = obtenerConfigServidor(guild.id, 'es', guild.name);
        if (config._setupCompleto) continue;

        console.log(`» | [Reconciliación] Re-enviando bienvenida a "${guild.name}".`);
        client.emit('guildCreate', guild);

        // Delay entre servidores para no saturar la API de Discord con múltiples
        // creaciones de canal simultáneas si el bot está en varios servidores sin setup.
        await new Promise(r => setTimeout(r, 2000));
    }

    console.log('» | Reconciliación completa.');
}

module.exports = { registrarGuildCreate, reconciliarServidores, setupCollectors, enviarMensajeBienvenidaLog };