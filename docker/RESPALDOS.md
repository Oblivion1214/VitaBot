# Respaldos automáticos en Linux Mint

La tarea del usuario `saul` se ejecuta diariamente a las **03:35, hora local del
servidor**, usando cron, Python 3 y herramientas ya incluidas en Linux Mint.
No añade contenedores, dependencias de Python ni procesos residentes. Ejecuta
con `nice 15`, prioridad de disco ociosa y un tiempo máximo de 180 segundos.
No detiene ni reinicia el bot.

Guarda archivos privados en `~/servidor/vitabot/respaldo/automaticos/`:

- Los tres archivos privados: `bot.env`, `audio.env` y `youtube-cookie.txt`.
- Los JSON activos de auditoría y seguridad, con sus datos completos.
- El código del despliegue, Dockerfile, Compose y manifiestos de dependencias.
- La herramienta y la programación del respaldo para poder reinstalarlas.
- Si se instalaron los controles de Homepage: su configuración privada,
  fragmento de tarjetas y unidad de systemd del usuario.

Excluye dependencias, imágenes Docker, cachés, música descargada, logs, `.git`
y respaldos anteriores. Las imágenes se reconstruyen usando el código y los
manifiestos conservados. Los respaldos diarios internos del bot siguen con su
retención original; no se incluyen recursivamente en estos archivos.

Conserva las **7 últimas copias correctas**, con un límite total de **256 MiB**,
un máximo de 32 MiB por archivo y 64 MiB de datos de entrada. El máximo normal
de archivos conservados es 224 MiB; la copia nueva puede ocupar otros 32 MiB
durante la rotación. Estos límites solo se aplican a `automaticos/`, no a las
copias históricas de la migración. Rechaza ejecuciones simultáneas y enlaces
simbólicos. Las carpetas tienen permisos 700 y los archivos nuevos 600.

Cada respaldo se publica y rota únicamente tras extraerlo en una carpeta
temporal privada y comprobar su manifiesto SHA-256, el tráiler gzip y los JSON.
Si faltan archivos, hay corrupción, cambia la configuración durante la captura
o falta espacio, conserva las copias anteriores. Se comprueba cada JSON completo
y estable, sin prometer transacciones entre archivos independientes del bot.

## Consultar y ejecutar

```bash
# Programación y zona horaria
crontab -l
timedatectl show -p Timezone --value

# Última copia correcta (sin credenciales)
cat ~/servidor/vitabot/respaldo/ultimo-respaldo.json

# Último fallo registrado, si existe; comparar su fecha con la última copia
cat ~/servidor/vitabot/respaldo/ultimo-error-respaldo.json

# Ejecutar una copia manual con la misma prioridad
nice -n 15 ionice -c 3 timeout 180 python3 \
  ~/servidor/vitabot/herramientas/respaldo.py --raiz ~/servidor/vitabot

# Verificar la extracción de la última copia sin modificar el bot
python3 ~/servidor/vitabot/herramientas/respaldo.py \
  --raiz ~/servidor/vitabot --verificar

# Espacio ocupado
du -sh ~/servidor/vitabot/respaldo/automaticos
```

Si la máquina está apagada a esa hora, cron no recupera esa ejecución: correr
la copia manual al encender si es necesario. Los fallos se registran con códigos
genéricos locales; no se imprimen valores privados ni se envían mensajes externos.

## Instalación y recuperación

Desde el código instalado, como usuario propietario y sin sudo:

```bash
python3 ~/servidor/vitabot/codigo/docker/instalar-respaldos.py \
  --raiz ~/servidor/vitabot
```

El instalador verifica que cron esté activo, crea y comprueba el primer respaldo,
y después añade un único bloque a la tabla del usuario conservando sus otras
tareas. Ejecutarlo otra vez actualiza ese bloque sin duplicarlo.

Para recuperar, verificar la copia y extraerla **primero en una carpeta privada
vacía**, nunca directamente sobre producción. Detener `bot` y `audio` con Docker
Compose antes de sustituir código, estado o secretos; guardar también una copia
del estado actual. Reconstruir las imágenes y arrancar una única instancia de
producción. Reinstalar cron con el comando anterior. No iniciar dos bots con el
mismo token ni restaurar datos antiguos mientras el bot está escribiendo.

Los archivos contienen credenciales sin cifrar y permanecen en este servidor,
protegidos por permisos de Linux. No subirlos a Git ni compartirlos. Una copia
local permite recuperar errores o cambios, pero no la pérdida física del disco;
para cubrirla hace falta una segunda copia en otro almacenamiento.
