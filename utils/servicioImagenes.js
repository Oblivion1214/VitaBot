const { HfInference } = require('@huggingface/inference');
const translate = require('google-translate-api-x');
const { crearPoliticaSolicitudes } = require('./politicaSolicitudes');
const MAXIMO_BYTES_IMAGEN = 8 * 1024 * 1024;
async function consultarConLimite(url, options, fetchImpl = fetch, limit = MAXIMO_BYTES_IMAGEN) {
    const response = await fetchImpl(url, options);
    if (!response.body) return response;
    if (Number(response.headers.get('content-length')) > limit) { await response.body.cancel(); throw Error('Respuesta demasiado grande.'); }
    let size = 0;
    const bounded = new Response(response.body.pipeThrough(new TransformStream({ transform(chunk, controller) {
        size += chunk.byteLength;
        if (size > limit) throw Error('Respuesta demasiado grande.');
        controller.enqueue(chunk);
    } })), { status: response.status, statusText: response.statusText, headers: response.headers });
    Object.defineProperty(bounded, 'url', { value: response.url });
    return bounded;
}
function crearServicioImagenes({ env = process.env, factory = key => new HfInference(key), translateImpl = translate, now = Date.now,
    policy = crearPoliticaSolicitudes({ concurrent: 1, queued: 1, perMinute: 2 }) } = {}) {
    let cooldownUntil = 0;
    return {
        async generate(prompt, scope) {
            if (!env.HF_TOKEN || typeof prompt !== 'string' || !prompt.trim() || prompt.length > 1000) throw Error('Solicitud no disponible.');
            return policy.run(scope, async () => {
                if (now() < cooldownUntil) throw Error('Proveedor ocupado.');
                let translated = prompt;
                try { translated = (await translateImpl(prompt, { to: 'en', requestOptions: { signal: AbortSignal.timeout(5000) },
                    requestFunction: (url, options) => consultarConLimite(url, options, fetch, 64 * 1024) })).text || prompt; }
                catch { /* Keep the original prompt if optional translation is unavailable. */ }
                const models = (env.HF_IMAGE_MODELS || 'black-forest-labs/FLUX.1-schnell,stabilityai/stable-diffusion-xl-base-1.0')
                    .split(',').map(s => s.trim()).filter(s => /^[\w.-]+\/[\w.-]+$/.test(s)).slice(0, 2);
                const end = now() + 40_000, hf = factory(env.HF_TOKEN);
                for (const model of models) {
                    const remaining = Math.min(25_000, end - now()); if (remaining <= 0) break;
                    try {
                        const blob = await hf.textToImage({ model, inputs: translated.slice(0, 2000), parameters: {
                            guidance_scale: 7.5, num_inference_steps: model.includes('FLUX') ? 4 : 30,
                        } }, { signal: AbortSignal.timeout(remaining), retry_on_error: false, fetch: consultarConLimite });
                        if (!blob || blob.size > MAXIMO_BYTES_IMAGEN || !['image/png', 'image/jpeg', 'image/webp'].includes(blob.type)) throw Error('Imagen no válida.');
                        return { blob, model };
                    } catch (error) {
                        const status = Number(error.httpResponse?.status ?? error.status);
                        if ([401, 403].includes(status)) break;
                        if (status === 429) { cooldownUntil = now() + 30_000; break; }
                    }
                }
                throw Error('La generación no está disponible.');
            });
        },
    };
}
const imagenes = crearServicioImagenes();
module.exports = { imagenes, crearServicioImagenes, consultarConLimite };
