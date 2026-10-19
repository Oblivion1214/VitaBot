const { REST } = require('discord.js');
const fs = require('fs');
require('dotenv').config({ override: true, quiet: true });
require('./utils/identidadEjecucion').validarIdentidadEjecucion();
const { registrarComandos } = require('./utils/registroComandos');

const commands = [];
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    commands.push(command.data.toJSON());
}

// Preparamos la conexión con Discord
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// Función para enviar los comandos
(async () => {
    try {
        console.log(`Subiendo ${commands.length} Slash Commands a Discord...`);
        const data = await registrarComandos({ rest, comandos: commands });

        console.log(`¡Éxito! ${data.length} comandos registrados.`);
    } catch (error) {
        console.error('No se pudieron registrar los comandos. Revisa la identidad y los permisos configurados.');
        process.exitCode = 1;
    }
})();
