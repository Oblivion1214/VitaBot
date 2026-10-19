const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs'), path = require('node:path'), vm = require('node:vm');
const discord = require('discord.js');
function fixture(coverage, response = {}, overrides = {}) {
    const source = fs.readFileSync(path.join(__dirname, '../commands/analizar.js'), 'utf8'), calls = [], generated = [];
    const report = { cleanUrl: 'https://example.com/?secret=token', ruta: ['https://example.com/?secret=token'], detectado: false, score: 0,
        resultados: { cobertura: coverage, ...response }, ...overrides };
    const context = { module: { exports: {} }, URL, require(name) {
        if (name === 'discord.js') return discord;
        if (name === '../utils/urlPublica') return require('../utils/urlPublica');
        if (name === '../utils/linkGuard') return { escanearEnlace: async () => report, textoIPQS: () => 'IPQS', textoVirusTotal: () => 'VT' };
        if (name === '../utils/servicioGemini') return { gemini: { configured: () => true, generate: async request => { generated.push(request); return { status: 'unavailable' }; } } };
        throw Error(name);
    } };
    vm.runInNewContext(source, context);
    const interaction = { guildId: 'guild', user: { id: 'user' }, options: { getString: () => report.cleanUrl },
        deferReply: async payload => calls.push(payload), editReply: async payload => calls.push(payload) };
    return { command: context.module.exports, interaction, calls, generated };
}
test('los proveedores fallidos o no configurados no aparecen como limpios', async () => {
    const f = fixture({ google: 'error', ipqs: 'sin_configurar', virustotal: 'sin_analisis', urlhaus: 'error' });
    await f.command.execute(f.interaction);
    const embed = f.calls.at(-1).embeds[0].toJSON();
    assert.match(embed.title, /incompleto/); assert.match(embed.fields[1].value, /fallida/);
    assert.match(embed.fields[2].value, /Sin análisis/); assert.match(embed.fields[3].value, /no configurado/);
    assert.equal(f.calls[0].flags, 64);
    assert.ok(!f.generated[0].contents.includes('secret')); assert.ok(!f.generated[0].contents.includes('token'));
});
test('un indicador aislado no se presenta como ausencia de detecciones', async () => {
    const f = fixture({ google: 'consultado', ipqs: 'consultado', virustotal: 'consultado', urlhaus: 'consultado' }, { statsVT: { malicious: 1 } });
    await f.command.execute(f.interaction); assert.match(f.calls.at(-1).embeds[0].toJSON().title, /Indicadores/);
});
