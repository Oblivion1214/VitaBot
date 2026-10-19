const test = require('node:test');
const assert = require('node:assert/strict');
const command = require('../commands/audiostats');
test('estadísticas indican el objetivo Opus y no exponen infraestructura', async () => {
    let response;
    await command.execute({ guildId: 'guild', member: { voice: { channel: { id: 'voice' } } },
        client: { music: { get: () => ({ channel: { id: 'voice' }, bitrate: 64, current: { started: true, resource: { playbackDuration: 65000 } }, player: { state: { status: 'playing' } }, tracks: [] }) } },
        reply: async value => { response = value; } });
    const embed = response.embeds[0].toJSON();
    assert.ok(embed.fields.some(field => field.value.includes('objetivo 64 kbps')));
    assert.ok(embed.fields.some(field => field.value === '1:05'));
    assert.ok(!JSON.stringify(embed).includes('100.'));
});
