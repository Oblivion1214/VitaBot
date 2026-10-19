const { SlashCommandBuilder, EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle, PermissionFlagsBits } = require('discord.js');
const { obtenerContextoRol } = require('../utils/rolesAutoservicio');
const { almacenSeguridad } = require('../utils/almacenSeguridad');
module.exports = {
    data: new SlashCommandBuilder().setName('roles').setDescription('Crea un botón para un rol de autoservicio sin privilegios')
        .addRoleOption(option => option.setName('rol_a_dar').setDescription('Rol normal que podrá obtener cualquier miembro').setRequired(true))
        .setDefaultMemberPermissions(PermissionFlagsBits.ManageRoles),
    async execute(interaction) {
        await interaction.deferReply();
        if (!interaction.guild) return interaction.editReply('Este comando solo funciona en servidores.');
        try {
            const selected = interaction.options.getRole('rol_a_dar');
            const { role } = await obtenerContextoRol(interaction.guild, selected.id, interaction.user.id);
            const reply = await interaction.fetchReply();
            almacenSeguridad.addPanel({ guildId: interaction.guildId, channelId: interaction.channelId, messageId: reply.id,
                roleId: role.id, creatorId: interaction.user.id });
            await interaction.editReply({ embeds: [new EmbedBuilder().setTitle('🎭 Menú de roles')
                .setDescription('Pulsa para obtener o quitarte el rol <@&' + role.id + '>.').setColor('#FF9900')],
                components: [new ActionRowBuilder().addComponents(new ButtonBuilder().setCustomId('dar_rol_' + role.id)
                    .setLabel(('Obtener rol ' + role.name).slice(0, 80)).setStyle(ButtonStyle.Primary))],
                allowedMentions: { parse: [] } });
        } catch {
            await interaction.editReply('No se creó el panel. Necesitas Gestionar roles; el rol debe ser normal, estar debajo de tu jerarquía y de la de Vita.');
        }
    },
};
