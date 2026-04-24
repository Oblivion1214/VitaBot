const { SlashCommandBuilder, MessageFlags } = require('discord.js');
const {
    joinVoiceChannel,
    createAudioPlayer,
    createAudioResource,
    AudioPlayerStatus,
    NoSubscriberBehavior,
    StreamType,
    VoiceConnectionStatus,
    entersState
} = require('@discordjs/voice');
const { useQueue } = require('discord-player');
const googleTTS = require('google-tts-api');
const { Readable } = require('stream');
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const { log } = require('../utils/logger'); //

const DELAY_DESCONEXION_MS = 2 * 60 * 1000;

function estimarDuracionMs(oggBuffer) {
    return Math.max((oggBuffer.byteLength / 8000) * 1000, 800);
}

// Mutex de estado para el comando
const enEjecucion = new Set();
const conexionesTTS = new Map();

module.exports = {
    // Exportamos para que /play pueda consultar el estado
    enEjecucion,
    conexionesTTS,

    data: new SlashCommandBuilder()
        .setName('decir')
        .setDescription('Haz que Vita pronuncie un mensaje en el canal de voz.')
        .addStringOption(option =>
            option.setName('mensaje')
                .setDescription('Lo que quieres que Vita diga (máx. 200 carac.)')
                .setRequired(true)
                .setMaxLength(200)),

    async execute(interaction) {
        const canalVoz = interaction.member?.voice?.channel;
        const queue = useQueue(interaction.guildId); //
        const member = interaction.member;
        const botChannel = interaction.guild.members.me?.voice?.channelId;

        // 1. BLOQUEO DE SEGURIDAD (Smart Lock): No hablar si hay música
        // 1. BLOQUEO DE SEGURIDAD VM: No hablar si hay música en la nube
        if (queue && queue.isPlaying()) {
            return interaction.reply({
                content: '⚠️ **Sistemas ocupados:** No puedo usar el TTS mientras hay música sonando (VM). Detén la música primero.',
                flags: MessageFlags.Ephemeral
            });
        }

        if (!member?.voice?.channel) {
            return interaction.reply({ 
                content: '¡Aprende a usar Graf Eisen! Entra a un canal de voz primero.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        if (botChannel) {
            try {
                // Le preguntamos a la PC si está ocupada reproduciendo algo
                const status = await fetch(`http://100.127.221.32:3000/api/control?action=status`).then(r => r.json());
                if (!status.error) {
                    return interaction.reply({
                        content: '⚠️ **Sistemas ocupados:** Graf Eisen está reproduciendo audio en Alta Fidelidad (PC Local). Detén la música primero para no interrumpir mis circuitos.',
                        flags: MessageFlags.Ephemeral
                    });
                }
            } catch (e) {
                // Si la PC no responde, asumimos que no está reproduciendo y seguimos
            }
        }
    
        if (!canalVoz) {
            return interaction.reply({ 
                content: '¡Escucha bien! No puedo hablarle a las paredes. ¡Entra en un canal de voz ahora mismo!', 
                flags: MessageFlags.Ephemeral 
            });
        }

        if (enEjecucion.has(interaction.guildId)) {
            return interaction.reply({ 
                content: '⏳ Ya estoy procesando un mensaje de voz, espera un momento.', 
                flags: MessageFlags.Ephemeral 
            });
        }

        await interaction.deferReply({ flags: MessageFlags.Ephemeral });
        const texto = interaction.options.getString('mensaje');
        enEjecucion.add(interaction.guildId); // Bloqueamos el comando

        let connection = null;
        let ttsPlayer = null;
        let subscription = null;
        let timeoutDesconexion = null;

        try {
            // 2. Obtención del audio desde Google TTS
            const ttsUrl = googleTTS.getAudioUrl(texto, {
                lang: 'es',
                slow: false,
                host: 'https://translate.google.com'
            });

            const response = await fetch(ttsUrl, {
                headers: { 'User-Agent': 'Mozilla/5.0 (compatible; VitaBot/1.0)' }
            });
            if (!response.ok) throw new Error(`HTTP ${response.status} al obtener TTS`);

            const arrayBuffer = await response.arrayBuffer();
            console.log('[TTS] MP3 recibido:', arrayBuffer.byteLength, 'bytes');

            // 3. Conversión MP3 → OGG/Opus mediante FFmpeg
            const oggBuffer = await new Promise((resolve, reject) => {
                const ff = spawn(ffmpegPath, [
                    '-loglevel', 'error',
                    '-f', 'mp3',
                    '-i', 'pipe:0',
                    '-vn',
                    '-c:a', 'libopus',
                    '-ar', '48000',
                    '-ac', '2',
                    '-b:a', '128k',
                    '-f', 'ogg',
                    'pipe:1'
                ], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });

                const chunks = [];
                ff.stdout.on('data', chunk => chunks.push(chunk));
                ff.stdout.on('end', () => resolve(Buffer.concat(chunks)));
                ff.on('error', reject);
                ff.stdin.end(Buffer.from(arrayBuffer));
            });

            if (!oggBuffer.byteLength) throw new Error('FFmpeg no generó audio');

            // 4. Gestión de la conexión
            // Si hay un timeout ocioso (espera de 2 min), lo cancelamos para reusar la conexión
            if (conexionesTTS.has(interaction.guildId)) {
                const prev = conexionesTTS.get(interaction.guildId);
                clearTimeout(prev.timeout);
                connection = prev.connection;
                conexionesTTS.delete(interaction.guildId);
                console.log('[TTS] Reutilizando conexión ociosa.');
            } else {
                connection = joinVoiceChannel({
                    channelId: canalVoz.id,
                    guildId: interaction.guildId,
                    adapterCreator: interaction.guild.voiceAdapterCreator,
                    selfDeaf: true,
                });
                await entersState(connection, VoiceConnectionStatus.Ready, 10_000);
            }

            // 5. Reproducción del audio
            ttsPlayer = createAudioPlayer({
                behaviors: { noSubscriber: NoSubscriberBehavior.Stop }
            });

            const resource = createAudioResource(Readable.from(oggBuffer), {
                inputType: StreamType.OggOpus,
            });

            subscription = connection.subscribe(ttsPlayer);
            ttsPlayer.play(resource);
            console.log('[TTS] Reproduciendo en:', canalVoz.name);

            // Esperar a que termine la reproducción
            await new Promise((resolve) => {
                ttsPlayer.once(AudioPlayerStatus.Idle, resolve);
                setTimeout(resolve, 20_000); // Timeout de seguridad
            });

            // const margen = estimarDuracionMs(oggBuffer);
            //await new Promise(r => setTimeout(r, margen));
            console.log('[TTS] Reproducción completada.');

            // Auditoría
            await log(interaction.guild, {
                categoria: 'general',
                titulo: 'Uso de TTS (Voz)',
                descripcion: `Vita ha hablado en el canal **${canalVoz.name}**.`,
                campos: [{ name: '📢 Mensaje', value: texto, inline: false }],
                usuario: interaction.user,
            });

            await interaction.editReply(`📢 He dicho: "${texto}"`);

        } catch (e) {
            console.error('[TTS Error]:', e.message);
            await interaction.editReply('❌ No pude procesar tu mensaje de voz.');
        } finally {
            // 6. LIMPIEZA FINAL
            try { ttsPlayer?.stop(true); } catch (_) {}
            try { subscription?.unsubscribe(); } catch (_) {}

            // Liberamos el mutex inmediatamente para que el comando sea usable de nuevo
            enEjecucion.delete(interaction.guildId);
            console.log('[TTS] Comando liberado. Ya se puede usar /play.');

            // Si la conexión existe y no hay música (que no debería haber por el bloqueo), ponemos el timeout
            if (connection && connection.state.status !== VoiceConnectionStatus.Destroyed) {
                const guildId = interaction.guildId;
                const connRef = connection;

                // Establecemos un timeout para desconectar el bot después de 2 minutos de inactividad
                timeoutDesconexion = setTimeout(() => {
                    conexionesTTS.delete(guildId);
                    // Solo destruimos si discord-player no ha tomado el control en este tiempo
                    const queueActual = useQueue(guildId);
                    if (!queueActual?.connection) {
                        connRef.destroy();
                        console.log('[TTS] Bot desconectado tras 2 minutos de inactividad.');
                    }
                }, DELAY_DESCONEXION_MS);

                conexionesTTS.set(guildId, { connection: connRef, timeout: timeoutDesconexion });
                console.log('[TTS] Bot permanecerá en el canal 2 minutos o hasta que se pida música.');
            }
        }
    },

};