#!/usr/bin/env python3
"""Instala los controles de Vita y añade un bloque acotado a Homepage."""
import datetime
import json
import os
from pathlib import Path
import re
import secrets
import shutil
import subprocess
import tempfile
import time
import urllib.request
import yaml  # Ya instalado en el host Linux Mint; no es dependencia del bot.


def escribir(ruta, datos):
    if ruta.is_symlink():
        raise RuntimeError('ruta_no_segura')
    descriptor, temporal = tempfile.mkstemp(prefix='.'+ruta.name+'-',dir=ruta.parent)
    try:
        with os.fdopen(descriptor,'wb') as salida:
            salida.write(datos if isinstance(datos,bytes) else datos.encode())
            salida.flush();os.fsync(salida.fileno())
        os.replace(temporal,ruta)
    finally:
        Path(temporal).unlink(missing_ok=True)


def bloque(anterior,inicio,fin,nuevo):
    if anterior.count(inicio)!=anterior.count(fin) or anterior.count(inicio)>1:
        raise RuntimeError('marcadores_no_validos')
    if inicio in anterior:
        antes,resto=anterior.split(inicio,1)
        _,despues=resto.split(fin,1)
        anterior=antes.rstrip('\n')+'\n'+despues.lstrip('\n')
    return anterior.rstrip('\n')+'\n\n'+inicio+'\n'+nuevo.rstrip('\n')+'\n'+fin+'\n'


def main():
    os.umask(0o077)
    raiz=Path.home()/'servidor/vitabot'
    carpeta=Path.home()/'servidor/homepage/config'
    fuente=Path(__file__).parent
    if os.getuid()!=1000 or raiz.resolve()!=raiz or carpeta.resolve()!=carpeta:
        raise RuntimeError('usuario_o_ruta_no_admitidos')
    for nombre in ('privado','herramientas','respaldo','codigo/docker','codigo/test'):
        if (raiz/nombre).is_symlink():raise RuntimeError('ruta_no_segura')
    if subprocess.run(['loginctl','show-user','saul','-p','Linger','--value'],capture_output=True,text=True,check=True).stdout.strip()!='yes':
        raise RuntimeError('falta_arranque_usuario')
    copia=raiz/'respaldo'/('homepage-'+datetime.datetime.now(datetime.timezone.utc).strftime('%Y%m%dT%H%M%SZ'))
    copia.mkdir(mode=0o700)
    originales={n:(carpeta/n).read_bytes() for n in ('services.yaml','settings.yaml','docker.yaml','custom.js')}
    for nombre,datos in originales.items():escribir(copia/nombre,datos)
    configuracion=raiz/'privado/control-homepage.json'
    if configuracion.exists():
        valor=json.loads(configuracion.read_text())
    else:
        valor={'clave':secrets.token_urlsafe(32),'direcciones':['192.168.1.250','100.98.90.80'],
               'hosts':['192.168.1.250:8788','100.98.90.80:8788']}
        escribir(configuracion,json.dumps(valor))
    clave=valor['clave']
    if not isinstance(clave,str) or not re.fullmatch(r'[A-Za-z0-9_-]{40,64}',clave):
        raise RuntimeError('clave_de_control_no_valida')
    base='http://192.168.1.250:8788/control/'+clave+'/'
    tarjetas=[]
    for accion,nombre,icono,descripcion in (
        ('estado','Estado de Vita','mdi-robot','Bot y audio en Docker'),
        ('iniciar','Iniciar Vita','mdi-play-circle','Iniciar o recrear bot y audio'),
        ('detener','Detener Vita','mdi-stop-circle','Detener bot y audio'),
        ('eliminar','Eliminar contenedores','mdi-delete','Con confirmación; conserva los datos')):
        servicio={'id':'vita-'+accion,'icon':icono,'href':base+accion,'description':descripcion,'target':'_blank'}
        if accion=='estado':
            servicio.update({'server':'vita-local','container':'vitabot-bot-1','showStats':True,
                'widget':{'type':'customapi','url':'http://192.168.1.250:8788/api/estado','refreshInterval':15000,
                          'headers':{'X-Vita-Key':clave},
                          'mappings':[{'field':'bot','label':'Vita','format':'text'},{'field':'audio','label':'Audio','format':'text'}]}})
        tarjetas.append({nombre:servicio})
    grupo='Control de Vita'
    fragmento=yaml.safe_dump([{grupo:tarjetas}],sort_keys=False,allow_unicode=True)
    servicios=bloque(originales['services.yaml'].decode(),'# INICIO CONTROL VITA','# FIN CONTROL VITA',fragmento)
    comprobacion=yaml.safe_load(servicios)
    if sum(grupo in elemento for elemento in comprobacion)!=1:raise RuntimeError('grupo_duplicado')
    ajustes=yaml.safe_load(originales['settings.yaml']) or {}
    ajustes.setdefault('layout',{})[grupo]={'style':'row','columns':4}
    docker=yaml.safe_load(originales['docker.yaml']) or {}
    if 'vita-local' in docker and docker['vita-local']!={'socket':'/var/run/docker.sock'}:
        raise RuntimeError('conexion_docker_ajena')
    docker['vita-local']={'socket':'/var/run/docker.sock'}
    javascript=bloque(originales['custom.js'].decode(),'// INICIO CONTROL VITA','// FIN CONTROL VITA',
                     (fuente/'homepage-vitabot.js').read_text())
    unidad='''[Unit]
Description=Controles locales de Vita para Homepage
After=network-online.target

[Service]
Type=simple
ExecStart=/usr/bin/python3 -B %h/servidor/vitabot/codigo/docker/control_homepage.py --raiz %h/servidor/vitabot
Restart=on-failure
RestartSec=5
NoNewPrivileges=yes
UMask=0077
Nice=15
IOSchedulingClass=idle
MemoryMax=192M
CPUQuota=25%
TasksMax=64
TimeoutStopSec=10
StandardOutput=journal
StandardError=journal
LogRateLimitIntervalSec=30
LogRateLimitBurst=5

[Install]
WantedBy=default.target
'''
    for nombre in ('control_homepage.py','instalar-homepage.py','homepage-vitabot.js','HOMEPAGE.md'):
        destino=raiz/'codigo/docker'/nombre
        if fuente.joinpath(nombre).resolve()!=destino.resolve():escribir(destino,(fuente/nombre).read_bytes())
    for nombre in ('control_homepage_test.py','respaldos_test.py'):
        escribir(raiz/'codigo/test'/nombre,(fuente.parent/'test'/nombre).read_bytes())
    # El controlador y su configuración también quedan cubiertos por la rotación diaria.
    escribir(raiz/'codigo/docker/respaldo.py',(fuente/'respaldo.py').read_bytes())
    escribir(raiz/'herramientas/respaldo.py',(fuente/'respaldo.py').read_bytes())
    escribir(raiz/'codigo/docker/RESPALDOS.md',(fuente/'RESPALDOS.md').read_bytes())
    escribir(raiz/'herramientas/RESPALDOS.md',(fuente/'RESPALDOS.md').read_bytes())
    escribir(raiz/'herramientas/homepage-vitabot.yaml',fragmento)
    escribir(raiz/'herramientas/vitabot-homepage.service',unidad)
    carpeta_unidades=Path.home()/'.config/systemd/user'
    carpeta_unidades.mkdir(mode=0o700,parents=True,exist_ok=True)
    unidad_ruta=carpeta_unidades/'vitabot-homepage.service'
    if unidad_ruta.exists():escribir(copia/'vitabot-homepage.service',unidad_ruta.read_bytes())
    escribir(unidad_ruta,unidad)
    activo=subprocess.run(['systemctl','--user','is-active','--quiet','vitabot-homepage.service'],capture_output=True).returncode==0
    subprocess.run(['systemctl','--user','daemon-reload'],check=True,capture_output=True)
    subprocess.run(['systemctl','--user','enable','--now','vitabot-homepage.service'],check=True,capture_output=True)
    if activo:subprocess.run(['systemctl','--user','restart','vitabot-homepage.service'],check=True,capture_output=True)
    for _ in range(30):
        try:
            peticion=urllib.request.Request('http://192.168.1.250:8788/api/estado',headers={'X-Vita-Key':clave})
            with urllib.request.urlopen(peticion,timeout=3) as respuesta:estado=json.load(respuesta)
            break
        except Exception:time.sleep(0.5)
    else:raise RuntimeError('control_no_disponible')
    try:
        escribir(carpeta/'docker.yaml',yaml.safe_dump(docker,sort_keys=False,allow_unicode=True))
        escribir(carpeta/'settings.yaml',yaml.safe_dump(ajustes,sort_keys=False,allow_unicode=True))
        escribir(carpeta/'custom.js',javascript)
        escribir(carpeta/'services.yaml',servicios)
    except Exception:
        for nombre,datos in originales.items():escribir(carpeta/nombre,datos)
        raise
    resultado={'correcto':True,'botones':4,'estado':estado,'servicio_usuario':True,
               'copia_homepage':copia.name,'contenedores_reiniciados':False}
    escribir(raiz/'respaldo/homepage-instalado.json',json.dumps(resultado))
    print(json.dumps(resultado))


if __name__=='__main__':
    try:main()
    except Exception as error:
        print(json.dumps({'correcto':False,'error':str(error) if type(error) is RuntimeError else 'instalacion_no_completada'}))
        raise SystemExit(1)
