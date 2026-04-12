//setup-playdl.js
require('dotenv').config();
const playdl = require('play-dl');
const fs = require('fs');

async function setup() {
    try {
        // Autenticamos play-dl con la cookie
        const cookie = fs.readFileSync('./youtube-cookie.json', 'utf-8').trim()
                        .replace(/^"|"$/g, '');
        
        await playdl.setToken({
            youtube: { cookie }
        });
        console.log('Cookie configurada en play-dl');

        const results = await playdl.search('Ryuseigun Midnight Grand Orchestra', { limit: 1 });
        console.log('Búsqueda ok:', results[0]?.title);

        const urlInfo = await playdl.video_info(results[0].url);
        console.log('Info obtenida:', urlInfo?.video_details?.title);

        const stream = await playdl.stream_from_info(urlInfo);
        console.log('Stream obtenido:', !!stream);
    } catch(e) {
        console.error('Error:', e.message);
    }
}

setup();