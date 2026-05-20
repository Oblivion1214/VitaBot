const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const compute = require('@google-cloud/compute');
// Importación del módulo de configuración nativo de VitaBot
const { obtenerConfigServidor } = require('../utils/logger');

module.exports = {
    data: new SlashCommandBuilder()
        .setName('servidorminecraft')
        .setDescription('Controla la máquina virtual del servidor de Minecraft')
        .addSubcommand(subcommand =>
            subcommand
                .setName('start')
                .setDescription('Enciende el servidor de Minecraft')
        ),
        
    async execute(interaction) {
        // --- 1. OBTENER CONFIGURACIÓN DINÁMICA DEL SERVIDOR ---
        const config = obtenerConfigServidor(interaction.guild.id, 'es', interaction.guild.name);
        
        // Mapeo directo a la propiedad exacta de tu JSON
        const logChannelId = config?.canalLogId; 

        // --- 2. VALIDACIÓN DE SEGURIDAD Y PERMISOS ---
        const esAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
        
        let canalLog = null;
        let puedeVerLogs = false;

        // Intentar resolver el canal por ID o usar el fallback por nombre por seguridad
        if (logChannelId) {
            canalLog = interaction.guild.channels.cache.get(logChannelId);
        } else {
            canalLog = interaction.guild.channels.cache.find(c => c.name === 'vitabot-logs');
        }

        // Evaluar si el usuario tiene permisos de lectura sobre el canal asignado
        if (canalLog) {
            puedeVerLogs = canalLog.permissionsFor(interaction.member).has(PermissionsBitField.Flags.ViewChannel);
        }

        // Restricción de acceso: requiere rol de administrador o visibilidad del canal auditado
        if (!esAdmin && !puedeVerLogs) {
            const canalMencion = canalLog ? `<#${canalLog.id}>` : 'el canal de logs configurado';
            return interaction.reply({ 
                content: `❌ **Acceso denegado.** Necesitas ser Administrador o tener acceso a ${canalMencion} para utilizar este comando.`, 
                ephemeral: true 
            });
        }

        // --- 3. PROCESAMIENTO DE LA SOLICITUD EN GCP ---
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'start') {
            await interaction.deferReply(); // Previene el timeout de la API de Discord (3s)

            try {
                const instancesClient = new compute.InstancesClient();
                const projectId = process.env.GCP_PROJECT_ID;
                const zone = process.env.GCP_ZONE;
                const instanceName = process.env.GCP_INSTANCE_NAME;
                
                // --- NUEVO: VERIFICAR EL ESTADO DE LA MÁQUINA ---
                const [instanciaActual] = await instancesClient.get({
                    project: projectId,
                    zone: zone,
                    instance: instanceName,
                });

                if (instanciaActual.status === 'RUNNING') {
                    return interaction.editReply('⚠️ **El servidor ya está encendido y funcionando.** ¡Entra a jugar directamente!');
                }
                // ------------------------------------------------

                await interaction.editReply('⏳ Solicitando encendido a Google Cloud. Espera un momento...');

                const [response] = await instancesClient.start({
                    project: projectId,
                    zone: zone,
                    instance: instanceName,
                });

                await interaction.editReply('✅ **¡Máquina Virtual encendida exitosamente!**\nEl servidor de Minecraft (Forge) tardará aproximadamente **2 a 3 minutos** en estar listo. ¡Prepárense para jugar!');

            } catch (error) {
                console.error('Error detectado en la API de Compute Engine:', error);
                
                // Extracción y sanitización del mensaje de error nativo de Google Cloud
                const motivoError = error.message || 'Tiempo de espera agotado o fallo de red interno';

                await interaction.editReply(`❌ **Hubo un error al comunicarse con Google Cloud.**\nNo se pudo inicializar la instancia de procesamiento.\n\n🛠️ **Motivo reportado por la API:** \`${motivoError}\``);
            }
        }
    },
};