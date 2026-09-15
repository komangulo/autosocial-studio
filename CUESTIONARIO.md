# Cuestionario AndroidClone

Responde solo lo que sepas. Marca con una X las opciones. Si no sabes algo,
escríbelo así y lo decidimos juntos.

---

## A. Tu equipo y entorno

1. **Sistema operativo exacto** (Windows 10 / 11, versión):
2. **¿CPU/RAM/disco?** (ej. i7, 16 GB, SSD 512 GB):
3. **¿Tienes espacio libre?** Un proyecto Android limpio ocupa ~5–15 GB con el SDK.
4. **¿Tienes permisos de administrador** en ese PC para instalar JDK/SDK?
5. **¿Usas VPN o antivirus** (Kaspersky, Defender, Avast…)? Algunos bloquean Gradle.

## B. Herramientas que ya tienes

Marca lo que ya está instalado. Si no lo sabes, en la pestaña **AndroidClone**
del dashboard pulsa **"Comprobar dependencias"** y me dices qué sale.

- [ ] Node.js 18+ (casi seguro ya)
- [ ] yt-dlp (`autodownload\yt-dlp.exe`)
- [ ] ffmpeg + ffprobe
- [ ] **Java JDK 17** (`java -version`)
- [ ] **Android SDK** (`sdkmanager --version`)
- [ ] Android Studio (opcional, ya no es obligatorio)
- [ ] Git

## C. Alcance y objetivos

6. **¿Qué quieres clonar primero?** Elige uno para la demo:
   - [ ] Un juego sencillo 2D (puzzle, arcade, hyper-casual)
   - [ ] Un juego 3D
   - [ ] Una app de utilidad (notas, contador, escáner…)
   - [ ] Una app social/con backend
7. **¿Tu objetivo es aprender, tener tus propias apps, o publicarlas en Play Store?**
   (Cambia muchísimo: publicar tiene reglas y costes.)
8. **¿Publicar es a corto o largo plazo?** (Cuenta de desarrollador: 25 USD únicos.)
9. **¿Quieres el APK instalable** (`app-debug.apk`) o también el proyecto para abrirlo en Android Studio?
10. **¿Idioma de la interfaz de las apps generadas?** (español, inglés, ambos)

## D. Firma y cuentas

11. **¿Ya tienes un keystore** para firmar apps? (No es necesario para depurar.)
12. **¿Nombre de paquete** que quieres para tus apps? (ej. `com.tunombre.miapp`)
13. **¿Tienes cuenta de Google de desarrollador** o Firebase? (Solo si hará falta backend.)

## E. Cómo quieres que trabaje el agente

14. **Nivel de autonomía**:
    - [ ] Todo automático, y solo me avisas al final si hay un error grave.
    - [ ] Pausa y pídeme aprobación **en el plan** antes de generar código.
    - [ ] Pausa en cada fase.
15. **Si el build falla 3 veces seguidas**: ¿quieres que insista con otro modelo,
    que te pase el log, o que guarde el proyecto tal cual?
16. **¿Quieres que genere también textos de la ficha de Play Store** (título, descripción, keywords)?
17. **¿Quieres también logos/iconos de la app** (con IA de imagen) o de momento no?
18. **¿Dónde quieres que se guarden los proyectos?** Por defecto:
    `C:\AutoSocial\autosocial-studio\.runtime\androidclone\<nombre>\`

## F. Presupuesto de IA

19. **¿Usarás Gemini gratis o de pago?** Un análisis + plan + scaffold de un juego
    sencillo consume del orden de 10–40 llamadas a Gemini. El tier gratuito aguanta
    pruebas, pero un ciclo de auto-reparación largo puede agotar cuota diaria.
20. **¿Tienes claves de otros modelos** (OpenAI, Anthropic, DeepSeek) que quieras usar para el código?

## G. Preguntas estratégicas

21. **¿Prefieres empezar con un caso real que ya tengas en mente?** Si me pasas
    el link del anuncio, preparo la demo completa de las fases 1–4 en cuanto
    tengas el entorno listo.
22. **¿Quieres que el módulo también intente descargar el APK original** de
    fuentes públicas para inspeccionar el manifiesto? Esto está mucho más en la
    frontera legal; **no lo recomiendo** sin consultarlo.
23. **¿Cómo prefieres que te avise al terminar?** Correo, mensaje en el dashboard, o teléfono.

---

## Lo mínimo para arrancar HOY

Con esto puedo implementar y probar las fases 1–4 en tu PC:

1. Un **anuncio de ejemplo** (URL o vídeo) que quieras clonar.
2. Confirmar que tienes **JDK 17 + Android SDK** (o me dices que no y te doy los enlaces).
3. Tu **API key de Gemini** (ya la del módulo Competencia sirve).
