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

                const [instanciaActual] = await instancesClient.get({
                    project: projectId,
                    zone: zone,
                    instance: instanceName,
                });

                const ipPublica = instanciaActual.networkInterfaces[0].accessConfigs[0].natIP;

                // --- NUEVO FLUJO DE DOBLE VERIFICACIÓN ---
                if (instanciaActual.status === 'RUNNING') {
                    await interaction.editReply('⏳ La máquina virtual está encendida. Verificando el motor de Minecraft...');
                    
                    try {
                        // Intentamos hacer ping al servidor. Si responde, realmente está activo.
                        await util.status(ipPublica, 25565, { timeout: 3000 });
                        
                        return interaction.editReply(`⚠️ **El servidor ya se encuentra encendido y funcionando.**\n🎮 IP de conexión: \`${ipPublica}\``);
                    } catch (e) {
                        // Si da error, la VM está encendida pero Java/Forge está apagado
                        await interaction.editReply('⚠️ **La VM está encendida pero Minecraft está detenido** (posible mantenimiento).\n⏳ Reiniciando la máquina virtual remotamente para levantar los servicios en limpio...');
                        
                        // Ejecutamos un reinicio de la VM desde la API de GCP
                        await instancesClient.reset({
                            project: projectId,
                            zone: zone,
                            instance: instanceName,
                        });
                        
                        // No usamos "return" aquí, dejamos que el código pase directo a la fase 4
                    }
                } else {
                    // Flujo normal: Si está completamente apagada, la encendemos
                    await interaction.editReply('⏳ Encendiendo la máquina virtual. Espera un momento...');
                    await instancesClient.start({
                        project: projectId,
                        zone: zone,
                        instance: instanceName,
                    });
                }

                // El mensaje de confirmación previo al ciclo de monitoreo
                await interaction.editReply(`✅ **¡Iniciando el servidor!** (IP: \`${ipPublica}\`)\nEl servidor de Minecraft (Forge) tardará unos minutos en cargar todos los mods. \n\n👀 *VitaBot te etiquetará aquí mismo cuando puedas entrar a jugar.*`);

                // --- 4. CICLO DE MONITOREO (POLLING) HACIA MINECRAFT ---
                let serverOnline = false;
                let intentos = 0;
                const maxIntentos = 30; // 30 intentos * 10 segundos = 5 minutos de espera máxima

                // Le damos 2 minutos de "gracia" iniciales a Linux para arrancar Java
                await new Promise(resolve => setTimeout(resolve, 120000));

                while (!serverOnline && intentos < maxIntentos) {
                    try {
                        await util.status(ipPublica, 25565, { timeout: 2000 });
                        serverOnline = true;
                    } catch (e) {
                        intentos++;
                        await new Promise(resolve => setTimeout(resolve, 10000));
                    }
                }

                // C) Resultado Final del Monitoreo
                if (serverOnline) {
                    await interaction.followUp(`🔔 <@${interaction.user.id}> **¡El servidor de Minecraft ya está abierto y listo para recibir jugadores!**\n🎮 Entren a: \`${ipPublica}\``);
                } else {
                    await interaction.followUp(`⚠️ <@${interaction.user.id}> **El sistema arrancó, pero el servidor de Minecraft tardó demasiado en responder.**\nPuede que Forge siga cargando, o que algún mod haya causado un crash. Te sugiero intentar entrar en un par de minutos.`);
                }

            } catch (error) {
                console.error('Error detectado en la API o red:', error);
                const motivoError = error.message || 'Tiempo de espera agotado o fallo interno';
                await interaction.editReply(`❌ **Hubo un error en el proceso.**\n\n🛠️ **Motivo:** \`${motivoError}\``);
            }
        }
    },
};