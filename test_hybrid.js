// test_hybrid.js — Ejecuta con: node test_hybrid.js
require('dotenv').config();
const axios = require('axios');

const KEY = process.env.HYBRID_ANALYSIS_KEY;

async function test() {
    console.log('=== Hybrid Analysis API Diagnostic ===');
    console.log(`KEY cargada: ${KEY ? `"${KEY.substring(0, 8)}..." (${KEY.length} chars)` : '❌ NO ENCONTRADA en .env'}`);
    console.log(`KEY tiene espacios: ${/\s/.test(KEY)}`);
    console.log(`KEY tiene comillas: ${/['"]/.test(KEY)}`);
    console.log('');

    if (!KEY) {
        console.error('❌ HYBRID_ANALYSIS_KEY no está definida en tu .env');
        return;
    }

    // Test 1: Verificar la key con el endpoint de key info
    console.log('--- Test 1: Verificando key con /key/current ---');
    try {
        const res = await axios.get('https://www.hybrid-analysis.com/api/v2/key/current', {
            headers: {
                'api-key': KEY,
                'User-Agent': 'Falcon Sandbox'
            }
        });
        console.log('✅ Key válida. Info:', JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.error('❌ Key inválida o sin acceso:', JSON.stringify(e.response?.data || e.message, null, 2));
        console.log('');
        console.log('👉 Ve a https://www.hybrid-analysis.com/my-account y genera una nueva API key.');
        return;
    }

    // Test 2: Quick-scan con la key verificada
    console.log('');
    console.log('--- Test 2: Quick-scan de URL de prueba ---');
    try {
        const params = new URLSearchParams();
        params.append('url', 'https://example.com');
        params.append('environment_id', '330');

        const res = await axios.post(
            'https://www.hybrid-analysis.com/api/v2/quick-scan/url',
            params,
            {
                headers: {
                    'api-key': KEY,
                    'User-Agent': 'Falcon Sandbox',
                    'Content-Type': 'application/x-www-form-urlencoded'
                }
            }
        );
        console.log('✅ Quick-scan exitoso:', JSON.stringify(res.data, null, 2));
    } catch (e) {
        console.error('❌ Quick-scan falló:', JSON.stringify(e.response?.data || e.message, null, 2));
    }
}

test();