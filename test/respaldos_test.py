"""Pruebas aisladas: no leen credenciales ni estado del bot real."""
import contextlib
import importlib.util
import io
import json
import os
from pathlib import Path
import sys
import tarfile
import tempfile
import unittest
from unittest.mock import patch


def cargar(nombre, archivo):
    spec = importlib.util.spec_from_file_location(nombre, Path(__file__).parents[1] / "docker" / archivo)
    modulo = importlib.util.module_from_spec(spec)
    spec.loader.exec_module(modulo)
    return modulo


respaldo = cargar("respaldo", "respaldo.py")
instalador = cargar("instalador", "instalar-respaldos.py")


class PruebasRespaldo(unittest.TestCase):
    def setUp(self):
        base = Path(__file__).parents[1] / '.cache'
        base.mkdir(exist_ok=True)
        self.temporal = tempfile.TemporaryDirectory(prefix='prueba-respaldo-', dir=base)
        self.addCleanup(self.temporal.cleanup)
        self.raiz = Path(self.temporal.name).resolve()
        for nombre in respaldo.REQUERIDOS:
            ruta = self.raiz / nombre
            ruta.parent.mkdir(parents=True, exist_ok=True)
            ruta.write_bytes(b'{}' if nombre.endswith('.json') else b'valor-de-prueba')
        (self.raiz / 'codigo' / 'utils').mkdir()
        (self.raiz / 'codigo' / 'utils' / 'ejemplo.js').write_text('module.exports = {};')
        (self.raiz / 'codigo' / 'node_modules').mkdir()
        (self.raiz / 'codigo' / 'node_modules' / 'enorme').write_text('no incluir')
        # Windows no tiene fcntl. En Linux se comprueba el bloqueo real.
        if sys.platform == 'win32':
            self.parche = patch.object(respaldo, 'bloquear', lambda _: contextlib.nullcontext())
            self.parche.start()
            self.addCleanup(self.parche.stop)

    def test_respaldo_restaurable_sin_dependencias(self):
        resultado = respaldo.ejecutar(self.raiz)
        archivo = self.raiz / 'respaldo' / 'automaticos' / resultado['archivo']
        self.assertEqual(respaldo.verificar(archivo), resultado['archivos_verificados'])
        with tarfile.open(archivo) as tar:
            self.assertIn('privado/bot.env', tar.getnames())
            self.assertIn('codigo/utils/ejemplo.js', tar.getnames())
            self.assertFalse(any('node_modules' in n for n in tar.getnames()))
        if sys.platform != 'win32':
            self.assertEqual(archivo.stat().st_mode & 0o777, 0o600)

    def test_rotacion_conserva_solo_las_siete_ultimas(self):
        for _ in range(9):
            ultimo = respaldo.ejecutar(self.raiz)
        archivos = respaldo.listar(self.raiz / 'respaldo' / 'automaticos')
        self.assertEqual(len(archivos), 7)
        self.assertEqual(archivos[0].name, ultimo['archivo'])

    def test_estado_danado_no_borra_copia_anterior(self):
        resultado = respaldo.ejecutar(self.raiz)
        (self.raiz / 'estado' / 'security-state.json').write_text('invalido')
        with self.assertRaises(json.JSONDecodeError):
            respaldo.ejecutar(self.raiz)
        self.assertTrue((self.raiz / 'respaldo' / 'automaticos' / resultado['archivo']).exists())
        self.assertEqual(len(list((self.raiz / 'respaldo' / 'automaticos').glob('*.tmp'))), 0)

    def test_falta_secreto_cancela_sin_rotar(self):
        respaldo.ejecutar(self.raiz)
        (self.raiz / 'privado' / 'audio.env').unlink()
        with self.assertRaises(FileNotFoundError):
            respaldo.ejecutar(self.raiz)
        self.assertEqual(len(respaldo.listar(self.raiz / 'respaldo' / 'automaticos')), 1)

    def test_cubre_configuracion_opcional_de_homepage(self):
        (self.raiz / 'privado/control-homepage.json').write_text('{"clave":"solo-prueba"}')
        (self.raiz / 'herramientas').mkdir()
        (self.raiz / 'herramientas/vitabot-homepage.service').write_text('[Unit]')
        resultado=respaldo.ejecutar(self.raiz)
        with tarfile.open(self.raiz / 'respaldo/automaticos' / resultado['archivo']) as tar:
            self.assertIn('privado/control-homepage.json',tar.getnames())
            self.assertIn('herramientas/vitabot-homepage.service',tar.getnames())

    def test_limite_bytes_y_archivos_ajenos(self):
        respaldo.ejecutar(self.raiz)
        carpeta = self.raiz / 'respaldo' / 'automaticos'
        ajeno = carpeta / 'no-borrar.txt'
        ajeno.write_text('conservar')
        with patch.object(respaldo, 'MAX_TOTAL', 1):
            respaldo.rotar(carpeta)
        self.assertEqual(len(respaldo.listar(carpeta)), 0)
        self.assertTrue(ajeno.exists())

    def test_rechaza_escape_de_restauracion(self):
        archivo = self.raiz / 'inseguro.tar.gz'
        with tarfile.open(archivo, 'w:gz') as tar:
            entrada = tarfile.TarInfo('../escape')
            entrada.size = 3
            tar.addfile(entrada, io.BytesIO(b'abc'))
        with self.assertRaises(respaldo.FalloRespaldo):
            respaldo.verificar(archivo)
        self.assertFalse((self.raiz.parent / 'escape').exists())

    def test_verificacion_detecta_corrupcion(self):
        datos = respaldo.capturar(self.raiz)
        archivo = self.raiz / 'corrupto.tar.gz'
        respaldo.crear_archivo(archivo, datos)
        with archivo.open('r+b') as salida:
            salida.seek(-8, os.SEEK_END)
            salida.write(b'XXXXXXXX')
        with self.assertRaises(Exception):
            respaldo.verificar(archivo)

    @unittest.skipIf(sys.platform == 'win32', 'fcntl solo en Linux')
    def test_impide_ejecuciones_simultaneas(self):
        with respaldo.bloquear(self.raiz / 'bloqueo'):
            with self.assertRaises(respaldo.FalloRespaldo):
                with respaldo.bloquear(self.raiz / 'bloqueo'):
                    self.fail('no debe adquirir el segundo bloqueo')

    def test_cron_idempotente_conserva_otras_tareas(self):
        anterior = 'MAILTO=""\n0 1 * * * /usr/bin/true\n'
        nuevo = instalador.preparar_cron(anterior, self.raiz)
        self.assertIn(anterior.strip(), nuevo)
        self.assertEqual(nuevo, instalador.preparar_cron(nuevo, self.raiz))
        self.assertEqual(nuevo.count(instalador.INICIO), 1)
        self.assertIn('35 3 * * *', nuevo)


if __name__ == '__main__':
    os.umask(0o077)
    unittest.main()
