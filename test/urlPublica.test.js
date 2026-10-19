const test = require('node:test');
const assert = require('node:assert/strict');
const { EventEmitter } = require('node:events');
const { interpretarUrlPublica, esDireccionPublica, coincideHost, expandirUrlPublica } = require('../utils/urlPublica');

test('rechaza variantes numéricas, protocolos, credenciales y puertos internos', () => {
    for (const value of ['http://127.1', 'http://2130706433', 'http://0x7f000001', 'http://0177.0.0.1',
        'http://10.2.3.4', 'http://100.100.213.77', 'http://169.254.169.254', 'http://[::1]',
        'http://[::ffff:127.0.0.1]', 'http://[64:ff9b::a00:1]', 'http://localhost.',
        'http://x.local', 'file:///etc/passwd', 'ftp://example.com', 'https://user:pass@example.com', 'https://example.com:3001']) {
        assert.throws(() => interpretarUrlPublica(value), /HTTP/);
    }
    assert.equal(interpretarUrlPublica('https://example.com:443/path#fragment').href, 'https://example.com/path');
});
test('admite direcciones globales y rechaza rangos especiales IPv4 e IPv6', () => {
    for (const address of ['8.8.8.8', '1.1.1.1', '2606:4700:4700::1111', '2001:4860:4860::8888']) assert.equal(esDireccionPublica(address), true, address);
    for (const address of ['0.0.0.0', '172.31.1.1', '192.168.1.2', '192.0.2.1', '224.0.0.1', '255.255.255.255',
        'fc00::1', 'fe80::1', '2001:db8::1', '2002:a00:1::1', '::ffff:8.8.8.8']) assert.equal(esDireccionPublica(address), false, address);
});
test('la coincidencia de dominio exige un límite de etiqueta', () => {
    assert.equal(coincideHost('WWW.YouTube.com.', 'youtube.com'), true);
    assert.equal(coincideHost('youtube.com', 'youtube.com'), true);
    assert.equal(coincideHost('falsoyoutube.com', 'youtube.com'), false);
    assert.equal(coincideHost('youtube.com.evil.example', 'youtube.com'), false);
});
function transport(routes, calls) {
    return (url, options, callback) => {
        const request = new EventEmitter();
        request.end = () => {
            options.lookup(url.hostname, { all: true }, (error, addresses) => {
                if (error) return request.emit('error', error);
                calls.push({ url: url.href, addresses, method: options.method });
                const response = new EventEmitter();
                Object.assign(response, { statusCode: 200, headers: {}, destroy() {} }, routes[url.href]);
                callback(response);
            });
        };
        return request;
    };
}
test('sigue redirecciones públicas relativas y fija la IP validada al socket', async () => {
    const calls = [], lookups = [];
    const result = await expandirUrlPublica('https://short.example/start', {
        lookup: async host => { lookups.push(host); return [{ address: '8.8.8.8', family: 4 }]; },
        request: transport({ 'https://short.example/start': { statusCode: 302, headers: { location: '/final' } } }, calls),
    });
    assert.deepEqual(result.ruta, ['https://short.example/start', 'https://short.example/final']);
    assert.equal(lookups.length, 2);
    assert.ok(calls.every(call => call.addresses[0].address === '8.8.8.8'));
});
test('una redirección privada se bloquea antes de enviar la segunda petición', async () => {
    const calls = [];
    await assert.rejects(expandirUrlPublica('https://short.example/', {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        request: transport({ 'https://short.example/': { statusCode: 302, headers: { location: 'http://169.254.169.254/' } } }, calls),
    }), /HTTP/);
    assert.equal(calls.length, 1);
});
test('rechaza DNS privado, respuestas mixtas y cambio de DNS entre saltos', async () => {
    for (const records of [[{ address: '10.0.0.1', family: 4 }], [{ address: '8.8.8.8', family: 4 }, { address: '::1', family: 6 }]]) {
        const calls = [];
        await assert.rejects(expandirUrlPublica('https://host.example/', { lookup: async () => records, request: transport({}, calls) }), /HTTP/);
        assert.equal(calls.length, 0);
    }
    let resolutions = 0; const calls = [];
    await assert.rejects(expandirUrlPublica('https://host.example/', {
        lookup: async () => [{ address: ++resolutions === 1 ? '8.8.8.8' : '127.0.0.1', family: 4 }],
        request: transport({ 'https://host.example/': { statusCode: 302, headers: { location: '/next' } } }, calls),
    }), /HTTP/);
    assert.equal(calls.length, 1);
});
test('el fallback GET mantiene el mismo límite de destino y no descarga el cuerpo', async () => {
    const calls = [];
    const request = transport({}, calls);
    const result = await expandirUrlPublica('https://host.example/', {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        request(url, options, callback) { return request(url, options, response => { response.statusCode = options.method === 'HEAD' ? 405 : 200; callback(response); }); },
    });
    assert.equal(result.urlFinal, 'https://host.example/');
    assert.deepEqual(calls.map(call => call.method), ['HEAD', 'GET']);
});
test('un endpoint público que corta la conexión aún permite consultar su reputación', async () => {
    const result = await expandirUrlPublica('https://offline.example/', {
        lookup: async () => [{ address: '8.8.8.8', family: 4 }],
        request() { const request = new EventEmitter(); request.end = () => request.emit('error', Error('reset')); return request; },
    });
    assert.equal(result.urlFinal, 'https://offline.example/');
    assert.equal(result.expansionCompleta, false);
});
