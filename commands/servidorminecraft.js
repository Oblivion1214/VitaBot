const { SlashCommandBuilder, PermissionsBitField } = require('discord.js');
const compute = require('@google-cloud/compute');
const util = require('minecraft-server-util');
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
        // --- 1. OBTENER CONFIGURACIÓN DINÁMICA ---
        const config = obtenerConfigServidor(interaction.guild.id, 'es', interaction.guild.name);
        const logChannelId = config?.canalLogId; 

        // --- 2. VALIDACIÓN DE SEGURIDAD Y PERMISOS ---
        const esAdmin = interaction.member.permissions.has(PermissionsBitField.Flags.Administrator);
        let canalLog = null;
        let puedeVerLogs = false;

        if (logChannelId) {
            canalLog = interaction.guild.channels.cache.get(logChannelId);
        } else {
            canalLog = interaction.guild.channels.cache.find(c => c.name === 'vitabot-logs');
        }

        if (canalLog) {
            puedeVerLogs = canalLog.permissionsFor(interaction.member).has(PermissionsBitField.Flags.ViewChannel);
        }

        if (!esAdmin && !puedeVerLogs) {
            const canalMencion = canalLog ? `<#${canalLog.id}>` : 'el canal de logs configurado';
            return interaction.reply({ 
                content: `❌ **Acceso denegado.** Necesitas ser Administrador o tener acceso a ${canalMencion} para utilizar este comando.`, 
                ephemeral: true 
            });
        }

        // --- 3. PROCESAMIENTO EN GOOGLE CLOUD ---
        const subcommand = interaction.options.getSubcommand();

        if (subcommand === 'start') {
            await interaction.deferReply(); 

            try {
                const instancesClient = new compute.InstancesClient();
                const projectId = process.env.GCP_PROJECT_ID;
                const zone = process.env.GCP_ZONE;
                const instanceName = process.env.GCP_INSTANCE_NAME;

                await interaction.editReply('⏳ Consultando el estado de la máquina en Google Cloud...');

                // A) Verificar si ya está encendida
                const [instanciaActual] = await instancesClient.get({
                    project: projectId,
                    zone: zone,
                    instance: instanceName,
                });

                // Extraemos la IP pública dinámica que le asignó Google Cloud
                const ipPublica = instanciaActual.networkInterfaces[0].accessConfigs[0].natIP;

                if (instanciaActual.status === 'RUNNING') {
                    return interaction.editReply(`⚠️ **El servidor ya se encuentra encendido.**\n🎮 IP de conexión: \`${ipPublica}\``);
                }

                // B) Si está apagada, la encendemos
                await interaction.editReply('⏳ Encendiendo la máquina virtual. Espera un momento...');
                await instancesClient.start({
                    project: projectId,
                    zone: zone,
                    instance: instanceName,
                });

                await interaction.editReply(`✅ **¡Máquina Virtual encendida!** (IP: \`${ipPublica}\`)\nEl servidor de Minecraft (Forge) tardará unos minutos en cargar todos los mods. \n\n👀 *VitaBot te etiquetará aquí mismo cuando puedas entrar a jugar.*`);

                // --- 4. CICLO DE MONITOREO (POLLING) HACIA MINECRAFT ---
                let serverOnline = false;
                let intentos = 0;
                const maxIntentos = 30; // 30 intentos * 10 segundos = 5 minutos de espera máxima

                // Le damos 2 minutos de "gracia" iniciales a Linux para arrancar Java antes de hacer ping
                await new Promise(resolve => setTimeout(resolve, 120000));

                while (!serverOnline && intentos < maxIntentos) {
                    try {
                        // Hacemos un ping al puerto de Minecraft. Si responde, rompemos el bucle
                        await util.status(ipPublica, 25565, { timeout: 2000 });
                        serverOnline = true;
                    } catch (e) {
                        // Si falla (Connection Refused), sumamos un intento y esperamos 10 segundos
                        intentos++;
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                }

                // C) Resultado Final del Monitoreo
                if (serverOnline) {
                    await interaction.followUp(`🔔 <@${interaction.user.id}> **¡El servidor de Minecraft ya está abierto y listo para recibir jugadores!**\n🎮 Entren a: \`${ipPublica}\``);
                } else {
                    await interaction.followUp(`⚠️ <@${interaction.user.id}> **La máquina virtual se encendió, pero el servidor de Minecraft tardó demasiado en responder.**\nPuede que Forge siga cargando, o que algún mod haya causado un crash. Te sugiero intentar entrar en un par de minutos.`);
                }

            } catch (error) {
                console.error('Error detectado en la API o red:', error);
                const motivoError = error.message || 'Tiempo de espera agotado o fallo interno';
                await interaction.editReply(`❌ **Hubo un error en el proceso.**\n\n🛠️ **Motivo:** \`${motivoError}\``);
            }
        }
    },
};