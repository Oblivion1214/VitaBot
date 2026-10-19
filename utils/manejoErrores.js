const { writeSync } = require('node:fs');

// No interpolar errores, mensajes, stack, objetos ni datos del entorno en estos textos.
const MENSAJES = Object.freeze({
    excepcion: 'Excepción no capturada. Se termina el proceso para permitir su reinicio.',
    rechazo: 'Promesa rechazada sin manejar. Se termina el proceso para permitir su reinicio.',
    inicioSesion: 'No se pudo iniciar la sesión de Discord. Se termina el proceso.',
    comando: 'No se pudo ejecutar un comando.',
    interaccion: 'No se pudo responder a una interacción.',
    limpieza: 'Una tarea de cierre no pudo completarse.',
    plazoCierre: 'Se agotó el plazo de cierre. Se termina el proceso.',
    interno: 'Ocurrió un error interno.',
});

function instalarManejoErrores({ proceso = process, escribir = texto => writeSync(2, texto),
    programar = setTimeout, cancelar = clearTimeout, plazoCierreMs = 3000 } = {}) {
    const tareas = [];
    let cerrando = false, fatalIniciado = false, resultados, limite;

    function registrarError(contexto) {
        // También rechaza objetos/getters como contexto, sin intentar convertirlos a texto.
        const mensaje = typeof contexto === 'string' && Object.hasOwn(MENSAJES, contexto)
            ? MENSAJES[contexto] : MENSAJES.interno;
        try { escribir('[VitaBot] ' + mensaje + '\n'); } catch { /* Un log inaccesible no impide terminar. */ }
    }
    function iniciarLimpieza() {
        if (resultados) return resultados;
        resultados = [];
        for (const tarea of tareas) {
            try { resultados.push(Promise.resolve(tarea()).then(() => true, () => false)); }
            catch { resultados.push(Promise.resolve(false)); }
        }
        return resultados;
    }
    function fatal(contexto) {
        // Escalar un segundo fatal evita recursión y nunca permite volver a código 0.
        if (fatalIniciado) { proceso.exit(1); return; }
        fatalIniciado = true; cerrando = true; proceso.exitCode = 1;
        if (limite) cancelar(limite);
        registrarError(contexto);
        // Limpieza inmediata de recursos conocidos; no reanudar el bucle tras un fatal.
        try { iniciarLimpieza(); } finally { proceso.exit(1); }
    }
    function cerrar() {
        if (cerrando) return;
        cerrando = true;
        limite = programar(() => {
            if (fatalIniciado) return;
            fatalIniciado = true; proceso.exitCode = 1;
            registrarError('plazoCierre'); proceso.exit(1);
        }, plazoCierreMs);
        // Un cierre normal espera Discord sin impedir los otros intentos de limpieza.
        Promise.all(iniciarLimpieza()).then(estado => {
            if (fatalIniciado) return;
            cancelar(limite);
            const fallo = estado.some(correcto => !correcto);
            if (fallo) registrarError('limpieza');
            proceso.exit(fallo ? 1 : 0);
        }).catch(() => fatal('limpieza'));
    }
    // PM2 instala listeners que imprimen el error crudo: salir antes de que se ejecuten.
    proceso.prependListener('uncaughtException', () => fatal('excepcion'));
    proceso.prependListener('unhandledRejection', () => fatal('rechazo'));
    proceso.on('SIGTERM', cerrar);
    proceso.on('SIGINT', cerrar);
    return {
        registrarError, fatal,
        registrarLimpieza(tarea) {
            if (cerrando || typeof tarea !== 'function') throw new Error('Registro de cierre no disponible.');
            // Cerrar primero los recursos incorporados más recientemente.
            tareas.unshift(tarea);
        },
        estaCerrando() { return cerrando; },
    };
}
module.exports = { instalarManejoErrores };
