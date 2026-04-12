const { REST, Routes } = require('discord.js');
const fs = require('fs');
require('dotenv').config();

const commands = [];
// Leemos todos los archivos de tu carpeta commands
const commandFiles = fs.readdirSync('./commands').filter(file => file.endsWith('.js'));

for (const file of commandFiles) {
    const command = require(`./commands/${file}`);
    // Transformamos los datos a un formato que Discord entienda
    commands.push(command.data.toJSON());
}

// Preparamos la conexión con Discord
const rest = new REST({ version: '10' }).setToken(process.env.TOKEN);

// Función para enviar los comandos
(async () => {
    try {
        console.log(`Subiendo ${commands.length} Slash Commands a Discord...`);

        // Esto sobreescribe los comandos globales de tu bot
        const data = await rest.put(
            Routes.applicationCommands(process.env.CLIENT_ID),
            { body: commands },
        );

        console.log(`¡Éxito! ${data.length} comandos registrados.`);
    } catch (error) {
        console.error("Hubo un error al registrar los comandos:", error);
    }
})();