// commands/config.js — Panel Maestro de Configuración
const { 
    SlashCommandBuilder, PermissionFlagsBits, MessageFlags, 
    EmbedBuilder, ActionRowBuilder, StringSelectMenuBuilder, ButtonBuilder, ButtonStyle
} = require('discord.js');
const { obtenerConfigServidor, actualizarConfigServidor } = require('../utils/logger');

// Traemos los textos para que el panel también se traduzca
const i18nConfig = {
    es: {
        title: '⚙️ Configuración de VitaBot',
        desc: 'Gestiona los módulos de auditoría y el idioma del sistema.',
        save_btn: '💾 Guardar Cambios',
        lang_btn: 'Switch to English 🇺🇸',
        success: '✅ Configuración guardada correctamente.',
        footer: 'Vita Laboratory System 🔨 — Expira en 2 min'
    },
    en: {
        title: '⚙️ VitaBot Configuration',
        desc: 'Manage audit modules and system language.',
        save_btn: '💾 Save Changes',
        lang_btn: 'Cambiar a Español 🇲🇽',
        success: '✅ Configuration saved successfully.',
        footer: 'Vita Laboratory System 🔨 — Expires in 2 min'
    }
};

module.exports = {
    data: new SlashCommandBuilder()
        .setName('config') // Cambiamos el nombre a algo más universal
        .setDescription('Panel central de configuración de VitaBot')
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageGuild),

    async execute(interaction) {
        let config = obtenerConfigServidor(interaction.guild.id);
        let lang = config.idioma || 'es';

        // Función para reconstruir los componentes según el estado actual
        const crearComponentes = (conf, l) => {
            const menu = new StringSelectMenuBuilder()
                .setCustomId('cfg_categorias')
                .setPlaceholder(l === 'es' ? 'Selecciona categorías...' : 'Select categories...')
                .setMinValues(0)
                .setMaxValues(5)
                .addOptions([
                    { label: '🎵 Música', value: 'musica', default: conf.categorias.musica },
                    { label: '🛡️ Moderación', value: 'moderacion', default: conf.categorias.moderacion },
                    { label: '⚙️ General', value: 'general', default: conf.categorias.general },
                    { label: '🚨 Sistema', value: 'sistema', default: conf.categorias.sistema },
                    { label: '📡 Seguridad (Antivirus)', value: 'seguridad', default: conf.categorias.seguridad },
                ]);

            const btnLang = new ButtonBuilder()
                .setCustomId(`cfg_lang_${l === 'es' ? 'en' : 'es'}`)
                .setLabel(i18nConfig[l].lang_btn)
                .setStyle(ButtonStyle.Secondary);

            const btnGuardar = new ButtonBuilder()
                .setCustomId('cfg_guardar')
                .setLabel(i18nConfig[l].save_btn)
                .setStyle(ButtonStyle.Primary);

            return [
                new ActionRowBuilder().addComponents(menu),
                new ActionRowBuilder().addComponents(btnLang, btnGuardar)
            ];
        };

        const embed = construirEmbed(config, lang);
        const response = await interaction.reply({
            embeds: [embed],
            components: crearComponentes(config, lang),
            flags: MessageFlags.Ephemeral
        });

        const collector = response.createMessageComponentCollector({
            filter: i => i.user.id === interaction.user.id,
            time: 120000 
        });

        let categoriasTemp = { ...config.categorias };

        collector.on('collect', async i => {
            if (i.customId === 'cfg_categorias') {
                // Actualizamos el estado temporal
                categoriasTemp = {
                    musica: i.values.includes('musica'),
                    moderacion: i.values.includes('moderacion'),
                    general: i.values.includes('general'),
                    sistema: i.values.includes('sistema'),
                    seguridad: i.values.includes('seguridad'),
                };
                await i.deferUpdate();

            } else if (i.customId.startsWith('cfg_lang_')) {
                const nuevoLang = i.customId.split('_')[2];
                actualizarConfigServidor(interaction.guild.id, { idioma: nuevoLang });
                
                config = obtenerConfigServidor(interaction.guild.id);
                lang = nuevoLang;

                await i.update({
                    embeds: [construirEmbed(config, lang)],
                    components: crearComponentes(config, lang)
                });

            } else if (i.customId === 'cfg_guardar') {
                actualizarConfigServidor(interaction.guild.id, { categorias: categoriasTemp });
                config = obtenerConfigServidor(interaction.guild.id);

                await i.update({
                    embeds: [construirEmbed(config, lang)],
                    components: crearComponentes(config, lang)
                });

                await i.followUp({ content: i18nConfig[lang].success, flags: MessageFlags.Ephemeral });
            }
        });

        collector.on('end', () => {
            interaction.editReply({ components: [] }).catch(() => null);
        });
    },
};

function construirEmbed(config, lang) {
    const t = i18nConfig[lang];
    const estado = config.activo ? '🟢 ON' : '🔴 OFF';

    return new EmbedBuilder()
        .setTitle(t.title)
        .setDescription(`${t.desc}\n\n**Estado:** ${estado}\n**Idioma:** \`${lang.toUpperCase()}\``)
        .addFields(
            { name: '🎵 Música', value: config.categorias.musica ? '✅' : '❌', inline: true },
            { name: '🛡️ Moderación', value: config.categorias.moderacion ? '✅' : '❌', inline: true },
            { name: '⚙️ General', value: config.categorias.general ? '✅' : '❌', inline: true },
            { name: '🚨 Sistema', value: config.categorias.sistema ? '✅' : '❌', inline: true },
            { name: '📡 Seguridad', value: config.categorias.seguridad ? '✅' : '❌', inline: true },
        )
        .setColor('#FF9900')
        .setFooter({ text: t.footer });
}