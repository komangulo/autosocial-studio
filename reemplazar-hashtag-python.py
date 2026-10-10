#!/usr/bin/env python3
"""
Reemplaza #jthefrog por #fthefrog SOLO en la carpeta fija indicada.
Solo cambia el texto del hashtag; el resto del JSON queda identico.

USO:
    python reemplazar-hashtag-python.py          (aplica los cambios)
    python reemplazar-hashtag-python.py --dry    (solo muestra, no escribe)
"""
import sys, os, json

DE, A = "#jthefrog", "#fthefrog"

# Carpeta fija donde debe actuar el script:
CARPETA = r"C:\Users\msi\Downloads\autosocial-studio\.runtime\autoclone\jobs\jthefrog0-1791270066768\outputs"

dry = "--dry" in sys.argv[1:]

if not os.path.isdir(CARPETA):
    print("La carpeta no existe:", CARPETA)
    sys.exit(1)

ocurrencias = 0

def reemplaza(valor):
    global ocurrencias
    if isinstance(valor, str):
        n = valor.count(DE)
        if n:
            ocurrencias += n
            return valor.replace(DE, A)
        return valor
    if isinstance(valor, list):
        return [reemplaza(v) for v in valor]
    if isinstance(valor, dict):
        return {k: reemplaza(v) for k, v in valor.items()}
    return valor

revisados = cambiados = 0
lista = []
print("Carpeta:", CARPETA)
for raiz, _, ficheros in os.walk(CARPETA):
    for f in ficheros:
        if not f.lower().endswith(".meta.json"):
            continue
        full = os.path.join(raiz, f)
        revisados += 1
        try:
            with open(full, encoding="utf-8") as fh:
                txt = fh.read()
        except Exception as e:
            print("  No se pudo leer:", full, e); continue
        if DE not in txt:
            continue
        try:
            data = json.loads(txt)
        except Exception:
            print("  JSON invalido, se omite:", full); continue
        nuevo = reemplaza(data)
        cambiados += 1
        lista.append(full)
        if not dry:
            with open(full, "w", encoding="utf-8") as fh:
                json.dump(nuevo, fh, ensure_ascii=False, indent=2)

print("Archivos .meta.json revisados:", revisados)
print("Archivos que contenian", DE + ":", cambiados)
print("Sustituciones realizadas:", ocurrencias, f"({DE} -> {A})")
print("\nMODO PRUEBA (--dry): no se escribio nada." if dry
      else f"\nHecho. Solo se cambio %s por %s; el resto quedo intacto." % (DE, A))
if lista and len(lista) <= 25:
    print("\nArchivos modificados:")
    for f in lista:
        print("  -", f)
