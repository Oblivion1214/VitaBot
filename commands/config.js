// commands/config.js — Panel Maestro de Configuración v4.0
const {
    SlashCommandBuilder, PermissionFlagsBits, MessageFlags,
    EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder,
    ButtonBuilder, ButtonStyle, ChannelType
} = require('discord.js');
const { obtenerConfigServidor, actualizarConfigServidor, invalidarPanelSetup, obtenerCanalLog } = require('../utils/logger');
const { enviarMensajeBienvenidaLog } = require('../utils/guildSetup');

const i18nConfig = {
    es: {
        title:       '⚙️ Configuración de VitaBot',
        desc:        'Gestiona los módulos de auditoría, el canal de logs y el idioma.',
        save_btn:    '💾 Guardar Cambios',
        lang_btn:    'Switch to English 🇺🇸',
        canal_label: '📋 Canal de Logs Actual',
        canal_btn:   '📋 Cambiar Canal de Logs',
        success:     '✅ Configuración guardada correctamente.',
        footer:      'Vita Laboratory System 🔨 — Expira en 2 min',
        chan_select:  'Elige el nuevo canal de logs...',
        own_channel: '📁 Usar canal propio (vitabot-logs)',
        chan_saved:  '✅ Canal de logs actualizado.',
        perm_error:  '🔒 **Error de Acceso:** El canal es privado y no tengo permisos. Añade mi rol en Ajustes del Canal > Permisos > Añadir miembros o roles > Rol **Vita-Bot** y Miembro **Vita-Bot** para continuar.'
    },
    en: {
        title:       '⚙️ VitaBot Configuration',
        desc:        'Manage audit modules, log channel and system language.',
        save_btn:    '💾 Save Changes',
        lang_btn:    'Cambiar a Español 🇲🇽',
        canal_label: '📋 Current Log Channel',
        canal_btn:   '📋 Change Log Channel',
        success:     '✅ Configuration saved successfully.',
        footer:      'Vita Laboratory System 🔨 — Expires in 2 min',
        chan_select:  'Choose the new log channel...',
        own_channel: '📁 Use own channel (vitabot-logs)',
        chan_saved:  '✅ Log channel updated.',
        perm_error: '🔒 **Access Error:** The channel is private and I dont have permission. Please add my role in Channel Settings > Permissions > Add members or roles > **Vita-Bot** role and **Vita-Bot** member to continue.'
    }
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config')
        .setDescription('Panel central de configuración de VitaBot')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        let config = obtenerConfigServidor(interaction.guild.id, 'es', interaction.guild.name);
        let lang   = config.idioma || 'es';

        // ── Construir select de categorías ───────────────────────────────
        const crearMenuCategorias = (conf, l) => new StringSelectMenuBuilder()
            .setCustomId('cfg_categorias')
            .setPlaceholder(l === 'es' ? 'Módulos activos...' : 'Active modules...')
            .setMinValues(0)
            .setMaxValues(5)
            .addOptions([
                { label: '🎵 Música',              value: 'musica',     default: conf.categorias.musica },
                { label: '🛡️ Moderación',          value: 'moderacion', default: conf.categorias.moderacion },
                { label: '⚙️ General',             value: 'general',    default: conf.categorias.general },
                { label: '🚨 Sistema',             value: 'sistema',    default: conf.categorias.sistema },
                { label: '📡 Seguridad (Antivirus)', value: 'seguridad', default: conf.categorias.seguridad },
            ]);

        // ── Construir menú de selección de canal ─────────────────────────
        const crearMenuCanal = (l) => {
            const canales = interaction.guild.channels.cache
                .filter(c =>
                    c.type === ChannelType.GuildText &&
                    c.permissionsFor(interaction.guild.members.me)?.has(PermissionFlagsBits.SendMessages)
                )
                .sort((a, b) => a.position - b.position)
                .first(24);

            return new StringSelectMenuBuilder()
                .setCustomId('cfg_canal')
                .setPlaceholder(i18nConfig[l].chan_select)
                .addOptions([
                    {
                        label:       i18nConfig[l].own_channel,
                        description: 'El bot creará/usará #vitabot-logs',
                        value:       'CREATE_OWN',
                        emoji:       '📁'
                    },
                    ...canales.map(c => ({
                        label:       `#${c.name}`.substring(0, 100),
                        description: c.topic?.substring(0, 100) || 'Sin descripción',
                        value:       c.id,
                        emoji:       '💬'
                    }))
                ]);
        };

        // ── Construir componentes completos del panel ─────────────────────
        const crearComponentes = (conf, l) => [
            new ActionRowBuilder().addComponents(crearMenuCategorias(conf, l)),
            new ActionRowBuilder().addComponents(crearMenuCanal(l)),
            new ActionRowBuilder().addComponents(
                new ButtonBuilder()
                    .setCustomId(`cfg_lang_${l === 'es' ? 'en' : 'es'}`)
                    .setLabel(i18nConfig[l].lang_btn)
                    .setStyle(ButtonStyle.Secondary),
                new ButtonBuilder()
                    .setCustomId('cfg_guardar')
                    .setLabel(i18nConfig[l].save_btn)
                    .setStyle(ButtonStyle.Primary)
            )
        ];

        const construirEmbed = (conf, l) => {
            const t      = i18nConfig[l];
            const estado = conf.activo ? '🟢 ON' : '🔴 OFF';
            const canalLog = conf.canalLogId
                ? `<#${conf.canalLogId}>`
                : '`vitabot-logs` (canal propio)';

            return new EmbedBuilder()
                .setTitle(t.title)
                .setDescription(`${t.desc}\n\n**Estado:** ${estado}\n**Idioma:** \`${l.toUpperCase()}\``)
                .addFields(
                    { name: t.canal_label,     value: canalLog,                                     inline: false },
                    { name: '🎵 Música',        value: conf.categorias.musica      ? '✅' : '❌',    inline: true },
                    { name: '🛡️ Moderación',    value: conf.categorias.moderacion  ? '✅' : '❌',    inline: true },
                    { name: '⚙️ General',        value: conf.categorias.general     ? '✅' : '❌',    inline: true },
                    { name: '🚨 Sistema',        value: conf.categorias.sistema     ? '✅' : '❌',    inline: true },
                    { name: '📡 Seguridad',      value: conf.categorias.seguridad   ? '✅' : '❌',    inline: true },
                )
                .setColor('#FF9900')
                .setFooter({ text: t.footer });
        };

        // ── Respuesta inicial ──────────────────────────────────────────────
        const response = await interaction.reply({
            embeds:     [construirEmbed(config, lang)],
            components: crearComponentes(config, lang),
            flags:      MessageFlags.Ephemeral
        });

        let categoriasTemp = { ...config.categorias };

        const collector = response.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time:   120_000
        });

        collector.on('collect', async i => {
            // Selección de módulos activos
            if (i.customId === 'cfg_categorias') {
                categoriasTemp = {
                    musica:      i.values.includes('musica'),
                    moderacion:  i.values.includes('moderacion'),
                    general:     i.values.includes('general'),
                    sistema:     i.values.includes('sistema'),
                    seguridad:   i.values.includes('seguridad'),
                };
                console.log(`[Config] "${interaction.guild.name}": Categorías seleccionadas: ${i.values.join(', ')}`);
                await i.deferUpdate();
                return;
            }

            // Cambio de canal de logs
            if (i.customId === 'cfg_canal') {
                const valor = i.values[0];
                if (valor !== 'CREATE_OWN') {
                    const canalObj = interaction.guild.channels.cache.get(valor);
                    const permisos = canalObj?.permissionsFor(interaction.guild.members.me);
                    
                    const tienePermisos = permisos?.has([
                        PermissionFlagsBits.ViewChannel,
                        PermissionFlagsBits.SendMessages,
                        PermissionFlagsBits.EmbedLinks
                    ]);

                    if (!tienePermisos) {
                        console.warn(`[Config] Intento de asignación sin permisos en "${interaction.guild.name}". Bloqueando panel.`);
                        const text = i18nConfig[lang].perm_error || i18nConfig['es'].perm_error;
                        return i.update({
                            content: text,
                            embeds: [], components: [],
                            flags: MessageFlags.Ephemeral
                        }).catch(() => null);
                    }
                }

                const updates = valor === 'CREATE_OWN' 
                    ? { canalLogId: null, canalLogMode: 'auto' } 
                    : { canalLogId: valor, canalLogMode: 'custom' };

                actualizarConfigServidor(interaction.guild.id, updates, interaction.guild.name);
                config = obtenerConfigServidor(interaction.guild.id, lang, interaction.guild.name);

                // Notificar al nuevo canal de logs que ahora es el destino de auditoría
                const canalNuevo = valor === 'CREATE_OWN'
                    ? await obtenerCanalLog(interaction.guild)
                    : interaction.guild.channels.cache.get(valor);

                if (canalNuevo) {
                    await enviarMensajeBienvenidaLog(canalNuevo, interaction.guild, interaction.user);
                }

                await i.update({ embeds: [construirEmbed(config, lang)], components: crearComponentes(config, lang) });
                await i.followUp({ content: i18nConfig[lang].chan_saved, flags: MessageFlags.Ephemeral });
                return;
            }

            // Cambio de idioma
            if (i.customId.startsWith('cfg_lang_')) {
                lang = i.customId.split('_')[2];
                actualizarConfigServidor(interaction.guild.id, { idioma: lang }, interaction.guild.name);
                config = obtenerConfigServidor(interaction.guild.id, lang, interaction.guild.name);
                await i.update({ embeds: [construirEmbed(config, lang)], components: crearComponentes(config, lang) });
            }

            // Guardar cambios
            if (i.customId === 'cfg_guardar') {
                actualizarConfigServidor(interaction.guild.id, { 
                    categorias: categoriasTemp,
                    _setupCompleto: true 
                }, interaction.guild.name);

                // Invalidar panel de bienvenida por DM/canal si aún estaba activo.
                // Pasamos interaction.client AQUÍ (dentro del collect) para asegurar
                // que el cliente aún está disponible cuando se llama.
                await invalidarPanelSetup(interaction.client, interaction.guild.id).catch(() => null);

                // Cerrar el panel efímero completamente: sin embed, sin componentes,
                // con mensaje de confirmación. Más limpio que dejar el panel ahí sin botones.
                await i.update({
                    content: i18nConfig[lang].success,
                    embeds:  [],
                    components: []
                });
                // followUp ya no es necesario porque el update ya muestra el mensaje de éxito
            }
        });

        collector.on('end', (_, reason) => {
            // Si el panel expiró sin guardar (timeout de 2 min), editar con mensaje informativo
            // en lugar de dejarlo con el embed vacío y sin botones.
            if (reason === 'time') {
                interaction.editReply({
                    content: '⏰ El panel de configuración expiró. Usa `/config` nuevamente si necesitas hacer cambios.',
                    embeds:     [],
                    components: []
                }).catch(() => null);
            }
        });
    },
};