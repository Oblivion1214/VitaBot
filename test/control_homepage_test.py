"""Pruebas del panel con un backend ficticio; nunca controlan Docker real."""
import importlib.util
import json
from pathlib import Path
import re
import threading
from types import SimpleNamespace
import unittest
from urllib.error import HTTPError
from urllib.parse import urlencode
from urllib.request import Request, urlopen

spec=importlib.util.spec_from_file_location('control_homepage',Path(__file__).parents[1]/'docker/control_homepage.py')
control=importlib.util.module_from_spec(spec)
spec.loader.exec_module(control)


class Simulador:
    def __init__(self):self.acciones=[]
    def estado(self):return {'bot':{'estado':'En ejecución','salud':'—','reinicios':0},'audio':{'estado':'En ejecución','salud':'Saludable','reinicios':0}}
    def aplicar(self,accion):self.acciones.append(accion);return True,'Completado'


class PruebasHTTP(unittest.TestCase):
    def setUp(self):
        self.backend=Simulador()
        self.app=control.Aplicacion({'clave':'clave-solo-de-prueba','hosts':[]},self.backend)
        self.servidor=control.ServidorLimitado(('127.0.0.1',0),control.crear_manejador(self.app))
        self.host='127.0.0.1:'+str(self.servidor.server_port)
        self.app.hosts.add(self.host)
        self.url='http://'+self.host
        self.base='/control/clave-solo-de-prueba/'
        self.hilo=threading.Thread(target=self.servidor.serve_forever,daemon=True)
        self.hilo.start()

    def tearDown(self):
        self.servidor.shutdown();self.servidor.server_close();self.hilo.join()

    def pedir(self,ruta,datos=None,cabeceras=None):
        req=Request(self.url+ruta,data=None if datos is None else urlencode(datos).encode(),headers=cabeceras or {})
        try:
            with urlopen(req,timeout=5) as respuesta:return respuesta.status,respuesta.read().decode(),respuesta.headers
        except HTTPError as error:return error.code,error.read().decode(),error.headers

    def nonce(self,accion):
        codigo,html,_=self.pedir(self.base+accion)
        self.assertEqual(codigo,200)
        return re.search('name="nonce" value="([^"]+)"',html)[1]

    def test_enlaces_get_no_ejecutan_acciones(self):
        for accion in control.ACCIONES:self.assertEqual(self.pedir(self.base+accion)[0],200)
        self.assertEqual(self.backend.acciones,[])

    def test_clave_invalida_y_api_privada(self):
        self.assertEqual(self.pedir('/control/invalida/iniciar')[0],404)
        self.assertEqual(self.pedir('/api/estado')[0],403)
        codigo,cuerpo,_=self.pedir('/api/estado',cabeceras={'X-Vita-Key':self.app.clave})
        self.assertEqual(codigo,200)
        self.assertEqual(json.loads(cuerpo),{'bot':'En ejecución','audio':'Saludable'})

    def test_post_requiere_origen_y_nonce(self):
        nonce=self.nonce('detener')
        self.assertEqual(self.pedir(self.base+'detener',{'nonce':nonce})[0],403)
        self.assertEqual(self.pedir(self.base+'detener',{'nonce':'incorrecto'},{'Origin':self.url})[0],403)
        self.assertEqual(self.backend.acciones,[])

    def test_confirmacion_solo_se_puede_usar_una_vez(self):
        datos={'nonce':self.nonce('iniciar')}
        self.assertEqual(self.pedir(self.base+'iniciar',datos,{'Origin':self.url})[0],200)
        self.assertEqual(self.pedir(self.base+'iniciar',datos,{'Origin':self.url})[0],403)
        self.assertEqual(self.backend.acciones,['iniciar'])

    def test_eliminar_exige_frase_completa(self):
        self.assertEqual(self.pedir(self.base+'eliminar',{'nonce':self.nonce('eliminar'),'confirmacion':'si'},{'Origin':self.url})[0],400)
        self.assertEqual(self.backend.acciones,[])
        self.assertEqual(self.pedir(self.base+'eliminar',{'nonce':self.nonce('eliminar'),'confirmacion':'ELIMINAR VITA'},{'Origin':self.url})[0],200)
        self.assertEqual(self.backend.acciones,['eliminar'])

    def test_nonce_caducado_o_de_otra_accion(self):
        self.assertFalse(self.app.consumir_nonce(self.app.crear_nonce('detener'),'iniciar'))
        self.app.reloj=lambda:1000
        nonce=self.app.crear_nonce('detener')
        self.app.reloj=lambda:1301
        self.assertFalse(self.app.consumir_nonce(nonce,'detener'))

    def test_cabeceras_no_filtran_clave_y_sin_terceros(self):
        _,cuerpo,cabeceras=self.pedir(self.base+'estado')
        self.assertEqual(cabeceras['Referrer-Policy'],'same-origin')
        self.assertEqual(cabeceras['Cache-Control'],'no-store')
        self.assertIn("frame-ancestors 'none'",cabeceras['Content-Security-Policy'])
        self.assertNotIn('<script',cuerpo)


class PruebasDocker(unittest.TestCase):
    def setUp(self):self.comandos=[];self.ajeno=False
    def ejecutar(self,args,**kwargs):
        self.comandos.append(args)
        if 'inspect' in args:
            servicio='bot' if args[-1]=='vitabot-bot-1' else 'audio'
            return SimpleNamespace(returncode=0,stdout=json.dumps([{'Config':{'Labels':{'com.docker.compose.project':'ajeno' if self.ajeno else 'vitabot','com.docker.compose.service':servicio}},'State':{'Status':'running'},'RestartCount':0}]),stderr='')
        if 'config' in args:return SimpleNamespace(returncode=0,stdout='{"services":{"bot":{},"audio":{}}}',stderr='')
        return SimpleNamespace(returncode=0,stdout='',stderr='')

    def test_eliminar_no_borra_volumenes_ni_imagenes(self):
        backend=control.ControlVita('/proyecto',self.ejecutar)
        self.assertTrue(backend.aplicar('eliminar')[0])
        self.assertEqual(self.comandos[-1][-3:],['down','--timeout','10'])
        self.assertNotIn('--volumes',self.comandos[-1])
        self.assertNotIn('--rmi',self.comandos[-1])
        self.assertNotIn('--remove-orphans',self.comandos[-1])

    def test_bloquea_contenedores_ajenos_y_acciones_arbitrarias(self):
        backend=control.ControlVita('/proyecto',self.ejecutar)
        self.ajeno=True
        with self.assertRaises(RuntimeError):backend.aplicar('detener')
        self.assertFalse(any('stop' in c for c in self.comandos))
        with self.assertRaises(ValueError):backend.aplicar('exec')

    def test_iniciar_no_descarga_ni_construye_imagenes(self):
        backend=control.ControlVita('/proyecto',self.ejecutar)
        self.assertTrue(backend.aplicar('iniciar')[0])
        comando=self.comandos[-1]
        self.assertIn('--no-build',comando)
        self.assertEqual(comando[comando.index('--pull')+1],'never')
        self.assertEqual(comando[-2:],['audio','bot'])


if __name__=='__main__':unittest.main()
