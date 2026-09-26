# Vigilancia diaria de subvenciones (AutoSocial Studio)

Anade una pestana **"Subvenciones"** al dashboard con su propia ventana, que
cada dia a las **10:00** revisa las convocatorias y te avisa **por correo**.

## Que hace

Cada dia a las 10:00 (Europe/Madrid) consulta la web de subvenciones y busca
convocatorias que cumplan **todos** estos criterios:

- Region de impacto: **ES3 - COMUNIDAD DE MADRID**
- Beneficiario elegible: **PERSONAS FISICAS QUE NO DESARROLLAN ACTIVIDAD ECONOMICA**
- Solo **ABIERTAS** (plazo vigente)
- Registradas en las **ultimas 24 horas**
- Organo convocante, en dos grupos:
  - **Grupo A** - Comunidad de Madrid
  - **Grupo B** - Administracion del Estado

Lo que no cumpla, se descarta. El correo se envia a
`contacto.liberal.swinger@gmail.com` desde el inbox de AgentMail
`medicalchina@agentmail.to`, con la lista completa (tabla + adjunto JSON/CSV).

## Instalacion (2 minutos)

1. Descomprime el ZIP. Obtendras una carpeta `outputs/vigilancia/`.
2. Copia la carpeta `vigilancia/` a la **raiz de tu proyecto**
   (`C:\Users\msi\Downloads\autosocial-studio\`), de modo que quede
   `...\autosocial-studio\vigilancia\`.
3. Abre Git Bash en la raiz del proyecto y ejecuta:

```bash
cd /c/Users/msi/Downloads/autosocial-studio
node vigilancia/instalar-vigilancia.js
```

4. Reinicia el dashboard:

```bash
npm run dashboard
```

5. En el menu lateral aparece **"Vigilancia > Subvenciones"**. Entra, rellena
   los ajustes y pulsa **Guardar**. La API key de AgentMail ya viene
   rellenada; si quieres cambiarla, pegala en el campo correspondiente.

> Requisito: `node-cron` (ya esta instalado en tu proyecto). No hace falta
> instalar nada mas.

## Botones de la pestana

- **Comprobar ahora**: revisa ya y envia el correo.
- **Previsualizar correo**: abre en otra pestana como quedara el correo (sin enviarlo).
- **Guardar ajustes**: activa/desactiva la revision diaria, hora, minuto,
  ventana de horas, destinatario e inbox.

## Deshacer

```bash
node vigilancia/instalar-vigilancia.js --revert
```

Restaura `dashboard-server.js` e `index.html` y elimina la pestana. No toca
nada del codigo de TikTok.

## Como funciona por dentro (resumen)

- `src/vigilancia/core.js`: consulta la API publica del portal (sin navegador).
- `src/vigilancia/mailer.js`: compone y envia el correo (AgentMail).
- `src/vigilancia/worker.js`: programacion diaria (cron) + historial.
- `src/vigilancia/index.js`: rutas `/api/vigilancia/*`.
- `web/vigilancia.js` / `web/vigilancia.css`: la ventana del dashboard.
- Estado: `.runtime/vigilancia/config.json` e `.runtime/vigilancia/historial.jsonl`.

## Nota sobre el correo

El remitente es `medicalchina@agentmail.to`. Si quieres que salga desde otro
inbox o con otro nombre visible, se cambia en el campo "Inbox AgentMail" de la
pestana (o pidiendome crear otro inbox).
