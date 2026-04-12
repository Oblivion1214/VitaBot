// index.js — VitaBot
// 1. CARGA DE ENTORNO (siempre lo primero)
require('dotenv').config();

const {
    Client, Collection, GatewayIntentBits, MessageFlags,
    EmbedBuilder, ActionRowBuilder, ButtonBuilder, ButtonStyle
} = require("discord.js");
const { Player, BaseExtractor, Track, QueryType } = require('discord-player');
const { StreamType } = require('@discordjs/voice');
const fs = require("fs");
const { spawn } = require('child_process');
const ffmpegPath = require('ffmpeg-static');
const youtubeExt = require('youtube-ext');
const youtubedl = require('youtube-dl-exec');
const { log } = require('./utils/logger');

const client = new Client({
    intents: [
        GatewayIntentBits.Guilds,
        GatewayIntentBits.GuildMessages,
        GatewayIntentBits.MessageContent,
        GatewayIntentBits.GuildVoiceStates
    ]
});

client.commands = new Collection();
client.cooldowns = new Collection();

// --- CONFIGURACIÓN DE MÚSICA ---

let youtubeCookie = '';
try {
    youtubeCookie = fs.readFileSync('./youtube-cookie.json', 'utf-8').trim()
                      .replace(/^"|"$/g, '');
    console.log('» | Cookie de YouTube cargada correctamente.');
} catch(e) {
    console.warn('» | Sin cookie de YouTube, algunas canciones pueden fallar.');
}

function cleanYoutubeUrl(url) {
    try {
        const u = new URL(url);
        const videoId = u.searchParams.get('v') || u.pathname.split('/').pop();
        return `https://www.youtube.com/watch?v=${videoId}`;
    } catch(e) {
        return url;
    }
}

function secondsToTime(secs) {
    const s = parseInt(secs || '0');
    const m = Math.floor(s / 60);
    const r = s % 60;
    return `${m}:${r.toString().padStart(2, '0')}`;
}

class YoutubeExtExtractor extends BaseExtractor {
    static identifier = 'com.vitabot.youtube-ext';

    async validate(query, type) {
        return true;
    }

    async handle(query, context) {
        try {
            // --- SOPORTE SPOTIFY ---
            if (query.includes('spotify.com/track/')) {
                console.log('[Spotify] Detectado link de Spotify');

                const trackId = query.match(/track\/([a-zA-Z0-9]+)/)?.[1];
                if (!trackId) return this.createResponse(null, []);

                const oembedRes = await fetch(`https://open.spotify.com/oembed?url=spotify:track:${trackId}`);
                const oembed = await oembedRes.json();
                const searchQuery = oembed.title;

                console.log('[Spotify] Título obtenido:', searchQuery);

                const results = await youtubeExt.search(searchQuery, { type: 'video', limit: 1 });
                if (!results?.videos?.length) return this.createResponse(null, []);

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
                console.log('[Spotify] Track encontrado en YouTube:', track.title);
                return { playlist: null, tracks: [track] };
            }

            // --- SOPORTE YOUTUBE Y BÚSQUEDA POR NOMBRE ---
            let videoUrl;

            if (query.includes('youtube.com') || query.includes('youtu.be')) {
                videoUrl = cleanYoutubeUrl(query);
            } else {
                const results = await youtubeExt.search(query, { type: 'video', limit: 1 });
                if (!results?.videos?.length) return this.createResponse(null, []);
                videoUrl = cleanYoutubeUrl(results.videos[0].url);
            }

            const info = await youtubeExt.videoInfo(videoUrl, {
                requestOptions: { headers: { cookie: youtubeCookie } }
            });

            if (!info?.title) return this.createResponse(null, []);

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
            console.error('[YoutubeExt handle] ERROR:', e.message);
            return this.createResponse(null, []);
        }
    }

    async stream(track) {
        try {
            const cleanUrl = cleanYoutubeUrl(track.url);
            console.log('[YoutubeExt] Obteniendo stream para:', cleanUrl);

            const audioUrl = (await youtubedl(cleanUrl, {
                format: 'bestaudio',
                getUrl: true,
                noCheckCertificates: true,
                noWarnings: true,
            })).trim();

            console.log('[YoutubeExt] URL obtenida:', !!audioUrl);

            const ffmpegProcess = spawn(ffmpegPath, [
                '-reconnect', '1',
                '-reconnect_streamed', '1',
                '-reconnect_delay_max', '5',
                '-probesize', '15M',         // 15 Megabytes (Suficiente para headers Opus pesados)
                '-analyzeduration', '15M',   // 15 Segundos (15,000,000 microsegundos)
                '-loglevel', 'error',
                '-i', audioUrl,
                '-vn',
                '-c:a', 'libopus',
                '-ar', '48000',
                '-ac', '2',
                '-b:a', '128k',
                '-f', 'opus',
                'pipe:1'
            ], { stdio: ['ignore', 'pipe', 'pipe'] });

            ffmpegProcess.stderr.on('data', d => console.error('[FFmpeg]', d.toString()));
            ffmpegProcess.on('error', e => console.error('[FFmpeg error]', e.message));

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

const player = new Player(client);

async function inicializarMusica() {
    try {
        await player.extractors.register(YoutubeExtExtractor, {});
        console.log('» | Extractor youtube-ext registrado y listo.');
    } catch (e) {
        console.error('» | Error al inicializar motores:', e.message);
    }
}

inicializarMusica();

player.events.on('playerStart', (queue, track) => {
    const embed = new EmbedBuilder()
        .setTitle('🎵 Reproduciendo Ahora')
        .setDescription(`**[${track.title}](${track.url})**\nAutor: ${track.author} | Duración: ${track.duration}`)
        .setThumbnail(track.thumbnail)
        .setColor('#FF9900')
        .setFooter({ text: 'Sintonizando audio de alta fidelidad 🔨' });

    const fila = new ActionRowBuilder().addComponents(
        new ButtonBuilder().setCustomId('musica_pausa').setEmoji('⏯️').setStyle(ButtonStyle.Primary),
        new ButtonBuilder().setCustomId('musica_salto').setEmoji('⏭️').setStyle(ButtonStyle.Secondary),
        new ButtonBuilder().setCustomId('musica_stop').setEmoji('⏹️').setStyle(ButtonStyle.Danger)
    );

    if (queue.metadata?.canal) {
        queue.metadata.canal.send({ embeds: [embed], components: [fila] }).catch(() => null);
    }
});

player.events.on('error', (queue, error) => {
    console.error(`[Error de Sistema]: ${error.message}`);
    if (queue?.guild) {
        log(queue.guild, {
            categoria: 'sistema',
            titulo: 'Error de Sistema',
            descripcion: 'Ocurrió un error en el sistema de reproducción.',
            error: error.message,
        }).catch(() => null);
    }
});

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
            error: error.message,
        }).catch(() => null);
    }
});

// CARGA DE COMANDOS
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));
for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    client.commands.set(command.data.name, command);
}

client.once("clientReady", () => {
    console.log(`» | VitaBot encendido como: ${client.user.tag}`);
    console.log(`» | ${client.commands.size} comandos listos.`);
});

client.on("interactionCreate", async (interaction) => {
    if (interaction.isChatInputCommand()) {
        const command = client.commands.get(interaction.commandName);
        if (!command) return;

        const { cooldowns } = client;
        if (!cooldowns.has(command.data.name)) cooldowns.set(command.data.name, new Collection());
        const now = Date.now();
        const timestamps = cooldowns.get(command.data.name);
        const cooldownAmount = (command.cooldown ?? 3) * 1000;

        if (timestamps.has(interaction.user.id)) {
            const expirationTime = timestamps.get(interaction.user.id) + cooldownAmount;
            if (now < expirationTime) {
                return interaction.reply({
                    content: `⏳ Espera <t:${Math.round(expirationTime / 1000)}:R> para usar \`/${command.data.name}\`.`,
                    flags: MessageFlags.Ephemeral
                });
            }
        }
        timestamps.set(interaction.user.id, now);
        setTimeout(() => timestamps.delete(interaction.user.id), cooldownAmount);

        try {
                await command.execute(interaction);
            } catch (error) {
                console.error(error);
                await log(interaction.guild, {
                    categoria: 'sistema',
                    titulo: 'Error en comando',
                    descripcion: `Ocurrió un error al ejecutar el comando \`/${interaction.commandName}\`.`,
                    usuario: interaction.user,
                    error: error.message,
                }).catch(() => null);
        
                const msg = { content: 'Hubo un error al ejecutar este comando.', flags: MessageFlags.Ephemeral };
                if (interaction.replied || interaction.deferred) await interaction.followUp(msg);
                else await interaction.reply(msg);
            }

    } else if (interaction.isButton()) {
        const queue = player.nodes.get(interaction.guildId);
        if (!queue) return interaction.reply({ content: '❌ No hay música activa.', flags: MessageFlags.Ephemeral });

        if (interaction.customId === 'musica_pausa') {
            queue.node.setPaused(!queue.node.isPaused());
            return interaction.reply({
                content: queue.node.isPaused() ? '⏸️ Pausado.' : '▶️ Reanudado.',
                flags: MessageFlags.Ephemeral
            });
        }
        if (interaction.customId === 'musica_salto') {
            queue.node.skip();
            return interaction.reply({ content: '⏭️ Saltando canción.', flags: MessageFlags.Ephemeral });
        }
        if (interaction.customId === 'musica_stop') {
            queue.delete();
            return interaction.reply({ content: '🛑 Detenido.', flags: MessageFlags.Ephemeral });
        }
    }
});

client.login(process.env.TOKEN);