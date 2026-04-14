git init
git add .
git commit -m "Initial commit — VitaBot"
git remote add origin https://github.com/oblivion1214/VitaBot.git
git push -u origin main


------------------------------------------------------------------------------------------------------
🔨 Vita Graf Eisen (VitaBot) — High-Fidelity Laboratory
Vita Graf Eisen es un sistema multifunción de nueva generación diseñado en Node.js, enfocado en la alta fidelidad de audio (Hi-Fi), la automatización de procesos y la interacción inteligente mediante IA. Originalmente concebido como un proyecto de aprendizaje de JavaScript, ha evolucionado hacia un entorno de laboratorio robusto para pruebas de arquitectura y gestión de servicios.


------------------------------------------------------------------------------------------------------
🎵 Audio de Alta Fidelidad (la mejor disponible para discord)
Motor de Audio Profesional: Utiliza una implementación personalizada de FFmpeg y yt-dlp para entregar audio en formato Opus con un bitrate constante de 320kbps (CBR).
Optimización de Calidad: Configurado para respetar el rango dinámico original de las pistas, evitando compresiones innecesarias.
Monitoreo Técnico: Comando /audiostats para supervisar la latencia (UDP), el bitrate real del canal y el estado del buffer en tiempo real.


------------------------------------------------------------------------------------------------------
🛡️ Auditoría y Seguridad "Shield"
Logs Sanitizados: Sistema de registro de eventos que oculta automáticamente las rutas locales de los archivos (Windows/Linux) para proteger la privacidad del host.
Canal Dedicado: Creación dinámica de canales de auditoría (vitabot-logs) con permisos restringidos para moderadores.
Categorización: Registro selectivo de eventos de Música, Moderación, Sistema y General.
Sanitización de Datos: El sistema oculta automáticamente las rutas locales de los archivos en los reportes de error para proteger la privacidad del servidor.
Persistencia JSON: Configuración de servidor (idioma y módulos) almacenada localmente con soporte para internacionalización (ES/EN).


------------------------------------------------------------------------------------------------------
🌐 Internacionalización e Interfaz
Sistema i18n: Soporte nativo para Español (MX) e Inglés (US).
Persistencia JSON: Los servidores guardan sus preferencias de idioma y auditoría de forma permanente en un archivo audit-config.json.
UX Moderna: Interfaz basada en componentes de Discord (Botones y Menús de selección) para una configuración intuitiva.


------------------------------------------------------------------------------------------------------
💻 Infraestructura del Host
Este proyecto está desplegado en un entorno de servidor real, lo que garantiza estabilidad y rendimiento superior:
Sistema Operativo: Windows 11/Linux Ubuntu 24.0.8
Memoria RAM: 32 GB DDR4.
Gestión de Procesos: Administrado mediante PM2 para despliegue continuo y reinicio automático.
Ubicación: Mexico


------------------------------------------------------------------------------------------------------
🛠️ Instalación y Configuración
Requisitos Previos
Node.js v18 o superior.
FFmpeg instalado en las variables de entorno del sistema.
Un servidor de Discord con permisos de Administrador.


------------------------------------------------------------------------------------------------------
Configuración del Entorno (.env)
Crea un archivo .env en la raíz del proyecto:
TOKEN=tu_token_de_discord
CLIENT_ID=tu_client_id
GENIUS_TOKEN=tu_token_de_genius
HF_TOKEN=tu_token_de_hugging_face


------------------------------------------------------------------------------------------------------
Comandos de Despliegue
Instalar dependencias: npm install
Registrar Slash Commands: node deploy-commands.js
Iniciar el bot (Modo Producción): pm2 start index.js --name vitabot.


------------------------------------------------------------------------------------------------------
Comando,Descripción
Comando,Categoría,Funcionalidad
/audiostats,📊 Sistema,"Monitor técnico de flujo, latencia y bitrate real."
/bola8,🎱 Diversión,Oráculo de respuestas aleatorias.
/chatconvita,🧠 IA,Interacción conversacional con Gemini 2.5 Flash.
/clear,🛡️ Mod,Limpieza masiva de mensajes en canales de texto.
/config,⚙️ Admin,Panel central de idioma y auditoría.
/decir,🎤 Voz,Conversión de texto a voz (TTS) de alta calidad.
/gacha,🎲 Diversión,Sistema de simulación gacha basado en probabilidad.
/imagine,🎨 IA,Generación de imágenes mediante modelos de difusión.
/letra,🎤 Música,Obtención de letras sincronizadas mediante Genius API.
/pause,🎵 Música,Pausa la reproducción actual.
/ping,📊 Sistema,Verificación de latencia de la API y el Host.
/play,🎵 Música,Reproducción Hi-Fi a 320kbps desde múltiples fuentes.
/ppt,🎮 Juegos,"Piedra, Papel o Tijera contra el sistema."
/queue,🎵 Música,Visualización de la cola de reproducción actual.
/roles,🛡️ Mod,Gestión simplificada de roles del servidor.
/skip,🎵 Música,Salto inmediato a la siguiente pista de la cola.
/stats,🖥️ Sistema,"Estado de carga del CPU, RAM y Uptime del servidor."
/stop,🎵 Música,Detención total y limpieza de la sesión de audio.


------------------------------------------------------------------------------------------------------
🛠️ Stack de Dependencias Clave
Framework: discord.js v14.
Audio: discord-player, ffmpeg-static, play-dl.
IA: @google/generative-ai, @huggingface/inference.
Utilidades: genius-lyrics, google-translate-api-x.


------------------------------------------------------------------------------------------------------
🛠️Stack de Dependencias Clave
Framework: discord.js v14.
Audio: discord-player, ffmpeg-static, play-dl.
IA: @google/generative-ai, @huggingface/inference.
Utilidades: genius-lyrics, google-translate-api-x.


------------------------------------------------------------------------------------------------------
🧪 Notas del Laboratorio
Este bot se mantiene como un entorno privado de experimentación. No se busca la comercialización masiva, representa un laboratorio vivo de integración de sistemas y desarrollo ágil en JavaScript. Cada módulo ha sido ajustado para ofrecer el máximo rendimiento en un entorno de escala pequeña y controlada.


------------------------------------------------------------------------------------------------------
📜Créditos
Desarrollador: Saul De La Cruz.
