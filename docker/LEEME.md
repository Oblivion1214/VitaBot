# VitaBot en el servidor privado

El despliegue usa dos contenedores: `bot` mantiene Discord y las colas;
`audio` ejecuta yt-dlp, sus componentes EJS, Node y FFmpeg/Opus. Se comunican
por la red privada de Compose, sin publicar puertos del host. No necesitan PM2
ni el supervisor de audio de Windows dentro de Docker.

La carpeta prevista en el servidor es:

```text
~/servidor/vitabot/
  codigo/             # Repositorio y compose.yaml
  privado/            # Modo 700; archivos 600, propietario UID 1000
    bot.env
    audio.env
    youtube-cookie.txt
  estado/             # Persistente, propietario UID 1000
    audit-config.json
    security-state.json
    backups/
  respaldo/           # Copias privadas y resultados de la migración
```

Los archivos privados se montan como secretos de Compose. No forman parte de
las imágenes, el contexto de construcción ni Git. Compose los monta desde
archivos del host; protege y respalda también `privado/` en el host.
`audio.env` contiene únicamente `AUDIO_SHARED_TOKEN`, con el mismo valor que
el de `bot.env`. Las cookies solo son accesibles al contenedor de audio, que
trabaja sobre una copia temporal para permitir las escrituras de yt-dlp.

Los archivos de estado se copian después de detener el bot anterior. Nunca
inicies simultáneamente dos copias de producción ni restaures un estado vacío
sobre la configuración existente. La migración debe conservar las aceptaciones
de los servidores, roles, paneles y casos de cuarentena.

## Construcción y comprobación

Desde `~/servidor/vitabot/codigo`, con los archivos privados preparados:

```bash
docker compose config --quiet
docker compose build bot audio
docker build --target pruebas -t vitabot-pruebas:migracion .
docker run --rm --init --memory=512m --cpus=1 vitabot-pruebas:migracion node --test --test-concurrency=1
docker compose up -d audio
docker compose ps
```

Solo después de comprobar YouTube, Opus y voz, detener el bot anterior,
actualizar el estado persistente e iniciar el nuevo:

```bash
docker compose up -d bot
docker compose ps
docker compose logs --tail=30 bot
docker stats --no-stream
```

No compartas logs completos, `docker inspect` completo ni `docker compose config`
sin filtrar: pueden contener datos de servidores o configuración privada.
Para el diagnóstico de audio, el healthcheck ya autentica `/health` sin imprimir
su clave. No es necesario abrir el puerto 3001 al host o a Internet.

## Límites y operación

La configuración inicial para el AMD A4-9125 y 3.7 GiB de RAM permite una sesión
de voz, una extracción y una transmisión simultáneas. El bot tiene un límite de
0.5 CPU/256 MiB y el audio de 1 CPU/512 MiB, sin swap adicional. Aumentar estos
límites solo después de medir reproducciones junto a Jellyfin y Nextcloud.

`MUSIC_MAX_SESSIONS`, `AUDIO_MAX_STREAMS` y `AUDIO_MAX_RESOLVERS` se establecen
en Compose. Fuera de este despliegue conservan los valores predeterminados de
3, 3 y 2. Los logs de Docker tienen tres archivos de hasta 2 MiB por servicio.
Las copias diarias del estado conservan la retención existente de siete días.

Docker reinicia los procesos mediante `unless-stopped`, también tras reiniciar
el servidor. `init: true` y diez segundos de gracia permiten recoger procesos
hijos y cerrar voz, Discord y el mantenimiento. El manejo de errores fatales
del bot conserva sus mensajes seguros y su salida con código 1.

Watchtower queda desactivado para estos contenedores. Para actualizar, construir
las imágenes, ejecutar las pruebas y recrear los servicios deliberadamente.
yt-dlp y EJS tienen versiones fijadas en `Dockerfile`; revisar ambas al actualizar.
La etiqueta oficial de Node 24 se resuelve al construir; los resultados de cada
despliegue deben guardar la versión e identificadores de las imágenes obtenidas.

Para volver a la instalación anterior, detener primero `bot` en Docker, guardar
el estado actual y transferirlo de vuelta si cambió. Después reactivar el bot en
la VM con su URL del audio anterior. Mantener la instalación antigua detenida
como respaldo hasta confirmar música y `/decir` en Discord.

Referencias: [secretos de Compose](https://docs.docker.com/compose/how-tos/use-secrets/)
y [componentes EJS de yt-dlp](https://github.com/yt-dlp/yt-dlp/wiki/EJS).
