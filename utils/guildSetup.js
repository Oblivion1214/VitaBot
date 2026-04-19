// utils/guildSetup.js — VitaBot
// Protocolo de bienvenida: panel de setup, cambio de idioma y reconciliación de servidores

const { EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle } = require('discord.js');
const { log, obtenerConfigServidor, actualizarConfigServidor, obtenerCanalLog } = require('./logger');

// ─────────────────────────────────────────────
// TRADUCCIONES
// ─────────────────────────────────────────────
const i18n = {
    es: {
        welcome_title: '✨ Vita Graf Eisen: Conectada',
        welcome_desc: '¡Hola! Soy un sistema multifunción enfocado en la **alta fidelidad de audio** y auditoría.',
        kbps_advice: '💡 **Tip de Admin:** Para audio Hi-Fi, sube el bitrate del los canales de voz a 96kbps o superior, siempre y cuando el server tenga Boost.',
        role_advice: '🛡️ **Protocolo de Jerarquía:** El Owner debe mover mi rol (**Vita-bot**) a la parte superior de los ajustes del servidor para que pueda gestionar roles sin restricciones.',
        setup_button: 'Configurar Auditoría',
        lang_button: 'Change to English 🇺🇸'
    },
    en: {
        welcome_title: '✨ Vita Graf Eisen: Connected',
        welcome_desc: 'Hello! I am a multi-function system focused on **High-Fidelity audio** and auditing.',
        kbps_advice: '💡 **Admin Tip:** For Hi-Fi audio, set the bitrate of voice channels to 96kbps or higher, always and when the server has Boost.',
        role_advice: '🛡️ **Hierarchy Protocol:** The Owner must manually move my role (**Vita-bot**) to the top in server settings to allow me to manage roles without restrictions.',
        setup_button: 'Setup Audit Logs',
        lang_button: 'Cambiar a Español 🇲🇽'
    }
};

// ─────────────────────────────────────────────
// GENERADOR DE PANEL
// ─────────────────────────────────────────────

/**
 * Genera el embed y los botones del panel de bienvenida según el idioma.
 * @param {string} lang - 'es' | 'en'
 * @param {string} guildId
 */
function generarPanel(lang, guildId) {
    const embed = new EmbedBuilder()
        .setTitle(i18n[lang].welcome_title)
        .setDescription(
            `${i18n[lang].welcome_desc}\n\n` +
            `${i18n[lang].kbps_advice}\n\n` +
            `${i18n[lang].role_advice}\n\n` +
            `⚠️ **Acción Requerida:** Confirma la configuración. Si no hay respuesta en 10 min, me retiraré para no dejar rastro.`
        )
        .setColor('#FF9900')
        .setFooter({ text: 'Sistema de Laboratorio VitaBot 🔨' });

    const row = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId(`confirm_setup_${guildId}`)
            .setLabel(i18n[lang].setup_button)
            .setStyle(ButtonStyle.Success)
            .setEmoji('✅'),
        new ButtonBuilder()
            .setCustomId(`change_lang_${lang === 'es' ? 'en' : 'es'}`)
            .setLabel(i18n[lang].lang_button)
            .setStyle(ButtonStyle.Secondary),
        new ButtonBuilder()
            .setCustomId(`cancel_setup_${guildId}`)
            .setLabel(lang === 'es' ? 'Abandonar' : 'Leave')
            .setStyle(ButtonStyle.Danger)
    );

    return { embeds: [embed], components: [row] };
}

// ─────────────────────────────────────────────
// EVENTO: guildCreate
// ─────────────────────────────────────────────

/**
 * Registra el evento guildCreate en el cliente.
 * Envía el panel de bienvenida, gestiona idioma, timeout de 10 min y colector de botones.
 * @param {import('discord.js').Client} client
 */
function registrarGuildCreate(client) {
    client.on('guildCreate', async (guild) => {
        console.log(`» | Vita detectada en: ${guild.name}. Iniciando protocolo de bienvenida.`);

        // 1. Detectamos idioma sugerido por Discord como fallback
        const sugerenciaLang = guild.preferredLocale === 'es-ES' ? 'es' : 'en';
        let config = obtenerConfigServidor(guild.id, sugerenciaLang);
        let currentLang = (config.idioma === 'es' || config.idioma === 'en') ? config.idioma : sugerenciaLang;

        // 2. Obtenemos o creamos el canal de logs
        const auditChannel = await obtenerCanalLog(guild);
        if (!auditChannel) {
            console.warn(`» | [guildCreate] Sin permisos de ManageChannels en "${guild.name}". Setup omitido.`);
            return;
        }

        // 3. Enviamos el panel de bienvenida
        const msg = await auditChannel.send(generarPanel(currentLang, guild.id));

        // 4. Temporizador de auto-limpieza (10 minutos)
        const timeout = setTimeout(async () => {
            if (guild.available) {
                console.log(`» | Expulsión automática: Sin respuesta en ${guild.name}.`);
                await auditChannel.delete().catch(() => null);
                await guild.leave().catch(() => null);
            }
        }, 10 * 60 * 1000);

        // 5. Colector de interacciones (solo admins)
        const collector = msg.createMessageComponentCollector({
            filter: (i) => i.member.permissions.has('Administrator'),
            time: 10 * 60 * 1000
        });

        collector.on('collect', async (interaction) => {
            // ── CONFIRMAR SETUP ──
            if (interaction.customId.startsWith('confirm_setup')) {
                clearTimeout(timeout);
                actualizarConfigServidor(guild.id, { _setupCompleto: true });

                await log(guild, {
                    categoria: 'sistema',
                    titulo: 'Sistema Vinculado',
                    descripcion: 'La configuración inicial ha sido completada y guardada en el servidor.',
                    usuario: interaction.user
                });

                await interaction.update({
                    content: '✅ **Configuración finalizada.** El sistema de auditoría y música Hi-Fi está listo.',
                    embeds: [],
                    components: []
                });
                collector.stop();

            // ── CAMBIAR IDIOMA ──
            } else if (interaction.customId.startsWith('change_lang')) {
                const nuevoLang = interaction.customId.split('_')[2];
                actualizarConfigServidor(guild.id, { idioma: nuevoLang });
                await interaction.update(generarPanel(nuevoLang, guild.id));

            // ── ABANDONAR ──
            } else if (interaction.customId.startsWith('cancel_setup')) {
                clearTimeout(timeout);
                console.log(`» | El administrador rechazó a Vita en ${guild.name}.`);
                await auditChannel.delete().catch(() => null);
                await guild.leave().catch(() => null);
            }
        });

        collector.on('end', (collected, reason) => {
            if (reason === 'time' && collected.size === 0) {
                console.log(`» | Colector cerrado por tiempo agotado en ${guild.name}.`);
            }
        });
    });
}

// ─────────────────────────────────────────────
// RECONCILIACIÓN DE SERVIDORES
// ─────────────────────────────────────────────

/**
 * Al arrancar el bot, re-envía el panel de bienvenida a servidores
 * que se unieron durante un downtime (PM2 restart, etc).
 * @param {import('discord.js').Client} client
 */
async function reconciliarServidores(client) {
    console.log(`» | Reconciliando ${client.guilds.cache.size} servidor(es)...`);

    for (const guild of client.guilds.cache.values()) {
        const config = obtenerConfigServidor(guild.id);
        if (config._setupCompleto) continue;

        const canalExistente = guild.channels.cache.find(c => c.name === 'vitabot-logs');
        if (!canalExistente) {
            console.log(`» | [Reconciliación] Re-enviando bienvenida a "${guild.name}".`);
            client.emit('guildCreate', guild);
        }
    }
    console.log(`» | Reconciliación completa.`);
}

module.exports = { registrarGuildCreate, reconciliarServidores };