# VitaBot

Bot de Discord con música, voz, moderación, juegos y conversación con Vita.
Requiere Node.js 22.12 o superior.

El despliegue del servidor privado usa dos contenedores: `bot` para Discord y
`audio` para yt-dlp, FFmpeg y voz. Los secretos y el estado se guardan fuera de
las imágenes. Consulta [la guía de Docker](docker/LEEME.md) para instalar y operar
el servicio. La configuración anterior de VM con PM2 y PC con Windows se
documenta más abajo como alternativa y respaldo. El bot de pruebas independiente
permanece pendiente y no debe compartir la identidad ni el estado del principal.

## Arquitectura de audio v2

```text
Discord ← paquetes Opus ← bot (@discordjs/voice, colas por servidor)
                              ↑ streaming HTTP autenticado en la red de Compose
                         audio (yt-dlp + FFmpeg/libopus)
```

El proceso del bot es el único cliente de Discord. Conserva una cola por servidor,
gestiona los controles y envía Opus a voz. El servicio de audio resuelve búsquedas
y listas, descarga y convierte mientras transmite; no inicia sesión en Discord
ni carga la canción completa en la memoria del bot. Ambos pueden ejecutarse en
el mismo servidor con Docker, o separados por Tailscale en la alternativa VM/PC.
El transporte aplica backpressure y búferes limitados. `/decir` usa el mismo flujo.

Se retiraron discord-player, su extractor y las dependencias empaquetadas de audio.
La auditoría de dependencias tiene **0 vulnerabilidades conocidas**;
el resultado actualizado está en `reports/npm-audit-operations-v3.json`.
Esto describe las alertas de npm disponibles en esa fecha.

Cada servidor tiene su propia cola, con hasta 200 pistas pendientes. El límite
de Docker es una sesión, una transmisión y una búsqueda simultáneas. Fuera de
Docker, los valores predeterminados son tres sesiones, tres transmisiones y dos
búsquedas. Al saltar, detener, abandonar voz o cerrar el consumidor, se cancela
la transmisión y se terminan los procesos del servicio de audio. Una lista que
encuentra un fallo de audio se vacía para evitar una cascada de
descargas fallidas. La conexión se cierra tras dos minutos sin pistas; una pausa
se limita a quince minutos. Si el servicio de audio falla, los demás comandos
siguen activos.

El audio se convierte a Opus estéreo de 48 kHz, con objetivo de hasta 128 kbps,
ajustado al bitrate del canal. `/audiostats` muestra el estado y ese objetivo.
No se anuncia una tasa de la fuente ni una calidad que no se haya medido.

## Alternativa: configuración de la VM

```sh
npm ci --omit=dev
cp .env.example .env
# Completar TOKEN, CLIENT_ID y las claves de los servicios que se usarán.
node scripts/configurar-audio.js --url http://IP_TAILSCALE_PC:3001
node deploy-commands.js
npm start
```

`configurar-audio.js` deriva localmente una clave de audio separada por propósito
desde el TOKEN existente. Ejecutándolo en ambos hosts con el mismo TOKEN se obtiene
la misma clave sin copiarla por terminales ni publicarla. Si cambia TOKEN, vuelve
a ejecutar la configuración en ambos hosts y reinicia ambos procesos. También se
puede configurar manualmente la misma clave aleatoria de al menos 32 caracteres en
`AUDIO_SHARED_TOKEN` de ambos archivos de entorno.

No omitas las dependencias opcionales durante la instalación: algunas corresponden
al transporte y cifrado de voz. No hace falta instalar binarios de audio en la VM.
Con PM2: `pm2 start ecosistema.config.cjs`, seguido de `pm2 save`.
Nunca ejecutes principal y pruebas a la vez si comparten TOKEN.

## Configuración de la PC

Instala Node.js, yt-dlp con su componente EJS, FFmpeg con libopus y Tailscale.
La instalación Windows usada aquí se comprobó con Node 24.22.0, yt-dlp 2026.08.19,
FFmpeg/ffprobe de yt-dlp, Deno 2.9.7 y Python 3.13.15. Puede instalarse con WinGet:

```powershell
winget install --id OpenJS.NodeJS.LTS --exact --source winget
winget install --id yt-dlp.yt-dlp --exact --source winget
winget install --id Python.Python.3.13 --exact --source winget
winget install --id Tailscale.Tailscale --exact --source winget
```

Conecta la PC y la VM a la misma red Tailscale y abre una terminal nueva para
actualizar PATH. El worker usa solo módulos integrados de Node; no requiere
`npm install`. Copia `audio/` y `utils/herramientasAudio.js`, o usa este checkout completo.

En un checkout que ya contiene el `.env` con el mismo TOKEN que la VM:

```powershell
node scripts/configurar-audio.js --url http://IP_TAILSCALE_PC:3001 --worker --bind IP_TAILSCALE_PC
node scripts/comprobar-audio.js
node audio/servidor.js
```

En una instalación independiente, copia `.env.audio.example` a `.env.audio` y
completa la clave compartida y la IP privada. El worker **solo carga `.env.audio`**;
no necesita TOKEN ni otras claves del bot. Busca las herramientas en PATH/WinGet;
puedes fijarlas con `FFMPEG_PATH` y `YTDLP_PATH`. Se pasa explícitamente el runtime
de Node a yt-dlp. [Documentación de EJS](https://github.com/yt-dlp/yt-dlp/wiki/EJS).

Escucha en loopback por defecto. En producción se debe enlazar a la IP de Tailscale
de la PC y mantener el puerto dentro de la red privada. Todas las rutas, incluido
`/health`, requieren `Authorization: Bearer ...`. Ya no existe el webhook de la VM
en el puerto 8080 ni la API anterior de controles en el puerto 3000.

Si YouTube exige una sesión, configura `YOUTUBE_COOKIES_PATH` en `.env.audio`;
por defecto se busca `config/youtube-cookie.txt`. El archivo permanece en la PC y
se entrega a yt-dlp para las solicitudes autorizadas a YouTube. No incluyas cookies,
archivos `.env` ni respaldos privados en commits o paquetes de despliegue.

## Funciones y comprobaciones

`/play` admite búsquedas con menú de selección, videos y listas de YouTube, y
canciones individuales de Spotify mediante búsqueda de una coincidencia en YouTube.
Las listas se limitan a cien entradas por solicitud. No se implementa descarga
directa de audio de Spotify. `/pause`, `/skip`, `/stop`, `/disconn`, `/queue`,
`/letra`, `/audiostats` y los botones usan la misma sesión. Los controles requieren
estar en el mismo canal de voz. Las listas y sesiones no sobreviven a un reinicio.

```sh
npm test
npm audit
node scripts/probar-audio.js --youtube --tts
```

Las pruebas automáticas usan simulaciones y HTTP local; no consumen servicios.
`probar-audio.js` sí consulta el worker: resuelve el clip público de prueba,
verifica Ogg, cancela el stream y comprueba que los trabajos se liberen. Usa las
cookies configuradas para YouTube y envía una frase de prueba a Google TTS.
La escucha final y los controles se comprueban en Discord, primero en pruebas.

## Configuración y confirmación de unión

La configuración de auditoría y la confirmación de unión se guardan juntas.
Por defecto se usa `config/audit-config.json`; `AUDIT_CONFIG_PATH` permite fijar
una ubicación privada fuera de los checkouts. Las copias de despliegue de una misma identidad deben apuntar a ese mismo archivo para no olvidar aceptaciones al cambiar de copia. Una instancia de pruebas independiente usa otra identidad y archivos propios. En la VM se configuró esa ruta compartida conservando las aceptaciones
existentes y los ajustes de producción. No compartas el archivo entre bots con
tokens distintos.

`node scripts/compartir-configuracion-auditoria.js` migra ambas copias y sus variables de entorno
con las opciones `--root RUTA_PRINCIPAL --secondary RUTA_PRUEBAS
--target ARCHIVO_COMPARTIDO --backup CARPETA_RESPALDO`.
Requiere el mismo TOKEN, respalda los originales y conserva
las confirmaciones válidas de cualquiera de las dos copias. Las escrituras son
atómicas; un archivo dañado o un fallo de guardado ya no se interpreta como una
configuración nueva ni se anuncia como una confirmación exitosa.

El protocolo conserva la retirada tras diez minutos sin completar el setup. Un
temporizador pendiente vuelve a verificar la confirmación antes de abandonar el
servidor. Las sesiones duplicadas y los paneles anteriores no pueden retirar un
bot ya confirmado. `/config` sigue disponible para administradores autorizados.

## Conversación con Vita

`/chatconvita` sirve para charlar y divertirse con la personalidad de Vita, de
*Mahou Shoujo Lyrical Nanoha*: anime, videojuegos, historias, bromas y adivinanzas.
Declina las peticiones de programación y ayuda técnica con IA; no ofrece tareas
ni tutorías. Las peticiones técnicas claras se responden localmente, sin consumir
Gemini, y se descartan respuestas que contengan código. La personalidad y las
instrucciones de confidencialidad están en `config/personalidadVita.js`.
Estas restricciones pertenecen al chat; `/analizar` conserva su función de revisar enlaces.

La respuesta se publica en el canal donde se ejecuta el comando. El comando no
copia mensajes ni respuestas a los logs y no conserva historial. Envía a Gemini
la instrucción de personalidad y el mensaje
actual; no adjunta perfiles de Discord, archivos del proyecto ni conversaciones
de otros usuarios. El mensaje sí es procesado por Google. Las instrucciones de
comportamiento no garantizan que el modelo nunca se equivoque.

Configura `GEMINI_API_KEY`. `GEMINI_CHAT_MODELS` permite hasta ocho IDs separados por
comas, en orden de preferencia. Por defecto intenta 3.5 Flash-Lite, 3.1 Flash-Lite,
3.6 Flash, 3.8 Flash y 3 Flash Preview. Los modelos antiguos pueden añadirse si
Google aún permite usarlos en el proyecto. `GEMINI_ANALYSIS_MODELS` permite una
lista independiente para `/analizar`.

Se limita la entrada a mil caracteres y cada intento a quince segundos, con un
presupuesto total de treinta y cinco segundos para toda la lista. Las cuotas por
modelo respetan la espera indicada por Google y permiten probar otro respaldo;
las cuotas generales detienen todos los intentos. Los fallos temporales y los
modelos no disponibles se recuerdan para evitar consultas repetidas. Los logs
`[Gemini]` muestran solo modelo, tipo de operación, motivo y código HTTP; nunca
claves, mensajes, respuestas, IDs personales ni errores crudos del proveedor.
Al modificar los comandos, regístralos nuevamente.

Los demás comandos incluyen configuración de servidor, roles, limpieza de
mensajes, análisis de enlaces, estadísticas, generación de imágenes y juegos.
Consulta `PRIVACY.md` y `TOS.md` para el tratamiento de datos y las condiciones.

## Enlaces, roles y cuarentena

El analizador solo abre URLs HTTP(S) con puertos estándar y sin credenciales.
Bloquea IPs privadas, loopback, Tailscale, link-local y rangos especiales, también
en IPv6 y en cada redirección. Resuelve DNS y fija una dirección pública validada
al socket, sin proxies heredados ni descarga del cuerpo. Un fallo de transporte
no evita consultar la reputación; un destino interno sí detiene el análisis.
Los dominios conocidos ya no se saltan el escáner. Hay hasta tres análisis
simultáneos; si están ocupados, no se encolan solicitudes ilimitadas.

urlscan está desactivado salvo que URLSCAN_ENABLED=true. Incluso activado solo
solicita informes privados, omite URLs con parámetros de consulta y nunca pasa a
public si el plan rechaza private. Las demás APIs configuradas siguen recibiendo
las URLs para comprobar su reputación. La extensión de un archivo por sí sola
no confirma malware ni provoca un borrado automático.

Los menús de /roles se registran con servidor, canal, mensaje y creador. Solo
admiten permisos normales de chat y voz. Se comprueban también los permisos
concedidos al rol mediante overwrites de canal. Cada clic actualiza los roles,
permisos y jerarquías de Discord y comprueba que el creador siga autorizado.
Los paneles antiguos deben recrearse con /roles; los nuevos caducan a los 90 días.

Antes de borrar un mensaje, la cuarentena guarda su texto completo y entrega
un panel en un canal privado accesible al bot. Si falta espacio, permisos,
persistencia o entrega, conserva el original. También conserva los originales
con adjuntos, encuestas, stickers o mensajes reenviados que no puede reconstruir
íntegramente. Vuelve a comprobar el texto antes de borrarlo. Ver mensaje entrega
la copia únicamente como respuesta efímera a un moderador autorizado; aprobar y
rechazar requieren Gestionar mensajes en el canal original y acceso al de revisión.
Los mensajes largos se restauran en un archivo de texto, sin recortes ni menciones.
La copia publicada por Vita no recupera el ID, la autoría real ni las reacciones.

El estado se escribe atómicamente en security-state.json junto a AUDIT_CONFIG_PATH;
SECURITY_STATE_PATH permite cambiarlo. Las copias de despliegue de una misma identidad deben
compartirlo; pruebas independiente usa archivos propios. No lo subas a Git. Tiene límites de 100 casos y 200 paneles, bloqueo
entre procesos y transiciones que impiden dos decisiones sobre el mismo caso.
Las copias locales vencen a los 7 días; la limpieza ocurre al escribir y cada hora,
sin base de datos ni servicios adicionales. No ejecutes ambas copias del bot a la vez.

Si el proceso termina justo durante una escritura, puede quedar security-state.json.lock.
El sistema no lo roba automáticamente: detén todas las copias del bot, conserva
el JSON y elimina únicamente ese archivo .lock antes de reiniciar. Una restauración
con resultado de red ambiguo no se repite automáticamente: Ver mensaje permite
recuperar el texto y comprobar el canal antes de una recuperación manual.

Las cookies ya no se siguen en el índice local de Git; el archivo local se conserva.
La eliminación debe incluirse en el próximo commit. Los ocho commits antiguos de
las referencias remotas todavía contienen el archivo: renueva la sesión de YouTube
y sustituye las cookies locales. Esta corrección no reescribe ni fuerza el historial.

## Límites de servicios y SDK Gemini

Se migró de @google/generative-ai al SDK mantenido @google/genai 2.30.0,
compatible con Node >=20 (el proyecto conserva Node >=22.12). Se carga solo al
usar Gemini. Chat y análisis comparten servicio, configuración, dos solicitudes
activas, cuatro en espera por hasta cinco segundos, seis solicitudes por minuto
por servidor y doce globales. Hay hasta tres modelos alternativos, quince segundos
por intento y treinta y cinco segundos en total. Las respuestas 429 detienen los
intentos y activan treinta segundos de enfriamiento. Los reintentos y continuaciones
implícitos del SDK están desactivados. Un bloqueo de seguridad no cambia de modelo.
No hay caché de conversaciones ni historial. GEMINI_ANALYSIS_MODELS permite
separar la selección del análisis; sin ella se usa GEMINI_CHAT_MODELS o los valores
por defecto. La prueba real del SDK se hizo con una frase pública de diagnóstico.
Documentación: https://ai.google.dev/gemini-api/docs/libraries

El analizador agrupa consultas en curso de una misma URL y conserva hasta doscientos
resultados técnicos en RAM: dos minutos con cobertura completa y treinta segundos
si está incompleta. No se escribe la caché en disco. Solo hay tres análisis activos
y seis pendientes, con espera máxima de cinco segundos; hasta doce consultas nuevas
por minuto por servidor y treinta globales. Las URLs internas siguen bloqueadas.
Además, las consultas por proveedor se limitan localmente a 12/min URLhaus, 30/min
Google, 10/min IPQS y 4/min VirusTotal. Son límites preventivos locales, no una
promesa sobre la cuota del plan contratado. Una consulta ausente, fallida, limitada
localmente o sin análisis previo se muestra de manera distinta de una consultada.
Un enlace con indicadores tampoco se presenta como completamente limpio.
La explicación de Gemini recibe dominios y resultados técnicos, sin query strings.

/imagine tiene un trabajo activo y uno en espera, dos solicitudes por minuto por
servidor, hasta dos modelos y respuesta de hasta 8 MiB. La traducción opcional tiene
cancelación; si falla se conserva el prompt original. Los intentos de generación
tienen un máximo de 25 segundos cada uno y 40 segundos de presupuesto después de
la traducción. No se copian prompts a los logs de auditoría. HF_IMAGE_MODELS acepta
hasta dos IDs. No se cambian claves ni se activan suscripciones de pago.

## Operación sin servicios adicionales en la VM

El proceso del bot rota sus logs de PM2 cada minuto cuando superan 2 MiB. Conserva
hasta dos archivos de historial con la cola reciente de cada log. Usa copytruncate
para mantener el descriptor abierto por PM2; líneas escritas entre copia y truncado
pueden perderse. Estos logs son operativos; los casos recuperables se guardan aparte.
La ruta predeterminada es ~/.pm2/logs/vitabot-{out,error}.log; PM2_HOME puede cambiarla.

Junto a AUDIT_CONFIG_PATH se guardan respaldos privados en backups/: hasta siete
instantáneas diarias de auditoría y estado, sin archivos .env ni cookies. Se revisan
cada hora y retiran también casos vencidos de las copias, respetando la caducidad
del contenido. Un original corrupto no sustituye una copia válida. Son copias locales:
permiten recuperarse de cambios o archivos dañados, pero no de perder el disco de la
VM. Para restaurar, detén el bot, conserva el estado actual y coloca la copia elegida
en la ruta configurada antes de iniciar. Las copias no deben subirse al repositorio.

En Windows, audio/supervisor.js mantiene un solo worker, comprueba /health cada
30 segundos, reinicia tras dos fallos y aplica espera creciente de 1 a 30 segundos
si el worker termina. Tolera que Tailscale aún no tenga la IP al iniciar sesión.
Una tubería local impide supervisores duplicados. Los hijos cierran sus trabajos
si pierden la conexión con el supervisor. Los logs de la PC ocupan como máximo
aproximadamente 3 MiB en .cache/audio-service; allí se guardan también los PID.

Para instalar o retirar el inicio automático de la cuenta actual de Windows:

~~~powershell
./scripts/instalar-inicio-audio.ps1
./scripts/instalar-inicio-audio.ps1 -Remove
~~~

El acceso directo VitaBot Audio.lnk de la carpeta Inicio actualiza el PATH desde
la configuración de Windows y ejecuta el supervisor
oculto, sin guardar contraseñas ni ampliar privilegios. Inicia después de entrar
a esta cuenta, no antes del inicio de sesión. Retirar el acceso directo no detiene
una reproducción en curso. No debe iniciarse además otro worker manual.

## Errores y cierre del bot

`utils/manejoErrores.js` se instala al principio de `index.js`, antes del entorno
y las dependencias, con prioridad sobre los listeners de error que añade PM2.
Una excepción no capturada, un rechazo global sin manejar o
un login fallido produce un mensaje fijo y termina con código 1 para que PM2
reinicie el bot. Estos manejadores y las capturas de error del dispatcher no
imprimen objetos, mensajes, stack, claves ni datos de las solicitudes. Los errores
recuperables de comandos mantienen su respuesta local y no reinician el bot.

Tras un error fatal se intenta la limpieza inmediata de recursos conocidos y se
sale sin continuar ejecutando la aplicación. SIGTERM y SIGINT cierran una sola vez
mantenimiento, música y Discord, esperando hasta tres segundos. Una limpieza
fallida o que supera ese plazo termina con código 1; el cierre correcto usa 0.

`ecosistema.config.cjs` mantiene una instancia, da cinco segundos para detenerla y
aplica una espera creciente entre reinicios. Usa `min_uptime: 10s` y
`max_restarts: 10` para detectar arranques inestables; esta heurística depende del
tiempo de cada intento y no es un límite global de reinicios. Después de corregir
la causa, se puede ejecutar `pm2 restart ecosistema.config.cjs` y `pm2 save`. Las pruebas de
fallos deben usar procesos aislados, nunca inyectar errores en el bot de producción.

Esta protección corresponde al arranque y a los errores gestionados por `index.js`;
no transforma los logs de otras bibliotecas ni borra registros históricos.

## Servidor privado con Docker

`compose.yaml` separa el bot del procesamiento de audio, sin publicar puertos.
Las credenciales, cookies y el estado persistente se guardan fuera del repositorio
y de las imágenes. Consulta [la guía de despliegue](docker/LEEME.md) para construir,
validar, migrar el estado, ajustar los límites y recuperar la instalación anterior.

## Convención de nombres

Los módulos nuevos usan nombres en español: clases en PascalCase (`ServicioMusica`,
`ClienteAudio`, `SesionServidor`) y archivos y funciones en camelCase
(`servicioMusica.js`, `crearServidorAudio`, `iniciarMantenimiento`). Los scripts
usan palabras en español separadas por guiones, como `scripts/comprobar-audio.js`.
Las pruebas y las importaciones siguen los mismos nombres de sus módulos.

Los nombres de las bibliotecas externas, comandos de Discord, variables de entorno,
rutas HTTP y campos de datos persistidos mantienen sus contratos de compatibilidad.

## Identidad de pruebas

BOT_ENV=test exige PRODUCTION_ENV_PATH apuntando al .env del principal. Antes de
crear el cliente Discord o registrar comandos, se rechazan TOKEN o CLIENT_ID iguales a producción y
rutas de estado compartidas. Una aplicación distinta necesita también su propia
AUDIT_CONFIG_PATH y SECURITY_STATE_PATH; puede usar carpetas distintas. La copia
de pruebas de la VM se marca test y queda detenida hasta que se configure una
aplicación de Discord independiente. No pegues sus credenciales en el chat ni las
subas a Git. Esta protección es de configuración; el archivo .env es de confianza.
