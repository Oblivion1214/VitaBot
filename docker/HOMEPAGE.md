# Vita en Homepage

La sección **Control de Vita** muestra el estado de bot y audio y ofrece cuatro
tarjetas: Estado, Iniciar, Detener y Eliminar contenedores. Usa la integración
Docker de Homepage para el indicador nativo, y una API local para los dos estados.

Las tarjetas abren páginas de confirmación. Abrir un enlace por GET nunca cambia
el estado del bot. Iniciar usa las imágenes existentes y espera la salud del audio;
recrea los contenedores si faltan. Detener cierra primero el bot y después el audio.
Eliminar exige escribir `ELIMINAR VITA` y ejecuta `docker compose down` sin borrar
volúmenes, imágenes, secretos, estado ni respaldos. No actúa sobre otros proyectos.

El controlador usa Python estándar del host y `docker compose` existente. Corre
como `saul` en una unidad systemd de usuario, con reinicio tras fallos, arranque
persistente mediante linger, prioridad baja, límite de CPU del 25% y 192 MiB de
memoria máxima. No se añade otro contenedor ni se monta Docker en otro servicio.
Cada consulta de estado se guarda en caché durante cinco segundos; Homepage
consulta los dos estados cada quince segundos.

Escucha en `192.168.1.250:8788` y `100.98.90.80:8788`. El script específico de
Homepage adapta los enlaces al acceso local o por Tailscale con que se abrió el
panel. Los enlaces contienen una clave privada de control: no compartirlos ni
publicar la configuración generada. El registro HTTP está desactivado y las
páginas no cargan recursos externos ni envían referencias a otros sitios.

Las operaciones POST requieren la clave, un Host/Origin permitido, formulario
acotado y una confirmación de un solo uso que caduca a los cinco minutos. No se
aceptan comandos, argumentos, nombres de contenedor o rutas suministrados por el
cliente. Antes de operar se verifica el proyecto Compose y sus etiquetas.

Los archivos de despliegue son:

```text
~/servidor/vitabot/codigo/docker/control_homepage.py
~/servidor/vitabot/privado/control-homepage.json
~/servidor/vitabot/herramientas/homepage-vitabot.yaml
~/servidor/vitabot/herramientas/vitabot-homepage.service
~/.config/systemd/user/vitabot-homepage.service
```

El token, la unidad y el fragmento de configuración quedan incluidos en los
respaldos automáticos de Vita. La configuración previa de Homepage se conserva,
solo en el servidor, en `~/servidor/vitabot/respaldo/homepage-FECHA/`.

## Consultar el controlador

```bash
systemctl --user status vitabot-homepage.service
journalctl --user -u vitabot-homepage.service -n 20 --no-pager
```

Reiniciar esta unidad solo reinicia el panel de controles; no reinicia el bot:

```bash
systemctl --user restart vitabot-homepage.service
```

El instalador `docker/instalar-homepage.py` se ejecuta como `saul`, conserva el
token existente y actualiza un único bloque de tarjetas y de JavaScript. Requiere
PyYAML ya instalado en Linux Mint y el arranque persistente del usuario habilitado.
El bot no importa PyYAML ni adquiere dependencias nuevas.

Referencias: [integración Docker](https://gethomepage.dev/configs/docker/),
[Custom API](https://gethomepage.dev/widgets/services/customapi/) y
[JavaScript propio](https://gethomepage.dev/configs/custom-css-js/).
