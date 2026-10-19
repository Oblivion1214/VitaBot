const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const publicUrl = require('../utils/urlPublica');
const source = fs.readFileSync(path.join(__dirname, '../utils/linkGuard.js'), 'utf8');
function fixture(env = {}, post = async () => ({ data: {} })) {
    const calls = [];
    const context = { module: { exports: {} }, process: { env }, Buffer, URL, URLSearchParams, structuredClone,
        console: { warn() {}, error() {} }, require(name) {
            if (name === 'axios') return { post: async (...args) => { calls.push(args); return post(...args); }, get: async () => ({ data: {} }) };
            if (name === './urlPublica') return { ...publicUrl, expandirUrlPublica: async value => {
                publicUrl.interpretarUrlPublica(value); return { urlFinal: value, ruta: [value] };
            } };
            if (name === './politicaSolicitudes') return require('../utils/politicaSolicitudes');
            if (name === 'node:crypto') return require('node:crypto');
            if (name === './cuarentena') return { ejecutarCuarentena: async () => {} };
            throw Error(name);
        } };
    vm.runInNewContext(source, context);
    return { guard: context.module.exports, calls };
}
test('urlscan no se llama por defecto aunque exista una clave', async () => {
    const f = fixture({ URLSCAN_KEY: 'fake' });
    assert.equal(await f.guard.obtenerAnalisisVisual('https://example.com/'), null);
    assert.equal(f.calls.length, 0);
});
test('urlscan requiere activación, utiliza solo private y no envía query strings', async () => {
    const f = fixture({ URLSCAN_KEY: 'fake', URLSCAN_ENABLED: 'true' }, async () => ({ data: { result: 'https://urlscan.io/result/test' } }));
    await f.guard.obtenerAnalisisVisual('https://example.com/file');
    assert.equal(f.calls[0][1].visibility, 'private');
    await f.guard.obtenerAnalisisVisual('https://example.com/?token=secret');
    assert.equal(f.calls.length, 1);
});
test('si urlscan rechaza private no vuelve a intentarlo como public', async () => {
    const f = fixture({ URLSCAN_KEY: 'fake', URLSCAN_ENABLED: 'true' }, async () => { throw Error('plan'); });
    assert.equal(await f.guard.obtenerAnalisisVisual('https://example.com/'), null);
    assert.equal(f.calls.length, 1); assert.equal(f.calls[0][1].visibility, 'private');
});
test('rechaza una URL interna antes de consultar proveedores externos', async () => {
    const f = fixture({ URLHAUS_KEY: 'fake' });
    await assert.rejects(f.guard.escanearEnlace('http://127.1/secret'), /HTTP/);
    assert.equal(f.calls.length, 0);
});
test('los dominios conocidos y sus imitaciones no se saltan el escáner', async () => {
    for (const host of ['youtube.com', 'falsoyoutube.com', 'githubusercontent.com']) {
        const f = fixture({ URLHAUS_KEY: 'fake' }, async () => ({ data: { query_status: 'ok', url_status: 'online' } }));
        assert.equal((await f.guard.escanearEnlace('https://' + host + '/')).detectado, true);
        assert.equal(f.calls.length, 1);
    }
});
test('una extensión ejecutable sin confirmación no elimina mensajes y no afirma consulta limpia', async () => {
    const f = fixture(); const result = await f.guard.escanearEnlace('https://example.com/program.exe');
    assert.equal(result.detectado, false); assert.equal(result.resultados.esPhishingGoogle, null);
    assert.equal(result.resultados.cobertura.google, 'sin_configurar');
});
test('agrupa solicitudes simultáneas del mismo enlace y devuelve copias aisladas', async () => {
    let finish; const waiting = new Promise(resolve => { finish = resolve; });
    const f = fixture({ URLHAUS_KEY: 'fake' }, async () => { await waiting; return { data: { query_status: 'no_results' } }; });
    const first = f.guard.escanearEnlace('https://example.com/');
    const second = f.guard.escanearEnlace('https://example.com/');
    await new Promise(setImmediate); assert.equal(f.calls.length, 1);
    finish(); const [a,b]=await Promise.all([first,second]); a.motivo='mutated';
    assert.notEqual(b.motivo,'mutated');
    await f.guard.escanearEnlace('https://example.com/'); assert.equal(f.calls.length,1);
});
test('la caché vence, tiene capacidad limitada y conserva la política de URL pública', async () => {
    const { crearEscanerEnlaces } = require('../utils/linkGuard');
    let now = 0, calls = 0;
    const scan = crearEscanerEnlaces({ now: () => now, maxEntries: 2, scan: async url => {
        calls++; return { cleanUrl: url, resultados: { cobertura: { google: 'consultado' } } };
    } });
    await scan('https://a.example/'); await scan('https://a.example/'); assert.equal(calls, 1);
    now += 120_001; await scan('https://a.example/'); assert.equal(calls, 2);
    await scan('https://b.example/'); await scan('https://c.example/'); await scan('https://a.example/'); assert.equal(calls, 5);
    await assert.rejects(scan('http://127.1/'), /HTTP/); assert.equal(calls, 5);
});
test('fallos, ausencia de clave y consultas sin resultados se distinguen', async () => {
    const f = fixture({ URLHAUS_KEY: 'fake', GOOGLE_SAFE_BROWSING_KEY: 'fake', VIRUSTOTAL_KEY: 'fake' }, async url => {
        if (url.includes('urlhaus')) return { data: { query_status: 'no_results' } };
        throw Error('provider offline');
    });
    const r = await f.guard.escanearEnlace('https://example.com/');
    assert.equal(r.resultados.cobertura.urlhaus, 'consultado');
    assert.equal(r.resultados.cobertura.google, 'error');
    assert.equal(r.resultados.cobertura.virustotal, 'sin_analisis');
    assert.equal(r.resultados.cobertura.ipqs, 'sin_configurar');
    assert.equal(r.resultados.esPhishingGoogle, null);
});
test('el resultado conserva solo indicadores necesarios del proveedor', async () => {
    const f = fixture({ URLHAUS_KEY: 'fake' }, async () => ({ data: { query_status: 'no_results', extra: 'unnecessary-provider-data' } }));
    const result = await f.guard.escanearEnlace('https://example.com/');
    assert.ok(!JSON.stringify(result).includes('unnecessary-provider-data'));
});
