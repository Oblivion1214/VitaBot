const { EventEmitter } = require('node:events');
const defaultVoice = require('@discordjs/voice');
const { ClienteAudio } = require('./clienteAudio');
const { ErrorAudio } = require('../audio/protocolo');

class ServicioMusica extends EventEmitter {
    constructor(client, { voice = defaultVoice, worker, idleMs = 120_000,
        maxSessions = Math.max(1, Math.min(10, Math.floor(Number(process.env.MUSIC_MAX_SESSIONS) || 3))) } = {}) {
        super();
        this.client = client;
        this.voice = voice;
        this.worker = worker || new ClienteAudio();
        this.sessions = new Map();
        this.idleMs = idleMs;
        this.maxSessions = maxSessions;
    }
    get(guildId) { return this.sessions.get(guildId); }
    resolve(query) { return this.worker.resolve(query); }
    reserve(channel, textChannel) {
        let session = this.get(channel.guild.id);
        if (session && session.channel.id !== channel.id) throw new ErrorAudio('Ya estoy en otro canal de voz. Únete a ese canal.', 409);
        if (!session) {
            if (this.sessions.size >= this.maxSessions) throw new ErrorAudio('Se alcanzó el límite de sesiones de voz. Intenta más tarde.', 429);
            session = new SesionServidor(this, channel, textChannel);
            this.sessions.set(channel.guild.id, session);
        }
        return session;
    }
    enqueue(channel, textChannel, tracks, requestedBy) {
        if (!Array.isArray(tracks) || !tracks.length || tracks.length > 200) throw new ErrorAudio('La solicitud debe contener entre 1 y 200 canciones.', 400);
        const session = this.reserve(channel, textChannel);
        session.enqueue(tracks, requestedBy);
        return session;
    }
    async speak(channel, textChannel, text) {
        const session = this.reserve(channel, textChannel);
        if (session.current || session.tracks.length) throw new ErrorAudio('Espera a que termine el audio antes de usar /decir.', 409);
        return session.speak(text);
    }
    handleVoiceState(oldState, newState) {
        const session = this.get(newState.guild.id);
        if (!session) return;
        if (newState.id === this.client.user.id && newState.channelId !== session.channel.id) return session.stop();
        if (oldState.channelId === session.channel.id && !session.channel.members.some(member => !member.user.bot)) session.stop();
    }
    close() { for (const session of [...this.sessions.values()]) session.stop(); }
}

class SesionServidor {
    constructor(service, channel, textChannel) {
        this.service = service;
        this.channel = channel;
        this.textChannel = textChannel;
        this.tracks = [];
        this.current = null;
        this.closed = false;
        this.generation = 0;
        this.bitrate = Math.max(32, Math.min(128, Math.floor((channel.bitrate || 64000) / 1000)));
        const voice = service.voice;
        this.player = voice.createAudioPlayer({ behaviors: { noSubscriber: voice.NoSubscriberBehavior.Pause } });
        this.player.on('stateChange', (oldState, newState) => {
            if (newState.status === voice.AudioPlayerStatus.Idle && oldState.resource) {
                this.finish(oldState.resource.metadata?.owner);
            }
        });
        this.player.on('error', error => {
            const owner = error.resource?.metadata?.owner;
            if (owner && owner === this.current) this.finish(owner, new ErrorAudio('La transmisión de audio se interrumpió.'));
        });
    }
    enqueue(tracks, requestedBy) {
        if (this.closed) throw new ErrorAudio('La sesión ya terminó. Vuelve a usar /play.', 409);
        if (this.current?.kind === 'tts') throw new ErrorAudio('Espera a que termine de hablar.', 409);
        if (!tracks.length) throw new ErrorAudio('No encontré canciones disponibles.', 404);
        if (this.tracks.length + tracks.length > 200) throw new ErrorAudio('La cola admite hasta 200 canciones pendientes.', 400);
        this.tracks.push(...tracks.map(track => ({ ...track, requestedBy })));
        clearTimeout(this.idleTimer);
        this.next();
    }
    next() {
        if (this.closed || this.current) return;
        const track = this.tracks.shift();
        if (!track) return this.scheduleIdle();
        this.start({ kind: 'music', track });
    }
    speak(text) {
        clearTimeout(this.idleTimer);
        return new Promise((resolve, reject) => this.start({ kind: 'tts', text, resolve, reject }));
    }
    start(owner) {
        owner.controller = new AbortController();
        owner.generation = ++this.generation;
        this.current = owner;
        // Every asynchronous result belongs to this owner; skipped work cannot replace a newer resource.
        this.load(owner).catch(() => this.finish(owner, new ErrorAudio('No pude iniciar el audio. Comprueba que el servidor de audio esté disponible.')));
    }
    async connect() {
        if (this.ready) return this.ready;
        const voice = this.service.voice;
        this.connection = voice.joinVoiceChannel({ channelId: this.channel.id, guildId: this.channel.guild.id,
            adapterCreator: this.channel.guild.voiceAdapterCreator, selfDeaf: true });
        this.connection.subscribe(this.player);
        this.connection.on('error', () => this.stop());
        this.connection.on('stateChange', (_, state) => {
            if (this.closed) return;
            if (state.status === voice.VoiceConnectionStatus.Destroyed) this.stop();
            if (state.status === voice.VoiceConnectionStatus.Disconnected) {
                voice.entersState(this.connection, voice.VoiceConnectionStatus.Ready, 5000).catch(() => this.stop());
            }
        });
        this.ready = voice.entersState(this.connection, voice.VoiceConnectionStatus.Ready, 15_000);
        return this.ready;
    }
    async load(owner) {
        try { await this.connect(); }
        catch {
            this.finish(owner, new ErrorAudio('No pude conectar al canal de voz. Revisa mis permisos.'));
            this.stop();
            return;
        }
        if (owner !== this.current || this.closed) return;
        const source = owner.kind === 'tts'
            ? await this.service.worker.speak(owner.text, this.bitrate, owner.controller.signal)
            : await this.service.worker.open(owner.track, this.bitrate, owner.controller.signal);
        if (owner !== this.current || this.closed) { source.close(); return; }
        owner.source = source;
        const voice = this.service.voice;
        owner.resource = voice.createAudioResource(source.stream, { inputType: voice.StreamType.OggOpus,
            inlineVolume: false, metadata: { owner } });
        this.player.play(owner.resource);
        owner.started = true;
        if (owner.kind === 'music') this.service.emit('trackStart', this, owner);
    }
    finish(owner, error) {
        if (!owner || this.current !== owner) return;
        clearTimeout(this.pauseTimer);
        this.current = null;
        owner.controller.abort();
        owner.source?.close();
        if (owner.kind === 'tts') {
            if (error) owner.reject(error); else owner.resolve();
        } else if (error) {
            // A worker outage must not open hundreds of failed streams from an existing playlist.
            this.tracks = [];
            this.service.emit('trackError', this, error);
        }
        this.next();
    }
    skip() {
        clearTimeout(this.pauseTimer);
        const owner = this.current;
        if (!owner) throw new ErrorAudio('No hay audio activo.', 409);
        this.current = null;
        owner.controller.abort(); owner.source?.close();
        this.player.stop(true);
        owner.reject?.(new ErrorAudio('El mensaje de voz fue interrumpido.', 409));
        this.next();
    }
    pause() {
        if (!this.current?.started) throw new ErrorAudio('El audio todavía no está listo.', 409);
        const paused = this.player.state.status === this.service.voice.AudioPlayerStatus.Paused;
        if (!paused && this.player.state.status !== this.service.voice.AudioPlayerStatus.Playing) {
            throw new ErrorAudio('El audio todavía se está preparando. Intenta de nuevo en un momento.', 409);
        }
        if (paused) { this.player.unpause(); clearTimeout(this.pauseTimer); }
        else {
            this.player.pause();
            this.pauseTimer = setTimeout(() => this.stop(), 15 * 60_000);
            this.pauseTimer.unref?.();
        }
        return !paused;
    }
    shuffle() {
        for (let i = this.tracks.length - 1; i > 0; i--) {
            const j = Math.floor(Math.random() * (i + 1));
            [this.tracks[i], this.tracks[j]] = [this.tracks[j], this.tracks[i]];
        }
    }
    scheduleIdle() {
        clearTimeout(this.idleTimer);
        this.idleTimer = setTimeout(() => this.stop(), this.service.idleMs);
        this.idleTimer.unref?.();
    }
    stop() {
        if (this.closed) return;
        this.closed = true;
        clearTimeout(this.idleTimer); clearTimeout(this.pauseTimer);
        const owner = this.current;
        this.current = null; this.tracks = [];
        owner?.controller.abort(); owner?.source?.close(); owner?.reject?.(new ErrorAudio('El mensaje de voz fue interrumpido.', 409));
        this.player.stop(true);
        if (this.connection && this.connection.state.status !== this.service.voice.VoiceConnectionStatus.Destroyed) this.connection.destroy();
        this.service.sessions.delete(this.channel.guild.id);
        this.service.emit('sessionStop', this);
    }
}
module.exports = { ServicioMusica };
