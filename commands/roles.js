const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits, MessageFlags } = require('discord.js');
const { log } = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('roles')
        .setDescription('Crea un botón interactivo para dar un rol')
        .addRoleOption(option => 
            option.setName('rol_a_dar')
            .setDescription('Selecciona el rol que este botón entregará')
            .setRequired(true)
        )
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
        
    async execute(interaction) {
        const rolSeleccionado = interaction.options.getRole('rol_a_dar');

        if (rolSeleccionado.position >= interaction.guild.members.me.roles.highest.position) {
            return interaction.reply({ content: '❌ No puedo dar un rol que sea igual o superior al mío.', flags: MessageFlags.Ephemeral });
        }

        const embed = new EmbedBuilder()
            .setTitle('🎭 Menú de Roles')
            .setDescription(`Haz clic en el botón de abajo para obtener el rol <@&${rolSeleccionado.id}> o quitártelo si ya lo tienes.`)
            .setColor('#FF9900');

        const botonDinámico = new ButtonBuilder()
            .setCustomId(`dar_rol_${rolSeleccionado.id}`)
            .setLabel(`Obtener rol ${rolSeleccionado.name}`)
            .setStyle(ButtonStyle.Primary);

        const fila = new ActionRowBuilder().addComponents(botonDinámico);

        await log(interaction.guild, {
            categoria: 'moderacion',
            titulo: 'Menú de roles creado',
            descripcion: `Se creó un botón de asignación de rol.`,
            campos: [
                { name: '🎭 Rol', value: `<@&${rolSeleccionado.id}>`, inline: true },
                { name: '📌 Canal', value: `<#${interaction.channelId}>`, inline: true },
            ],
            usuario: interaction.user,
        });

        await interaction.reply({ embeds: [embed], components: [fila] });
    },
};