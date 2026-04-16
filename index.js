// index.js — VitaBot
// 1. CARGA DE ENTORNO (siempre lo primero)
require('dotenv').config();

// 2. IMPORTACIONES PRINCIPALES
const {
    Client, Collection, GatewayIntentBits, MessageFlags,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require("discord.js");
const { Player, BaseExtractor, Track, QueryType } = require('discord-player');
const { StreamType } = require('@discordjs/voice');
const { DefaultExtractors } = require('@discord-player/extractor');
const fs = require("fs");
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const youtubeExt = require('youtube-ext');
const youtubedl = require('youtube-dl-exec');
const { log, sanitizeErrorMessage, obtenerConfigServidor, actualizarConfigServidor, obtenerCanalLog } = require('./utils/logger');

// CARGA DE COMANDOS
const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        //GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

// Nueva integración de letras
const Genius = require("genius-lyrics");
const geniusClient = new Genius.Client(process.env.GENIUS_TOKEN);
// Lo guardamos en el objeto 'client' para que sea accesible desde cualquier comando
client.genius = geniusClient;
console.log('» | Motor de letras (Genius SDK) sincronizado.');

// Configuración de i18n para la bienvenida
const i18n = {
    es: {
        welcome_title: "✨ Vita Graf Eisen: Conectada",
        welcome_desc: "¡Hola! Soy un sistema multifunción enfocado en la **alta fidelidad de audio** y auditoría.",
        kbps_advice: "💡 **Tip de Admin:** Para audio Hi-Fi, sube el bitrate del los canales de voz a 96kbps o superior, siempre y cuando el server tenga Boost.",
        setup_button: "Configurar Auditoría",
        lang_button: "Change to English 🇺🇸"
    },
    en: {
        welcome_title: "✨ Vita Graf Eisen: Connected",
        welcome_desc: "Hello! I am a multi-function system focused on **High-Fidelity audio** and auditing.",
        kbps_advice: "💡 **Admin Tip:** For Hi-Fi audio, set the bitrate of voice channels to 96kbps or higher, always and when the server has Boost.",
        setup_button: "Setup Audit Logs",
        lang_button: "Cambiar a Español 🇲🇽"
    }
};

client.commands = new Collection();
client.cooldowns = new Collection();

// --------- CONFIGURACIÓN DE MÚSICA ---------
// CARGA DE LA COOKIE DE YOUTUBE (si existe)
let youtubeCookie = '';
try {
    youtubeCookie = fs.readFileSync('./youtube-cookie.json', 'utf-8').trim()
                    .replace(/^"|"$/g, '');
    console.log('» | Cookie de YouTube cargada correctamente.');
} catch(e) {
    console.warn('» | Sin cookie de YouTube, algunas canciones pueden fallar.');
}

// Función de limpieza de URLs para evitar errores con FFmpeg y yt-dlp
function cleanYoutubeUrl(url) {
    try {
        const u = new URL(url);
        // VALIDACIÓN: Solo permitir dominios oficiales de confianza
        const dominiosSeguros = ['youtube.com', 'youtu.be', 'music.youtube.com', 'googleusercontent.com'];
        if (!dominiosSeguros.some(d => u.hostname.endsWith(d))) return null;

        // Extraemos el ID sin importar si es music.youtube o youtube normal
        let videoId = u.searchParams.get('v');
        if (!videoId && u.hostname === 'youtu.be') {
            videoId = u.pathname.slice(1).split(/[?#]/)[0];
        }

        // Validamos que el ID tenga el formato correcto (11 caracteres alfanuméricos) para que FFmpeg y yt-dlp lo procesen sin errores
        return videoId ? `https://www.youtube.com/watch?v=${videoId}` : null;
    } catch(e) {
        return null;
    }
}

// Función para convertir segundos a formato mm:ss
function secondsToTime(secs) {
    const s = parseInt(secs || '0');
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}

// Función de limpieza avanzada
function limpiarParaLyrics(texto, autor) {
    if (!texto) return '';
    
    let limpio = texto
        // Eliminamos tags específicos que vimos en tus logs
        .replace(/\(Letra Oficial\)/gi, '')
        .replace(/\(Letra\)/gi, '')
        .replace(/\(Letra Lyrics\)/gi, '')
        .replace(/\(Video Oficial\)/gi, '')
        .replace(/\(Video\)/gi, '')
        .replace(/\(Official Video\)/gi, '')
        .replace(/\(Lyrics\)/gi, '')
        .replace(/\(Audio Oficial\)/gi, '')
        .replace(/\(Lyrics Video\)/gi, '')
        .replace(/\(Cover Audio\)/gi, '')
        .replace(/\(Official Live Video\)/gi, '')
        .replace(/\(Live Video\)/gi, '')
        .replace(/\(Official Live\)/gi, '')
        .replace(/\[.*?\]/g, '') 
        .replace(/"/g, '')
        .replace(/\s+/g, ' ')
        .trim();

    if (limpio.includes('-')) {
        const partes = limpio.split('-');
        if (autor && partes[0].toLowerCase().includes(autor.toLowerCase())) {
            limpio = partes[1].trim();
        } else {
            limpio = partes[partes.length - 1].trim();
        }
    }
    
    return limpio;
}

// Extractor personalizado para manejar YouTube y Spotify con mayor precisión
class YoutubeExtExtractor extends BaseExtractor {
    static identifier = 'com.vitabot.youtube-ext';

    async validate(query, type) {
        // Solo manejamos YouTube, Spotify y búsquedas de texto
        if (query.startsWith('http') && 
            !query.includes('youtube.com') && 
            !query.includes('youtu.be') && 
            !query.includes('spotify.com')) {
            return false; 
        }
        return true;
    }

    async handle(query, context) {
        try {
            // ------ SOPORTE SPOTIFY ------
            if (query.includes('spotify.com/track/')) {
                const trackId = query.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                if (!trackId) return { playlist: null, tracks: [] };

                const oembedRes = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${trackId}`);
                const oembed = await oembedRes.json();
                const searchQuery = oembed.title;

                const results = await youtubeExt.search(searchQuery, { type: 'video', limit: 1 });
                if (!results?.videos?.length) return { playlist: null, tracks: [] };

                const videoUrl = cleanYoutubeUrl(results.videos[0].url);
                const video = results.videos[0];

                const track = new Track(this.context.player, {
                    title: oembed.title || video.title,
                    url: videoUrl,
                    duration: video.duration?.text || '0:00',
                    thumbnail: oembed.thumbnail_url || video.thumbnails?.[0]?.url || '',
                    author: video.channel?.name || 'Desconocido',
                    requestedBy: context.requestedBy,
                    source: 'spotify',
                    queryType: context.type,
                    description: '',
                    views: 0,
                    live: false
                });

                track.extractor = this;
                return { playlist: null, tracks: [track] };
            }

            // ------ SOPORTE YOUTUBE Y BÚSQUEDA POR NOMBRE ------
            let videoUrl;

            if (query.includes('youtube.com') || query.includes('youtu.be')) {
                videoUrl = cleanYoutubeUrl(query);
                console.log(`[YoutubeExt] 🔗 Link directo detectado: ${videoUrl}`); // Nuevo Log
            } else {
                // PRIORIZACIÓN: Si es búsqueda de texto, añadimos "topic" o "music" 
                // para que youtube-ext devuelva resultados de YT Music primero
                const searchQuery = query.includes('music') ? query : `${query} music topic`;
                const results = await youtubeExt.search(searchQuery, { type: 'video', limit: 10 }); // Pedimos 10 para el menú
                if (!results?.videos?.length) return { playlist: null, tracks: [] };

                // Registro de cantidad de resultados
                console.log(`[YoutubeExt] 🔍 Búsqueda: "${searchQuery}" | Resultados devueltos: ${results?.length || 10}`);
                
                // Mapeamos los resultados para que el comando play.js pueda usarlos en el menú
                const tracks = results.videos.map(video => {
                    const track = new Track(this.context.player, {
                        title: video.title,
                        url: cleanYoutubeUrl(video.url),
                        duration: video.duration?.text || '0:00',
                        thumbnail: video.thumbnails?.[0]?.url || '',
                        author: video.channel?.name || 'YouTube Music',
                        requestedBy: context.requestedBy,
                        source: 'youtube',
                        queryType: context.type
                    });
                    track.extractor = this;
                    return track;
                });

                return { playlist: null, tracks: tracks };
            }

            const info = await youtubeExt.videoInfo(videoUrl, {
                requestOptions: { headers: { cookie: youtubeCookie } }
            });

            if (!info?.title) return { playlist: null, tracks: [] };

            const track = new Track(this.context.player, {
                title: info.title || 'Sin título',
                url: videoUrl,
                duration: secondsToTime(info.duration?.lengthSec),
                thumbnail: info.thumbnails?.[0]?.url || '',
                author: info.channel?.name || 'Desconocido',
                requestedBy: context.requestedBy,
                source: 'youtube',
                queryType: context.type,
                description: info.shortDescription || '',
                views: info.views?.pretty || 0,
                live: info.isLive || false
            });

            track.extractor = this;
            return { playlist: null, tracks: [track] };

        } catch(e) {
            // CORRECCIÓN: Si hay error de parseo (SyntaxError), retornamos vacío para que 
            // discord-player intente con el siguiente extractor en la cadena.
            if (e.message.includes('Unexpected non-whitespace character') || e instanceof SyntaxError) {
                console.warn('[YoutubeExt] Error de parseo en YouTube. Activando motores de respaldo...');
            } else {
                console.error('[YoutubeExt handle] ERROR:', e.message);
            }
            
            // Importante: Retornar este objeto permite que la búsqueda continúe con otros extractores
            return { playlist: null, tracks: [] };
        }
    }

    async stream(track) {
        try {
            const cleanUrl = cleanYoutubeUrl(track.url);
            if (!cleanUrl) throw new Error("URL No permitida o malformada");

            const audioUrl = (await youtubedl(cleanUrl, {
                format: 'bestaudio',
                getUrl: true,
                noCheckCertificates: true,
                noWarnings: true,
            }, {windowsHide: true})).trim();

            const ffmpegProcess = spawn(ffmpegPath, [
                '-reconnect', '1',
                '-reconnect_at_eof', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '10',
                '-probesize', '2M',
                '-analyzeduration', '2M',
                '-loglevel', 'error',
                '-i', audioUrl,
                '-vn',
                '-c:a', 'libopus',
                '-ar', '48000',
                '-ac', '2',
                '-b:a', '320k',
                '-f', 'opus',
                'pipe:1'
            ], { stdio: ['ignore', 'pipe', 'pipe'],
                windowsHide: true // <--- ESTA ES LA CLAVE PARA WINDOWS
            });

            return { stream: ffmpegProcess.stdout, type: StreamType.Opus };

        } catch(e) {
            console.error('[YoutubeExt stream] ERROR:', e.message);
            throw e;
        }
    }

    emittedError(error) {
        console.error('[YoutubeExt error]', error);
    }
}

// Inicializamos el reproductor y registramos el extractor personalizado
const player = new Player(client);

// Actualiza la función inicializarMusica
async function inicializarMusica() {
    try {
        // CARGA CRÍTICA: Permite al bot manejar múltiples tipos de audio
        // 1. REGISTRA EL TUYO PRIMERO: Para que tenga prioridad absoluta en búsquedas
        await player.extractors.register(YoutubeExtExtractor, {});
        
        // 2. CARGA LOS BASE: Solo para soportar el audio de Google y otros formatos
        await player.extractors.loadMulti(DefaultExtractors);

        console.log('» | Motores de audio (Base + Custom) cargados correctamente.');
    } catch (e) {
        console.error('» | Error al inicializar motores:', e.message);
    }
}

// Llamamos a la función de inicialización al iniciar el bot
inicializarMusica();

// --- EVENTOS DE MÚSICA REFORZADOS ---

// Escuchamos el evento de inicio de pista para enviar un panel de control con botones
player.events.on('playerStart', async (queue, track) => {
    // 1. FILTRO: Si la pista no tiene título real (como el TTS), no enviamos panel
    if (track.url.includes('translate_tts')) return;

    const embed = new EmbedBuilder()
        .setTitle('🎵 Reproduciendo Ahora')
        .setDescription(`**[${track.title}](${track.url})**\nAutor: ${track.author}`)
        .setThumbnail(track.thumbnail)
        .setColor('#FF9900');

        if (track.thumbnail && track.thumbnail.startsWith('http')) {
        embed.setThumbnail(track.thumbnail);
    }

    // PRIMERA FILA: Controles básicos
    const fila1 = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('musica_pausa').setEmoji('⏯️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('musica_salto').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('musica_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger),
        new ButtonBuilder().setCustomId('musica_shuffle').setEmoji('🔀').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('musica_queue').setEmoji('📜').setStyle(ButtonStyle.Secondary)
    );

    // SEGUNDA FILA: Utilidades adicionales
    const fila2 = new ActionRowBuilder().addComponents(
        new ButtonBuilder()
            .setCustomId('musica_lyrics')
            .setLabel('Ver Letras')
            .setEmoji('🎤')
            .setStyle(ButtonStyle.Secondary)
    );

    // 2. Enviamos el mensaje al canal de texto asociado a la cola (si existe)
    if (queue.metadata?.canal) {
        // Enviamos ambas filas de botones
        const mensaje = await queue.metadata.canal.send({ 
            embeds: [embed], 
            components: [fila1, fila2] 
        }).catch(() => null);
        queue.metadata.ultimoMensaje = mensaje;
    }
});

// Función para limpiar la interfaz de botones cuando la cola se vacía o el bot se desconecta
const limpiarInterfaz = async (queue) => {
    if (queue.metadata?.ultimoMensaje) {
        await queue.metadata.ultimoMensaje.edit({ components: [] }).catch(() => null);
        queue.metadata.ultimoMensaje = null;
    }
};

// Escuchamos eventos de finalización para limpiar botones y evitar sesiones huérfanas
player.events.on('emptyQueue', (queue) => limpiarInterfaz(queue));
player.events.on('disconnect', (queue) => limpiarInterfaz(queue));
// Escuchamos el evento de error para limpiar conexiones ociosas de TTS
player.events.on('error', (queue, error) => {
    console.error(`[Error de Sistema]: ${error.message}`);
    if (queue?.guild) {
        log(queue.guild, {
            categoria: 'sistema',
            titulo: 'Error de Sistema',
            descripcion: 'Ocurrió un error en el sistema de reproducción.',
            error: sanitizeErrorMessage(error.message),
        }).catch(() => null);
    }
});
// Escuchamos el evento de error para limpiar conexiones ociosas de TTS
player.events.on('playerError', (queue, error) => {
    console.error(`[Error de Audio]: ${error.message}`);
    if (queue?.guild) {
        log(queue.guild, {
            categoria: 'sistema',
            titulo: 'Error de Audio',
            descripcion: 'Ocurrió un error al reproducir la pista de audio.',
            campos: queue.currentTrack ? [
                { name: '🎵 Pista', value: queue.currentTrack.title, inline: true }
            ] : [],
            error: sanitizeErrorMessage(error.message),
        }).catch(() => null);
    }
});

// CARGA DE COMANDOS
// IMPORTANTE: Cargamos los comandos después de configurar los eventos de música para evitar condiciones de carrera
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    client.commands.set(command.data.name, command);
}

// LOGUEO DE INICIO Y CONFIGURACIÓN DE ESTADO
client.once("clientReady", async () => {
    console.log(`» | VitaBot encendido como: ${client.user.tag}`);
    client.user.setActivity('/play | v3.0 Hi-Fi', { type: 2 });
    console.log(`» | ${client.commands.size} comandos listos.`);

    // --- RECONCILIACIÓN DE SERVIDORES ---
    // Cubre joins que ocurrieron mientras el bot estaba apagado (PM2 restart/downtime)
    console.log(`» | Reconciliando ${client.guilds.cache.size} servidor(es)...`);
    for (const guild of client.guilds.cache.values()) {
        const config = obtenerConfigServidor(guild.id);

        // Si ya completó el setup, ignorar
        if (config._setupCompleto) continue;

        // Si no tiene el canal, el guildCreate se perdió durante el downtime
        const canalExistente = guild.channels.cache.find(c => c.name === 'vitabot-logs');
        if (!canalExistente) {
            console.log(`» | [Reconciliación] Re-enviando bienvenida a "${guild.name}".`);
            client.emit('guildCreate', guild);
        }
    }
});

// Manejo de interacciones (comandos y botones)
client.on("interactionCreate", async (interaction) => {
    // 1. MANEJO DE COMANDOS DE BARRA (SLASH COMMANDS)
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        // Lógica de Cooldowns reforzada
        const { cooldowns } = client;
        if (!cooldowns.has(command.data.name)) cooldowns.set(command.data.name, new Collection());
        
        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const cooldownAmount = (command.cooldown ?? 3) * 1000;

        if (timestamps.has(interaction.user.id)) {
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
            
            if (now < expirationTime) {
                // BUFFER DE SEGURIDAD: Añadimos 2 segundos para evitar el bug de "hace un minuto"
                const tiempoVisual = Math.round((expirationTime + 2000) / 1000);
                return interaction.reply({
                    content: `⏳ Vita está recargando Graf Eisen. Espera <t:${tiempoVisual}:R> para usar \`/${command.data.name}\`.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }

        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
            await command.execute(interaction);
        } catch (error) {
            console.error('[Error de Ejecución]:', error);

            // LOG SANITIZADO: Protegemos las rutas del servidor
            const { log, sanitizeErrorMessage } = require('./utils/logger');
            await log(interaction.guild, {
                categoria: 'sistema',
                titulo: 'Error en comando',
                descripcion: `Falló el comando \`/${interaction.commandName}\`.`,
                usuario: interaction.user,
                error: sanitizeErrorMessage(error.message),
            }).catch(() => null);

            const msgError = { 
                content: '❌ Mis circuitos mágicos han fallado al ejecutar este comando.', 
                flags: MessageFlags.Ephemeral 
            };
            // Intentamos responder a la interacción, pero si ya expiró, simplemente no hacemos nada
            try {
                if (interaction.replied || interaction.deferred) {
                    await interaction.followUp(msgError);
                } else {
                    await interaction.reply({ content: '❌ Fallo crítico al ejecutar el comando.', flags: MessageFlags.Ephemeral }).catch(() => null);
                }
            } catch (interactionError) {
                console.error('[Anti-Crash] La interacción expiró antes de poder enviar el error:', interactionError.message);
            }
        }

    // 2. MANEJO DE BOTONES (MÚSICA Y JUEGOS)
    } else if (interaction.isButton()) {
        // FILTRO DE SEGURIDAD: Solo procesamos botones con el prefijo "musica_"
        // Esto evita que index.js intente procesar botones de PPT o Auditoría
        if (!interaction.customId.startsWith('musica_')) return;

        const queue = player.nodes.get(interaction.guildId);
        
        // Si no hay cola, el botón es huérfano (zombi)
        if (!queue) return interaction.reply({ 
            content: '❌ No hay música activa en este momento.', 
            flags: MessageFlags.Ephemeral 
        });

        // VALIDACIÓN DE SESIÓN: Comparamos el ID del mensaje con el último enviado
        // Esto soluciona que botones de sesiones viejas detengan la música nueva
        if (queue.metadata?.ultimoMensaje && interaction.message.id !== queue.metadata.ultimoMensaje.id) {
            return interaction.reply({
                content: '⚠️ Este panel de control es de una canción antigua. Usa el mensaje más reciente.',
                flags: MessageFlags.Ephemeral
            });
        }

        // Acciones de los botones de música
        try {
            // Pausar/Reanudar música
            if (interaction.customId === 'musica_pausa') {
                queue.node.setPaused(!queue.node.isPaused());
                return interaction.reply({
                    content: queue.node.isPaused() ? '⏸️ Música pausada.' : '▶️ Música reanudada.',
                    flags: MessageFlags.Ephemeral
                });
            }

            // Saltar a la siguiente pista
            if (interaction.customId === 'musica_salto') {
                queue.node.skip();
                return interaction.reply({ content: '⏭️ Saltando a la siguiente pista.', flags: MessageFlags.Ephemeral });
            }

            // Detener música y limpiar cola
            if (interaction.customId === 'musica_stop') {
                // Limpiamos los botones físicamente antes de borrar la cola
                if (queue.metadata?.ultimoMensaje) {
                    await queue.metadata.ultimoMensaje.edit({ components: [] }).catch(() => null);
                }
                queue.delete();
                return interaction.reply({ content: '🛑 Sesión finalizada.', flags: MessageFlags.Ephemeral });
            }

            // Mezclar la cola de reproducción
            if (interaction.customId === 'musica_shuffle') {
                // Verificamos si hay suficientes canciones para mezclar
                if (queue.tracks.size < 2) {
                    return interaction.reply({ 
                        content: '⚠️ No hay suficientes canciones en la cola para mezclar.', 
                        flags: MessageFlags.Ephemeral 
                    });
                }

                // Mezclamos la cola usando el método interno de discord-player
                queue.tracks.shuffle();

                return interaction.reply({ 
                    content: '🔀 **Modo aleatorio:** La cola de reproducción ha sido mezclada con éxito.', 
                    flags: MessageFlags.Ephemeral 
                });
            }

            // Mostrar cola de reproducción
            if (interaction.customId === 'musica_queue') {
                const currentTrack = queue.currentTrack;
                const tracks = queue.tracks.toArray(); 
                const nextSongs = tracks.slice(0, 10); // Tomamos las primeras 10

                const listado = nextSongs.map((track, i) => {
                    return `**${i + 1}.** [${track.title}](${track.url}) - \`${track.duration}\``;
                }).join('\n');

                const queueEmbed = new EmbedBuilder()
                    .setTitle(`🎼 Cola de Reproducción - ${interaction.guild.name}`)
                    .setColor('#FF9900')
                    .setThumbnail(currentTrack.thumbnail)
                    .addFields(
                        { 
                            name: '▶️ Reproduciendo Ahora', 
                            value: `**[${currentTrack.title}](${currentTrack.url})**\nAutor: \`${currentTrack.author}\``, 
                            inline: false 
                        },
                        { 
                            name: '⏭️ Próximas Canciones', 
                            value: listado || '_No hay más canciones en la cola._', 
                            inline: false 
                        }
                    )
                    .setFooter({ 
                        text: `Total de canciones: ${tracks.length} | Tiempo total: ${queue.durationFormatted} 🔨` 
                    })
                    .setTimestamp();

                // 2. Respondemos de forma efímera para no saturar el chat
                return interaction.reply({ embeds: [queueEmbed], flags: MessageFlags.Ephemeral });
            }

            // Mostrar letras de la canción actual
            if (interaction.customId === 'musica_lyrics') {
                await interaction.deferReply({ flags: MessageFlags.Ephemeral });

                try {
                    const currentTrack = queue.currentTrack;
                    const tituloLimpio = limpiarParaLyrics(currentTrack.title, currentTrack.author);

                    // Búsqueda directa en Genius
                    console.log(`[Genius] Buscando: ${tituloLimpio} - ${currentTrack.author}`);
                    const searches = await client.genius.songs.search(`${tituloLimpio} ${currentTrack.author}`);
                    
                    const firstSong = searches[0];
                    if (!firstSong) {
                        return interaction.editReply(`❌ No encontré letras para: **${tituloLimpio}**.`);
                    }

                    const lyrics = await firstSong.lyrics();

                    const lyricsEmbed = new EmbedBuilder()
                        .setTitle(`🎤 Letras: ${firstSong.title}`)
                        .setAuthor({ name: firstSong.artist.name })
                        .setThumbnail(currentTrack.thumbnail)
                        .setDescription(lyrics.length > 4096 ? lyrics.substring(0, 4090) + '...' : lyrics)
                        .setColor('#FF9900')
                        .setFooter({ text: 'Powered by Genius API & VitaBot 🔨' });

                    return interaction.editReply({ embeds: [lyricsEmbed] });

                } catch (e) {
                    console.error('[Genius Error]:', e.message);
                    return interaction.editReply('❌ No se pudo obtener la letra en este momento.');
                }
            }

        } catch (e) {
            console.error('[Button Error]:', e.message);
        }
    }
});

// Implementación de Fase 1 (Bienvenida y Verificación)
// Implementación Final de guildCreate con Memoria JSON
client.on("guildCreate", async (guild) => {
    console.log(`» | Vita detectada en: ${guild.name}. Iniciando protocolo de bienvenida.`);

    // 1. CARGA DE CONFIGURACIÓN E IDIOMA (Persistencia)
    // Detectamos el idioma sugerido por Discord si el server no tiene registro previo
    const sugerenciaLang = guild.preferredLocale === 'es-ES' ? 'es' : 'en';
    // Obtenemos o creamos la config en audit-config.json
    let config = obtenerConfigServidor(guild.id, sugerenciaLang); 
    // Sanitizamos: si el idioma guardado no es válido, usamos la sugerencia
    let currentLang = (config.idioma === 'es' || config.idioma === 'en') ? config.idioma : sugerenciaLang;

    // 2. OBTENCIÓN DEL CANAL (Usa tu lógica de vitabot-logs)
    const auditChannel = await obtenerCanalLog(guild);

    // 3. CONSTRUCCIÓN DE LA INTERFAZ (Embed + Botones)
    const generarPanel = (lang) => {
        const embed = new EmbedBuilder()
            .setTitle(i18n[lang].welcome_title)
            .setDescription(`${i18n[lang].welcome_desc}\n\n${i18n[lang].kbps_advice}\n\n⚠️ **Acción Requerida:** Confirma la configuración. Si no hay respuesta en 10 min, me retiraré para no dejar rastro.`)
            .setColor('#FF9900')
            .setFooter({ text: 'Sistema de Laboratorio VitaBot 🔨' });

        const row = new ActionRowBuilder().addComponents(
            new ButtonBuilder()
                .setCustomId(`confirm_setup_${guild.id}`)
                .setLabel(i18n[lang].setup_button)
                .setStyle(ButtonStyle.Success)
                .setEmoji('✅'),
            new ButtonBuilder()
                .setCustomId(`change_lang_${lang === 'es' ? 'en' : 'es'}`)
                .setLabel(i18n[lang].lang_button)
                .setStyle(ButtonStyle.Secondary),
            new ButtonBuilder()
                .setCustomId(`cancel_setup_${guild.id}`)
                .setLabel(lang === 'es' ? 'Abandonar' : 'Leave')
                .setStyle(ButtonStyle.Danger)
        );

        return { embeds: [embed], components: [row] };
    };

    // Guard: si no se pudo crear el canal (sin permisos), salimos limpiamente
    if (!auditChannel) {
        console.warn(`» | [guildCreate] Sin permisos de ManageChannels en "${guild.name}". Setup omitido.`);
        return;
    }

    // Enviamos el mensaje de bienvenida con la interfaz de configuración
    const msg = await auditChannel.send(generarPanel(currentLang));

    // 4. TEMPORIZADOR DE AUTO-LIMPIEZA (10 Minutos)
    const timeout = setTimeout(async () => {
        if (guild.available) {
            console.log(`» | Expulsión automática: Sin respuesta en ${guild.name}.`);
            await auditChannel.delete().catch(() => null); 
            await guild.leave().catch(() => null);
        }
    }, 10 * 60 * 1000);

    // 5. COLECTOR DE INTERACCIONES (Solo Administradores)
    const collector = msg.createMessageComponentCollector({ 
        filter: (i) => i.member.permissions.has('Administrator'), 
        time: 10 * 60 * 1000 
    });

    // Manejo de interacciones con botones
    collector.on('collect', async (interaction) => {
        // --- CASO: CONFIRMAR CONFIGURACIÓN ---
        if (interaction.customId.startsWith('confirm_setup')) {
            clearTimeout(timeout);

            // Marcamos el setup como completo para que la reconciliación no lo repita
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

        // --- CASO: CAMBIAR IDIOMA (Actualiza JSON y UI) ---
        } else if (interaction.customId.startsWith('change_lang')) {
            const nuevoLang = interaction.customId.split('_')[2];
            
            // Guardamos el cambio en tu audit-config.json
            actualizarConfigServidor(guild.id, { idioma: nuevoLang });
            
            // Actualizamos el mensaje original con el nuevo idioma inmediatamente
            await interaction.update(generarPanel(nuevoLang));

        // --- CASO: ABANDONAR ---
        } else if (interaction.customId.startsWith('cancel_setup')) {
            clearTimeout(timeout);
            console.log(`» | El administrador rechazó a Vita en ${guild.name}.`);
            await auditChannel.delete().catch(() => null);
            await guild.leave().catch(() => null);
        }
    });

    // Manejo del fin del colector para limpiar el mensaje si se agota el tiempo sin interacciones
    collector.on('end', (collected, reason) => {
        if (reason === 'time' && collected.size === 0) {
            console.log(`» | Colector cerrado por tiempo agotado en ${guild.name}.`);
        }
    });
});

// INICIAMOS EL BOT
client.login(process.env.TOKEN);

// Manejo global de errores para evitar que el proceso muera
process.on('unhandledRejection', (reason, promise) => {
    console.error(' [Anti-Crash] Rechazo no manejado:', reason);
    // Aquí podrías llamar a log() si tienes acceso al guild
});

process.on('uncaughtException', (err, origin) => {
    console.error(' [Anti-Crash] Excepción no capturada:', err);
});