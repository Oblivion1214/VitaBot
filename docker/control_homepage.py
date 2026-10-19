#!/usr/bin/env python3
"""Controles locales limitados al proyecto Compose de Vita, sin dependencias."""
import argparse
import hmac
import html
import json
import os
from pathlib import Path
import secrets
import subprocess
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs

ACCIONES = {"estado", "iniciar", "detener", "eliminar"}
NOMBRES = {"bot": "vitabot-bot-1", "audio": "vitabot-audio-1"}
ETIQUETAS = {"running": "En ejecución", "exited": "Detenido", "created": "Creado",
             "restarting": "Reiniciando", "paused": "Pausado", "ausente": "Sin contenedor",
             "healthy": "Saludable", "unhealthy": "Revisar audio", "starting": "Preparando"}


class ControlVita:
    def __init__(self, raiz, ejecutar=subprocess.run):
        self.raiz = Path(raiz)
        self.ejecutar = ejecutar
        self.operacion = threading.Lock()
        self.lectura = threading.Lock()
        self.cache = None
        self.ultima_lectura = 0

    def comando(self, argumentos, limite=10):
        return self.ejecutar(argumentos, capture_output=True, text=True, timeout=limite,
                            env={**os.environ, "DOCKER_CLI_HINTS": "false"})

    def estado(self, fresco=False):
        with self.lectura:
            if not fresco and self.cache and time.monotonic()-self.ultima_lectura < 5:
                return self.cache
            resultado = {}
            for servicio, nombre in NOMBRES.items():
                r = self.comando(["/usr/bin/docker", "inspect", nombre])
                if r.returncode:
                    # Distinguir un contenedor eliminado de una caída del daemon.
                    fallo = (r.stderr or "").lower()
                    if "no such object" not in fallo and "no such container" not in fallo:
                        raise RuntimeError("docker_no_disponible")
                    resultado[servicio] = {"estado": "Sin contenedor", "salud": "—", "reinicios": 0}
                    continue
                c = json.loads(r.stdout)[0]
                labels = c["Config"].get("Labels") or {}
                if labels.get("com.docker.compose.project") != "vitabot" or labels.get("com.docker.compose.service") != servicio:
                    raise RuntimeError("contenedor_ajeno")
                e = c["State"]["Status"]
                salud = c["State"].get("Health", {}).get("Status", "")
                resultado[servicio] = {"estado": ETIQUETAS.get(e, "Desconocido"),
                                       "salud": ETIQUETAS.get(salud, "—"),
                                       "reinicios": int(c.get("RestartCount", 0))}
            self.cache, self.ultima_lectura = resultado, time.monotonic()
            return resultado

    def aplicar(self, accion):
        if accion not in {"iniciar", "detener", "eliminar"}:
            raise ValueError("accion_invalida")
        if not self.operacion.acquire(blocking=False):
            return False, "Hay otra operación en curso. Espera unos segundos."
        try:
            base = ["/usr/bin/docker", "compose", "--project-name", "vitabot", "--project-directory",
                    str(self.raiz / "codigo"), "-f", str(self.raiz / "codigo/compose.yaml")]
            configuracion = self.comando(base + ["config", "--format", "json"])
            if configuracion.returncode or set(json.loads(configuracion.stdout).get("services", {})) != {"bot", "audio"}:
                raise RuntimeError("compose_no_admitido")
            self.estado(fresco=True)  # Verificar las etiquetas antes de modificar contenedores.
            opciones = {"iniciar": ["up", "-d", "--no-build", "--pull", "never", "--wait", "--wait-timeout", "60", "audio", "bot"],
                        "detener": ["stop", "--timeout", "10", "bot", "audio"],
                        "eliminar": ["down", "--timeout", "10"]}
            r = self.comando(base + opciones[accion], limite=90)
            self.ultima_lectura = 0
            if r.returncode:
                return False, "No se pudo completar la operación. Consulta el estado antes de repetirla."
            return True, {"iniciar": "Vita está iniciada y el audio está listo.",
                          "detener": "Vita y el audio están detenidos.",
                          "eliminar": "Contenedores eliminados. Tus datos están conservados; usa Iniciar para recrearlos."}[accion]
        finally:
            self.operacion.release()


class Aplicacion:
    def __init__(self, configuracion, control, reloj=time.monotonic):
        self.clave = configuracion["clave"]
        self.hosts = set(configuracion["hosts"])
        self.control = control
        self.reloj = reloj
        self.nonces = {}
        self.cerrojo = threading.Lock()

    def autorizar(self, valor):
        return hmac.compare_digest(valor.encode(), self.clave.encode())

    def crear_nonce(self, accion):
        with self.cerrojo:
            ahora = self.reloj()
            self.nonces = {n: v for n, v in self.nonces.items() if v[1] > ahora}
            if len(self.nonces) >= 256:
                self.nonces.pop(next(iter(self.nonces)))
            nonce = secrets.token_urlsafe(24)
            self.nonces[nonce] = (accion, ahora+300)
            return nonce

    def consumir_nonce(self, nonce, accion):
        with self.cerrojo:
            valor = self.nonces.pop(nonce, None)
            return bool(valor and valor[0] == accion and valor[1] > self.reloj())

    def html(self, accion, mensaje="", correcto=True):
        e = html.escape
        base = "/control/" + self.clave + "/"
        nonce_estilo = secrets.token_urlsafe(16)
        try:
            estado = self.control.estado()
            tarjetas = "".join('<article><h2>'+n+'</h2><strong>'+e(estado[s]["estado"])+
                                '</strong><p>'+e(estado[s]["salud"] if s=="audio" else "Reinicios: "+str(estado[s]["reinicios"]))+'</p></article>'
                                for s,n in (("bot","Vita"),("audio","Audio")))
        except Exception:
            tarjetas = "<p>No se pudo consultar Docker en este momento.</p>"
        formulario = ""
        titulos = {"estado":"Estado de Vita", "iniciar":"Iniciar Vita", "detener":"Detener Vita", "eliminar":"Eliminar contenedores de Vita"}
        if accion != "estado":
            textos = {"iniciar":"Inicia el bot y el audio; también recrea los contenedores si fueron eliminados.",
                      "detener":"Vita se desconectará de Discord y terminará la reproducción de audio.",
                      "eliminar":"Quita los contenedores de Vita y audio. La configuración, las cookies, el estado, las imágenes y los respaldos se conservan."}
            entrada = '<label>Escribe ELIMINAR VITA para continuar<input name="confirmacion" autocomplete="off" required pattern="ELIMINAR VITA"></label>' if accion=="eliminar" else ""
            formulario = '<p>'+textos[accion]+'</p><form method="post" action="'+base+accion+'"><input type="hidden" name="nonce" value="'+self.crear_nonce(accion)+'">'+entrada+'<button type="submit">Confirmar: '+titulos[accion]+'</button></form>'
        enlaces = "".join('<a href="'+base+a+'">'+titulos[a]+'</a>' for a in ("estado","iniciar","detener","eliminar"))
        cuerpo = '<!doctype html><html lang="es"><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><title>'+titulos[accion]+'</title><style nonce="'+nonce_estilo+'">body{margin:0;background:#181223;color:#f4efff;font:16px system-ui}main{max-width:760px;margin:7vh auto;padding:24px}h1{font-size:30px}.tarjetas{display:flex;gap:16px}article{flex:1;background:#302340;border-radius:14px;padding:18px}h2{margin:0 0 14px;font-size:18px}strong{color:#c5f5dc}p{line-height:1.6}nav{display:flex;gap:16px;flex-wrap:wrap;margin-top:28px}a{color:#d3b5ff}button,input{padding:12px;border-radius:8px;font:inherit}button{background:#8052c5;color:white;border:0;cursor:pointer}label,input{display:block}input{margin:8px 0 18px}aside{padding:16px;background:#302340;border-radius:8px;margin:18px 0}</style><main><h1>'+titulos[accion]+'</h1>'+('<aside>'+e(mensaje)+'</aside>' if mensaje else '')+'<section class="tarjetas">'+tarjetas+'</section>'+formulario+'<nav>'+enlaces+'</nav></main></html>'
        return cuerpo.encode(), nonce_estilo


def crear_manejador(app):
    class Manejador(BaseHTTPRequestHandler):
        server_version = "VitaControl"
        sys_version = ""

        def log_message(self, *_args):
            pass  # Las URL contienen la clave de control; no se escriben en logs.

        def enviar(self, codigo, datos=b"", tipo="text/plain; charset=utf-8", nonce=""):
            self.send_response(codigo)
            self.send_header("Content-Type", tipo)
            self.send_header("Content-Length", str(len(datos)))
            self.send_header("Cache-Control", "no-store")
            self.send_header("Referrer-Policy", "same-origin")
            self.send_header("X-Content-Type-Options", "nosniff")
            self.send_header("Content-Security-Policy", "default-src 'none'; frame-ancestors 'none'; base-uri 'none'; form-action 'self'; style-src 'nonce-"+nonce+"'")
            self.end_headers()
            self.wfile.write(datos)

        def permitido(self):
            return self.headers.get("Host", "") in app.hosts

        def accion(self):
            partes = self.path.split("/")
            if len(partes) != 4 or partes[1] != "control" or partes[3] not in ACCIONES:
                return None
            return partes[3] if app.autorizar(partes[2]) else None

        def pagina(self, accion, mensaje="", codigo=200):
            datos, nonce = app.html(accion, mensaje)
            self.enviar(codigo, datos, "text/html; charset=utf-8", nonce)

        def do_GET(self):
            if not self.permitido() or len(self.path)>512:
                return self.enviar(404)
            if self.path == "/api/estado":
                if not app.autorizar(self.headers.get("X-Vita-Key", "")):
                    return self.enviar(403)
                try:
                    datos=app.control.estado()
                    valor={"bot":datos["bot"]["estado"], "audio":datos["audio"]["salud"] if datos["audio"]["salud"]!="—" else datos["audio"]["estado"]}
                    return self.enviar(200,json.dumps(valor).encode(),"application/json")
                except Exception:
                    return self.enviar(503,b'{"error":"estado_no_disponible"}',"application/json")
            accion=self.accion()
            if accion is None:
                return self.enviar(404)
            self.pagina(accion)

        def do_POST(self):
            accion=self.accion()
            if not self.permitido() or accion not in {"iniciar","detener","eliminar"}:
                return self.enviar(404)
            if self.headers.get("Origin") != "http://"+self.headers.get("Host", ""):
                return self.enviar(403)
            if self.headers.get("Content-Type", "").split(";")[0] != "application/x-www-form-urlencoded":
                return self.enviar(415)
            try:
                longitud=int(self.headers.get("Content-Length", "0"))
                if not 0<longitud<=2048:
                    return self.enviar(413)
                datos=parse_qs(self.rfile.read(longitud).decode(),strict_parsing=True,max_num_fields=3)
            except (ValueError,UnicodeError):
                return self.enviar(400)
            if not app.consumir_nonce(datos.get("nonce", [""])[0],accion):
                return self.pagina(accion,"La confirmación caducó o ya se usó. Vuelve a confirmar.",403)
            if accion=="eliminar" and datos.get("confirmacion")!=["ELIMINAR VITA"]:
                return self.pagina(accion,"Escribe la frase de confirmación completa.",400)
            try:
                correcto,mensaje=app.control.aplicar(accion)
            except Exception:
                correcto,mensaje=False,"No se pudo completar la operación. Consulta el estado."
            self.pagina("estado",mensaje,200 if correcto else 503)
    return Manejador


class ServidorLimitado(ThreadingHTTPServer):
    daemon_threads = True
    request_queue_size = 8

    def __init__(self,*args,**kwargs):
        self.cupos=threading.BoundedSemaphore(8)
        super().__init__(*args,**kwargs)

    def process_request(self,request,client_address):
        if not self.cupos.acquire(blocking=False):
            self.shutdown_request(request)
            return
        request.settimeout(10)
        try:
            super().process_request(request,client_address)
        except Exception:
            self.cupos.release()
            raise

    def process_request_thread(self,*args):
        try:
            super().process_request_thread(*args)
        finally:
            self.cupos.release()

    def handle_error(self,*_args):
        print("[Control Vita] Petición no completada.",flush=True)


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raiz",required=True,type=Path)
    args=parser.parse_args()
    configuracion=json.loads((args.raiz/"privado/control-homepage.json").read_text())
    app=Aplicacion(configuracion,ControlVita(args.raiz))
    servidores=[ServidorLimitado((ip,8788),crear_manejador(app)) for ip in configuracion["direcciones"]]
    for servidor in servidores:
        threading.Thread(target=servidor.serve_forever,daemon=True).start()
    print("[Control Vita] Servicio listo.",flush=True)
    threading.Event().wait()


if __name__=="__main__":
    try:
        main()
    except Exception:
        print("[Control Vita] No se pudo iniciar el servicio.",flush=True)
        raise SystemExit(1)
