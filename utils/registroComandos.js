const { Routes } = require('discord.js');
const { validarIdentidadEjecucion, verificarAplicacionPruebas, esEntornoPruebas } = require('./identidadEjecucion');
async function registrarComandos({ rest, comandos, env = process.env, raiz = process.cwd(), consultar = fetch, argumentos = process.argv }) {
    validarIdentidadEjecucion(env, raiz, argumentos);
    await verificarAplicacionPruebas(env, raiz, { consultar, argumentos });
    const ruta = esEntornoPruebas(env, argumentos)
        ? Routes.applicationGuildCommands(env.CLIENT_ID, env.TEST_GUILD_ID) : Routes.applicationCommands(env.CLIENT_ID);
    return rest.put(ruta, { body: comandos });
}
module.exports = { registrarComandos };
