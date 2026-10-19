const dns = require('node:dns').promises;
const net = require('node:net');
const http = require('node:http');
const https = require('node:https');

const blocked = new net.BlockList();
for (const [address, prefix] of [
    ['0.0.0.0', 8], ['10.0.0.0', 8], ['100.64.0.0', 10], ['127.0.0.0', 8],
    ['169.254.0.0', 16], ['172.16.0.0', 12], ['192.0.0.0', 24], ['192.0.2.0', 24],
    ['192.88.99.0', 24], ['192.168.0.0', 16], ['198.18.0.0', 15],
    ['198.51.100.0', 24], ['203.0.113.0', 24], ['224.0.0.0', 4], ['240.0.0.0', 4],
]) blocked.addSubnet(address, prefix, 'ipv4');
const globalV6 = new net.BlockList(); globalV6.addSubnet('2000::', 3, 'ipv6');
for (const [address, prefix] of [['2001::', 23], ['2001:db8::', 32], ['2002::', 16], ['3fff::', 20]]) {
    blocked.addSubnet(address, prefix, 'ipv6');
}

class ErrorUrlNoSegura extends Error {
    constructor() { super('Solo se permiten URLs HTTP(S) públicas, sin credenciales y con puerto estándar.'); this.name = 'ErrorUrlNoSegura'; }
}
function esDireccionPublica(address) {
    const family = net.isIP(address);
    return family === 4 ? !blocked.check(address, 'ipv4')
        : family === 6 && globalV6.check(address, 'ipv6') && !blocked.check(address, 'ipv6');
}
function interpretarUrlPublica(value) {
    let url;
    try { url = new URL(value); } catch { throw new ErrorUrlNoSegura(); }
    if (String(value).length > 4096 || !['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port) {
        throw new ErrorUrlNoSegura();
    }
    const host = url.hostname.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
    if (!host || host === 'localhost' || host.endsWith('.localhost') || host.endsWith('.local') ||
        (net.isIP(host) && !esDireccionPublica(host))) throw new ErrorUrlNoSegura();
    url.hash = '';
    return url;
}
function coincideHost(host, domain) {
    const canonical = host.toLowerCase().replace(/\.$/, '');
    return canonical === domain || canonical.endsWith(`.${domain}`);
}
function within(promise, signal) {
    return new Promise((resolve, reject) => {
        const abort = () => reject(new Error('Tiempo de análisis agotado.'));
        signal.addEventListener('abort', abort, { once: true });
        if (signal.aborted) abort();
        Promise.resolve(promise).then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
    });
}
async function resolverDireccionPublica(url, lookup = dns.lookup.bind(dns), signal = AbortSignal.timeout(5000)) {
    const host = url.hostname.replace(/^\[|\]$/g, '');
    const records = net.isIP(host) ? [{ address: host, family: net.isIP(host) }]
        : await within(lookup(host, { all: true, verbatim: true }), signal);
    if (!records.length || records.some(record => !esDireccionPublica(record.address))) throw new ErrorUrlNoSegura();
    return records.slice().sort((a, b) => a.family - b.family);
}
async function requestHeaders(url, method, { lookup, request } = {}) {
    const signal = AbortSignal.timeout(5000);
    const records = await resolverDireccionPublica(url, lookup, signal);
    // DNS is checked once and pinned to this socket. Native agents do not inherit HTTP_PROXY.
    const secure = url.protocol === 'https:';
    const agent = secure ? new https.Agent({ keepAlive: false }) : new http.Agent({ keepAlive: false });
    try {
        return await new Promise((resolve, reject) => {
            const req = (request || (secure ? https.request : http.request))(url, {
                method, agent, signal, maxHeaderSize: 16384,
                headers: { 'User-Agent': 'VitaBot-LinkGuard' },
                lookup(_hostname, options, callback) {
                    const selected = records[0];
                    if (options?.all) callback(null, [selected]);
                    else callback(null, selected.address, selected.family);
                },
            }, response => {
                resolve({ status: response.statusCode, location: response.headers.location });
                response.destroy(); // Never download a user-supplied response body.
            });
            req.on('error', reject); req.end();
        });
    } finally { agent.destroy(); }
}
async function expandirUrlPublica(value, dependencies = {}) {
    let url = interpretarUrlPublica(value);
    const ruta = [url.href];
    for (let hop = 0; hop <= 5; hop++) {
        let response;
        try {
            response = await requestHeaders(url, 'HEAD', dependencies);
            if ([405, 501].includes(response.status)) response = await requestHeaders(url, 'GET', dependencies);
        } catch (error) {
            if (error instanceof ErrorUrlNoSegura) throw error;
            // Offline endpoints still need reputation checks. No unvetted socket was opened.
            return { urlFinal: url.href, ruta, expansionCompleta: false };
        }
        if (![301, 302, 303, 307, 308].includes(response.status) || !response.location) {
            return { urlFinal: url.href, ruta };
        }
        if (hop === 5) throw new Error('Demasiadas redirecciones.');
        url = interpretarUrlPublica(new URL(response.location, url).href);
        ruta.push(url.href);
    }
}
module.exports = { ErrorUrlNoSegura, esDireccionPublica, interpretarUrlPublica, coincideHost, resolverDireccionPublica, expandirUrlPublica };
