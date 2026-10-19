#!/usr/bin/env python3
"""Respaldo privado y acotado del despliegue. Solo usa la biblioteca estándar."""
import argparse
import contextlib
import datetime
import gzip
import hashlib
import io
import json
import os
from pathlib import Path, PurePosixPath
import re
import shutil
import signal
import stat
import tarfile
import tempfile
import time
import uuid

MIB = 1024 * 1024
MAX_ENTRADA = 64 * MIB
MAX_ARCHIVO = 32 * MIB
MAX_TOTAL = 256 * MIB
CONSERVAR = 7
PATRON = re.compile(r"^vita-\d{8}T\d{6}Z-[0-9a-f]{8}\.tar\.gz$")
REQUERIDOS = ("privado/bot.env", "privado/audio.env", "privado/youtube-cookie.txt",
              "estado/audit-config.json", "estado/security-state.json",
              "codigo/compose.yaml", "codigo/Dockerfile", "codigo/package.json",
              "codigo/package-lock.json", "codigo/index.js")
CARPETAS_CODIGO = ("audio", "commands", "utils", "config", "docker", "scripts", "test")
OMITIR = {"node_modules", ".git", ".cache", "__pycache__", "backups"}


class FalloRespaldo(Exception):
    pass


def carpeta_privada(ruta):
    if ruta.is_symlink():
        raise FalloRespaldo("ruta_no_segura")
    ruta.mkdir(mode=0o700, parents=False, exist_ok=True)
    os.chmod(ruta, 0o700)


def leer_seguro(raiz, relativo):
    ruta = raiz / relativo
    for componente in (ruta, *ruta.parents):
        if componente.is_symlink():
            raise FalloRespaldo("enlace_simbolico")
        if componente == raiz:
            break
    with os.fdopen(os.open(ruta, os.O_RDONLY | getattr(os, "O_NOFOLLOW", 0)), "rb") as archivo:
        if not stat.S_ISREG(os.fstat(archivo.fileno()).st_mode):
            raise FalloRespaldo("tipo_no_admitido")
        datos = archivo.read(MAX_ENTRADA + 1)
    if len(datos) > MAX_ENTRADA:
        raise FalloRespaldo("entrada_demasiado_grande")
    return datos


def validar_estado(datos):
    for nombre in ("estado/audit-config.json", "estado/security-state.json"):
        if not isinstance(json.loads(datos[nombre]), dict):
            raise FalloRespaldo("estado_invalido")


def capturar(raiz):
    for _ in range(3):
        datos = {nombre: leer_seguro(raiz, nombre) for nombre in REQUERIDOS}
        for carpeta in CARPETAS_CODIGO:
            base = raiz / "codigo" / carpeta
            if base.is_symlink():
                raise FalloRespaldo("enlace_simbolico")
            if not base.exists():
                continue
            for actual, directorios, archivos in os.walk(base, followlinks=False):
                directorios[:] = sorted(d for d in directorios if d not in OMITIR)
                if any((Path(actual) / d).is_symlink() for d in directorios):
                    raise FalloRespaldo("enlace_simbolico")
                for nombre in sorted(archivos):
                    if nombre.endswith((".tmp", ".lock", ".log", ".pyc")):
                        continue
                    relativo = (Path(actual) / nombre).relative_to(raiz).as_posix()
                    datos[relativo] = leer_seguro(raiz, relativo)
                    if sum(map(len, datos.values())) > MAX_ENTRADA:
                        raise FalloRespaldo("entrada_demasiado_grande")
        for nombre in ("deploy-commands.js", "ecosistema.config.cjs", "README.md", ".dockerignore"):
            if (raiz / "codigo" / nombre).exists():
                datos["codigo/" + nombre] = leer_seguro(raiz, "codigo/" + nombre)
        for nombre in ("respaldo.py", "cron-vitabot.txt", "RESPALDOS.md", "homepage-vitabot.yaml", "vitabot-homepage.service"):
            if (raiz / "herramientas" / nombre).exists():
                relativo = "herramientas/" + nombre
                datos[relativo] = leer_seguro(raiz, relativo)
        if (raiz / "privado/control-homepage.json").exists():
            datos["privado/control-homepage.json"] = leer_seguro(raiz, "privado/control-homepage.json")
        # Cada JSON se escribe por rename atómico. Reintentar si cambió durante la captura.
        vigilados = set(REQUERIDOS) | {n for n in datos if n.startswith("privado/")}
        if all(datos[n] == leer_seguro(raiz, n) for n in vigilados):
            validar_estado(datos)
            if sum(map(len, datos.values())) > MAX_ENTRADA:
                raise FalloRespaldo("entrada_demasiado_grande")
            return datos
    raise FalloRespaldo("configuracion_en_cambio")


def escribir_json(ruta, valor):
    if ruta.is_symlink():
        raise FalloRespaldo("ruta_no_segura")
    temporal = ruta.with_name(ruta.name + "." + uuid.uuid4().hex + ".tmp")
    try:
        with temporal.open("xb") as archivo:
            archivo.write(json.dumps(valor, ensure_ascii=False).encode())
            archivo.flush()
            os.fsync(archivo.fileno())
        os.replace(temporal, ruta)
    finally:
        temporal.unlink(missing_ok=True)


def crear_archivo(destino, datos):
    manifiesto = {n: {"sha256": hashlib.sha256(v).hexdigest(), "bytes": len(v)}
                  for n, v in datos.items()}
    contenido = {**datos, "manifiesto.json": json.dumps(manifiesto, sort_keys=True).encode()}
    with destino.open("xb") as salida:
        with gzip.GzipFile(fileobj=salida, mode="wb", compresslevel=1, mtime=0) as comprimido:
            with tarfile.open(fileobj=comprimido, mode="w|") as tar:
                for nombre, valor in sorted(contenido.items()):
                    entrada = tarfile.TarInfo(nombre)
                    entrada.size, entrada.mode = len(valor), 0o600
                    tar.addfile(entrada, io.BytesIO(valor))
        salida.flush()
        os.fsync(salida.fileno())
    if destino.stat().st_size > MAX_ARCHIVO:
        raise FalloRespaldo("archivo_demasiado_grande")


def verificar(archivo):
    # Restauración de prueba en directorio privado; nunca se modifica producción.
    with tempfile.TemporaryDirectory(prefix=".verificar-", dir=archivo.parent) as prueba:
        restaurados = {}
        total = 0
        with gzip.open(archivo, "rb") as descomprimido:
            with tarfile.open(fileobj=descomprimido, mode="r|") as tar:
                for entrada in tar:
                    ruta = PurePosixPath(entrada.name)
                    if (not entrada.isfile() or ruta.is_absolute() or ".." in ruta.parts
                            or "\\" in entrada.name or entrada.name in restaurados):
                        raise FalloRespaldo("archivo_invalido")
                    total += entrada.size
                    if total > MAX_ENTRADA + MIB:
                        raise FalloRespaldo("archivo_invalido")
                    contenido = tar.extractfile(entrada).read()
                    destino = Path(prueba) / entrada.name
                    destino.parent.mkdir(mode=0o700, parents=True, exist_ok=True)
                    destino.write_bytes(contenido)
                    restaurados[entrada.name] = {"sha256": hashlib.sha256(destino.read_bytes()).hexdigest(),
                                                "bytes": len(contenido)}
            # tar puede terminar antes de que gzip compruebe su CRC/tráiler.
            if len(descomprimido.read(MIB + 1)) > MIB:
                raise FalloRespaldo("archivo_invalido")
        manifiesto = json.loads((Path(prueba) / "manifiesto.json").read_bytes())
        restaurados.pop("manifiesto.json", None)
        if manifiesto != restaurados or any(n not in manifiesto for n in REQUERIDOS):
            raise FalloRespaldo("verificacion_fallida")
        validar_estado({n: (Path(prueba) / n).read_bytes()
                        for n in ("estado/audit-config.json", "estado/security-state.json")})
        return len(manifiesto)


def listar(carpeta):
    return sorted((p for p in carpeta.iterdir() if PATRON.fullmatch(p.name)
                   and p.is_file() and not p.is_symlink()),
                  key=lambda p: (p.stat().st_mtime_ns, p.name), reverse=True)


def rotar(carpeta):
    total = 0
    for indice, archivo in enumerate(listar(carpeta)):
        total += archivo.stat().st_size
        if indice >= CONSERVAR or total > MAX_TOTAL:
            archivo.unlink()


@contextlib.contextmanager
def bloquear(ruta):
    import fcntl  # Solo necesario para ejecutar el respaldo en Linux.
    descriptor = os.open(ruta, os.O_RDWR | os.O_CREAT | getattr(os, "O_NOFOLLOW", 0), 0o600)
    with os.fdopen(descriptor, "w") as archivo:
        try:
            fcntl.flock(archivo, fcntl.LOCK_EX | fcntl.LOCK_NB)
        except BlockingIOError:
            raise FalloRespaldo("respaldo_ya_en_curso") from None
        yield


def ejecutar(raiz):
    inicio = time.monotonic()
    carpeta_privada(raiz / "respaldo")
    carpeta = raiz / "respaldo" / "automaticos"
    carpeta_privada(carpeta)
    with bloquear(raiz / "respaldo" / ".respaldo.lock"):
        for pendiente in carpeta.glob(".verificar-*"):
            if pendiente.is_dir() and not pendiente.is_symlink():
                shutil.rmtree(pendiente)
        for pendiente in carpeta.glob(".vita-*.tmp"):
            if pendiente.is_file() and not pendiente.is_symlink():
                pendiente.unlink()
        ahora = datetime.datetime.now(datetime.timezone.utc)
        nombre = "vita-" + ahora.strftime("%Y%m%dT%H%M%SZ-") + uuid.uuid4().hex[:8] + ".tar.gz"
        temporal = carpeta / ("." + nombre + ".tmp")
        try:
            datos = capturar(raiz)
            if shutil.disk_usage(carpeta).free < 192 * MIB:
                raise FalloRespaldo("espacio_insuficiente")
            crear_archivo(temporal, datos)
            cantidad = verificar(temporal)
            os.replace(temporal, carpeta / nombre)
            rotar(carpeta)
            resultado = {"correcto": True, "fecha_utc": ahora.isoformat(), "archivo": nombre,
                         "bytes": (carpeta / nombre).stat().st_size, "archivos_verificados": cantidad,
                         "copias": len(listar(carpeta)), "duracion_segundos": round(time.monotonic()-inicio, 2)}
            escribir_json(raiz / "respaldo" / "ultimo-respaldo.json", resultado)
            return resultado
        finally:
            temporal.unlink(missing_ok=True)


def main():
    os.umask(0o077)
    def interrumpir(_numero, _marco):
        raise FalloRespaldo("ejecucion_interrumpida")
    signal.signal(signal.SIGTERM, interrumpir)
    argumentos = argparse.ArgumentParser(description=__doc__)
    argumentos.add_argument("--raiz", required=True, type=Path)
    argumentos.add_argument("--verificar", action="store_true")
    opciones = argumentos.parse_args()
    raiz = opciones.raiz.absolute()
    try:
        if raiz.is_symlink() or not raiz.is_dir() or raiz.resolve() != raiz:
            raise FalloRespaldo("ruta_no_segura")
        if opciones.verificar:
            with bloquear(raiz / "respaldo" / ".respaldo.lock"):
                archivos = listar(raiz / "respaldo" / "automaticos")
                resultado = {"correcto": True, "archivos_verificados": verificar(archivos[0])}
        else:
            resultado = ejecutar(raiz)
        print(json.dumps(resultado))
        return 0
    except Exception as error:
        codigo = str(error) if isinstance(error, FalloRespaldo) else "error_local"
        resultado = {"correcto": False, "error": codigo,
                     "fecha_utc": datetime.datetime.now(datetime.timezone.utc).isoformat()}
        # Una ejecución concurrente no debe pisar el estado de quien tiene el bloqueo.
        if codigo != "respaldo_ya_en_curso":
            try:
                escribir_json(raiz / "respaldo" / "ultimo-error-respaldo.json", resultado)
            except Exception:
                pass
        print(json.dumps(resultado))
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
