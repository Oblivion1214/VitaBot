#!/usr/bin/env python3
"""Instala una tarea cron del usuario actual sin sudo ni reiniciar el bot."""
import argparse
import json
import os
from pathlib import Path
import shlex
import shutil
import subprocess
import sys

INICIO = "# INICIO RESPALDOS VITABOT"
FIN = "# FIN RESPALDOS VITABOT"


def preparar_cron(anterior, raiz):
    if anterior.count(INICIO) != anterior.count(FIN) or anterior.count(INICIO) > 1:
        raise RuntimeError("marcadores_cron_invalidos")
    if INICIO in anterior:
        antes, resto = anterior.split(INICIO, 1)
        _, despues = resto.split(FIN, 1)
        anterior = antes.rstrip("\n") + "\n" + despues.lstrip("\n")
    comando = " ".join(shlex.quote(p) for p in (
        "/usr/bin/nice", "-n", "15", "/usr/bin/ionice", "-c", "3",
        "/usr/bin/timeout", "180", "/usr/bin/python3",
        str(raiz / "herramientas" / "respaldo.py"), "--raiz", str(raiz)))
    # Cron trata % de forma especial incluso entre comillas.
    if "%" in comando or "\n" in comando:
        raise RuntimeError("ruta_no_admitida")
    return anterior.rstrip("\n") + "\n" + INICIO + "\n35 3 * * * " + comando + " >/dev/null 2>&1\n" + FIN + "\n"


def main():
    os.umask(0o077)
    os.environ["LC_ALL"] = "C"
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--raiz", required=True, type=Path)
    opciones = parser.parse_args()
    try:
        raiz = opciones.raiz.absolute()
        if raiz.resolve() != raiz or not (raiz / "codigo" / "compose.yaml").is_file():
            raise RuntimeError("despliegue_no_encontrado")
        if os.geteuid() == 0 or raiz.stat().st_uid != os.getuid():
            raise RuntimeError("usar_usuario_propietario_sin_sudo")
        for comando in ("crontab", "systemctl", "nice", "ionice", "timeout", "python3"):
            if shutil.which(comando) is None:
                raise RuntimeError("falta_herramienta_del_sistema")
        if subprocess.run(["systemctl", "is-active", "--quiet", "cron"], capture_output=True).returncode:
            raise RuntimeError("servicio_cron_inactivo")
        cron = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
        if cron.returncode not in (0, 1):
            raise RuntimeError("no_se_pudo_leer_cron")
        # Distinguir ausencia de crontab de otros errores de acceso.
        if cron.returncode == 1 and "no crontab for" not in cron.stderr.lower():
            raise RuntimeError("no_se_pudo_leer_cron")
        nuevo = preparar_cron(cron.stdout, raiz)
        herramientas = raiz / "herramientas"
        if herramientas.is_symlink():
            raise RuntimeError("ruta_no_segura")
        herramientas.mkdir(mode=0o700, exist_ok=True)
        destino = herramientas / "respaldo.py"
        if destino.is_symlink():
            raise RuntimeError("ruta_no_segura")
        temporal = herramientas / (".respaldo-" + str(os.getpid()) + ".tmp")
        with temporal.open("xb") as salida:
            salida.write(Path(__file__).with_name("respaldo.py").read_bytes())
        os.replace(temporal, destino)
        if any((herramientas / n).is_symlink() for n in ("cron-vitabot.txt", "RESPALDOS.md")):
            raise RuntimeError("ruta_no_segura")
        (herramientas / "cron-vitabot.txt").write_text(
            nuevo[nuevo.index(INICIO):], encoding="utf-8")
        for nombre in ("respaldo.py", "instalar-respaldos.py", "RESPALDOS.md"):
            fuente = Path(__file__).with_name(nombre)
            objetivo = raiz / "codigo" / "docker" / nombre
            if objetivo.is_symlink():
                raise RuntimeError("ruta_no_segura")
            if fuente.resolve() != objetivo.resolve():
                shutil.copyfile(fuente, objetivo)
            os.chmod(objetivo, 0o600)
        shutil.copyfile(Path(__file__).with_name("RESPALDOS.md"), herramientas / "RESPALDOS.md")
        # El primer respaldo se prueba antes de habilitar la tarea.
        prueba = subprocess.run(["/usr/bin/nice", "-n", "15", "/usr/bin/ionice", "-c", "3",
                                "/usr/bin/timeout", "180", "/usr/bin/python3", str(destino),
                                "--raiz", str(raiz)], capture_output=True, text=True)
        if prueba.returncode:
            raise RuntimeError("primer_respaldo_fallido_consultar_estado")
        resultado = json.loads(prueba.stdout)
        respaldo = raiz / "respaldo"
        if cron.stdout and not (respaldo / "crontab-anterior.txt").exists():
            (respaldo / "crontab-anterior.txt").write_text(cron.stdout)
        instalar = subprocess.run(["crontab", "-"], input=nuevo, capture_output=True, text=True)
        if instalar.returncode:
            raise RuntimeError("no_se_pudo_instalar_cron")
        verificar = subprocess.run(["crontab", "-l"], capture_output=True, text=True)
        if verificar.returncode or verificar.stdout != nuevo:
            raise RuntimeError("no_se_pudo_verificar_cron")
        resultado.update({"programado": True, "hora_local": "03:35", "retencion": 7,
                          "limite_mib": 256, "prioridad_baja": True})
        print(json.dumps(resultado))
        return 0
    except Exception as error:
        codigo = str(error) if type(error) is RuntimeError else "error_local_de_instalacion"
        print(json.dumps({"correcto": False, "error": codigo}))
        return 1


if __name__ == "__main__":
    sys.exit(main())
