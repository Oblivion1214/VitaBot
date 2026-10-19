const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { PassThrough } = require('node:stream');
const { ServicioMusica } = require('../utils/servicioMusica');
const { obtenerCanalVoz, crearMensajeCola } = require('../utils/interfazMusica');
const tick = () => new Promise(resolve => setImmediate(resolve));
const track = name => ({ title: name, url: 'https://www.youtube.com/watch?v=jNQXAC9IVRw', author: 'YouTube', durationSeconds: 19 });
function fixture(options = {}) {
    const opened = [], sources = [], connections = [];
    const source = () => {
        const value = { stream: new PassThrough(), closed: false, close() { this.closed = true; this.stream.destroy(); } };
        sources.push(value); return value;
    };
    const worker = { open: async (...args) => { opened.push(args); return source(); }, speak: async (...args) => { opened.push(args); return source(); }, ...options.worker };
    const voice = {
        AudioPlayerStatus: { Idle: 'idle', Playing: 'playing', Paused: 'paused' },
        VoiceConnectionStatus: { Ready: 'ready', Disconnected: 'disconnected', Destroyed: 'destroyed' },
        StreamType: { OggOpus: 'ogg/opus' }, NoSubscriberBehavior: { Pause: 'pause' },
        createAudioPlayer() {
            const player = new EventEmitter();
            player.state = { status: 'idle' };
            player.change = state => { const old = player.state; player.state = state; player.emit('stateChange', old, state); };
            player.play = resource => player.change({ status: 'playing', resource });
            player.stop = () => player.change({ status: 'idle' });
            player.pause = () => player.change({ ...player.state, status: 'paused' });
            player.unpause = () => player.change({ ...player.state, status: 'playing' });
            return player;
        },
        joinVoiceChannel() {
            const connection = new EventEmitter(); connection.state = { status: 'ready' };
            connection.subscribe = () => {};
            connection.destroy = () => { connection.state.status = 'destroyed'; connection.emit('stateChange', {}, connection.state); };
            connections.push(connection); return connection;
        },
        entersState: async connection => connection,
        createAudioResource(stream, settings) { assert.equal(settings.inputType, 'ogg/opus'); assert.equal(settings.inlineVolume, false); return { ...settings, stream, playbackDuration: 0 }; },
        ...options.voice,
    };
    const service = new ServicioMusica({ user: { id: 'vita' } }, { idleMs: 25, ...options, worker, voice });
    const channel = (guildId = 'guild', id = 'voice') => ({ id, guild: { id: guildId, voiceAdapterCreator: {} }, bitrate: 64000, members: new Map([['user', { user: { bot: false } }]]) });
    return { service, channel, sources, opened, connections, source };
}
test('respeta el límite de sesiones configurado para un servidor de pocos recursos', t => {
    const anterior = process.env.MUSIC_MAX_SESSIONS;
    process.env.MUSIC_MAX_SESSIONS = '1';
    t.after(() => {
        if (anterior === undefined) delete process.env.MUSIC_MAX_SESSIONS;
        else process.env.MUSIC_MAX_SESSIONS = anterior;
    });
    const f = fixture(); t.after(() => f.service.close());
    f.service.reserve(f.channel('primero'), {});
    assert.throws(() => f.service.reserve(f.channel('segundo'), {}), /límite de sesiones/);
    assert.equal(f.service.sessions.size, 1);
});

test('colas independientes por servidor y avance al terminar Opus', async t => {
    const f = fixture(); t.after(() => f.service.close());
    const a = f.service.enqueue(f.channel(), {}, [track('a'), track('b')], 'user');
    const b = f.service.enqueue(f.channel('other'), {}, [track('c')], 'user');
    await tick(); assert.equal(a.current.track.title, 'a'); assert.equal(b.current.track.title, 'c');
    a.player.stop(); await tick(); assert.equal(a.current.track.title, 'b'); assert.equal(b.current.track.title, 'c');
    assert.equal(f.sources[0].closed, true); assert.equal(a.bitrate, 64);
});
test('saltar durante la carga descarta el stream tardío y su evento Idle', async t => {
    let complete;
    const f = fixture(); f.service.worker.open = () => new Promise(resolve => { complete = resolve; });
    t.after(() => f.service.close());
    const session = f.service.enqueue(f.channel(), {}, [track('a'), track('b')], 'u');
    await tick(); const first = session.current; const firstComplete = complete;
    session.skip(); await tick(); const second = session.current;
    const late = f.source(); firstComplete(late); await tick();
    assert.equal(late.closed, true); assert.equal(first.controller.signal.aborted, true);
    session.player.emit('stateChange', { resource: { metadata: { owner: first } } }, { status: 'idle' });
    assert.equal(session.current, second); complete(f.source()); await tick(); assert.equal(session.current.started, true);
});
test('detener durante la conexión impide abrir el extractor y destruye la conexión', async () => {
    let ready;
    const f = fixture({ voice: { entersState: () => new Promise(resolve => { ready = resolve; }) } });
    const session = f.service.enqueue(f.channel(), {}, [track('a')], 'u');
    session.stop(); ready(); await tick();
    assert.equal(f.opened.length, 0); assert.equal(f.connections[0].state.status, 'destroyed'); assert.equal(f.service.sessions.size, 0);
});
test('errores de red vacían la lista y no disparan una cascada de descargas', async t => {
    const f = fixture({ worker: { open: async () => { throw Error('offline'); } } }); t.after(() => f.service.close());
    let errors = 0; f.service.on('trackError', () => errors++);
    const session = f.service.enqueue(f.channel(), {}, [track('a'), track('b')], 'u');
    await tick(); assert.equal(errors, 1); assert.equal(session.current, null); assert.equal(session.tracks.length, 0);
});
test('error e Idle del mismo recurso solo avanzan una vez', async t => {
    const f = fixture(); t.after(() => f.service.close());
    const session = f.service.enqueue(f.channel(), {}, [track('a'), track('b')], 'u'); await tick();
    const resource = session.current.resource;
    session.player.emit('error', { resource });
    session.player.emit('stateChange', { resource }, { status: 'idle' }); await tick();
    assert.equal(session.current, null); assert.equal(session.tracks.length, 0); assert.equal(f.opened.length, 1);
});
test('TTS reserva la conexión antes de esperar e impide música o segundo TTS', async t => {
    const f = fixture(); t.after(() => f.service.close());
    const speaking = f.service.speak(f.channel(), {}, 'Hola');
    assert.throws(() => f.service.enqueue(f.channel(), {}, [track('a')], 'u'), /hablar/);
    await assert.rejects(f.service.speak(f.channel(), {}, 'Dos'), /termine/);
    await tick(); const session = f.service.get('guild'); session.player.stop(); await speaking;
    f.service.enqueue(f.channel(), {}, [track('a')], 'u'); await tick(); assert.equal(session.current.kind, 'music');
});
test('TTS fallido libera el bloqueo para música', async t => {
    const f = fixture({ worker: { speak: async () => { throw Error('offline'); } } }); t.after(() => f.service.close());
    await assert.rejects(f.service.speak(f.channel(), {}, 'Hola'), /iniciar/);
    f.service.enqueue(f.channel(), {}, [track('a')], 'u'); await tick(); assert.equal(f.service.get('guild').current.kind, 'music');
});
test('conflictos de canal y límite de sesiones no reemplazan la cola existente', t => {
    const f = fixture({ maxSessions: 1 }); t.after(() => f.service.close());
    f.service.enqueue(f.channel(), {}, [track('a')], 'u');
    assert.throws(() => f.service.enqueue(f.channel('guild', 'other'), {}, [track('b')], 'u'), /otro canal/);
    assert.throws(() => f.service.enqueue(f.channel('other'), {}, [track('c')], 'u'), /límite/);
    assert.equal(f.service.get('guild').current.track.title, 'a');
});
test('pausa y reanudación conservan stream y canciones pendientes', async t => {
    const f = fixture(); t.after(() => f.service.close());
    const session = f.service.enqueue(f.channel(), {}, [track('a'), track('b')], 'u'); await tick();
    assert.equal(session.pause(), true); assert.equal(session.pause(), false);
    assert.equal(f.opened.length, 1); assert.equal(session.tracks.length, 1); assert.equal(f.sources[0].closed, false);
});
test('pausar durante buffering no anuncia una pausa que el reproductor no puede aplicar', async t => {
    const f = fixture(); t.after(() => f.service.close());
    const session = f.service.enqueue(f.channel(), {}, [track('a')], 'u'); await tick();
    session.player.state.status = 'buffering';
    assert.throws(() => session.pause(), /preparando/);
    assert.equal(session.pauseTimer, undefined);
});
test('salir del canal como bot elimina únicamente esa sesión', async () => {
    const f = fixture(); const channel = f.channel();
    f.service.enqueue(channel, {}, [track('a')], 'u');
    f.service.handleVoiceState({ channelId: channel.id }, { id: 'vita', guild: channel.guild, channelId: null });
    assert.equal(f.service.get('guild'), undefined); await tick();
});
test('cola vacía desconecta tras el plazo de inactividad', async () => {
    const f = fixture(); const session = f.service.enqueue(f.channel(), {}, [track('a')], 'u'); await tick();
    session.player.stop(); await new Promise(resolve => setTimeout(resolve, 50));
    assert.equal(f.service.sessions.size, 0); assert.equal(f.connections[0].state.status, 'destroyed');
});
test('controles rechazan miembros de otro canal y colas grandes caben en Discord', async t => {
    const f = fixture(); t.after(() => f.service.close());
    const session = f.service.enqueue(f.channel(), {}, Array.from({ length: 100 }, () => track('['.repeat(200))), 'u');
    const interaction = { member: { voice: { channel: f.channel('guild', 'other') } }, client: { music: f.service }, guildId: 'guild' };
    assert.throws(() => obtenerCanalVoz(interaction), /mismo canal/);
    const payload = crearMensajeCola(session, 1); const embed = payload.embeds[0].toJSON();
    assert.ok(embed.description.length <= 4096); await tick();
});
