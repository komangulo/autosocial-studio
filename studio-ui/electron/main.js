/**
 * AndroidClone desktop app (Electron main process).
 *
 * Starts the existing Express dashboard as an internal server on 127.0.0.1,
 * then opens a native window pointed at it. The user never sees a browser.
 */

const { app, BrowserWindow, shell, dialog, Menu } = require("electron");
const path = require("path");
const http = require("http");

const PORT = Number(process.env.AC_PORT || 3028);
const HOST = "127.0.0.1";
const URL = `http://${HOST}:${PORT}`;

let mainWindow = null;
let server = null;

function waitForServer(url, timeoutMs = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const attempt = () => {
      const req = http.get(url, (res) => {
        res.resume();
        resolve();
      });
      req.on("error", () => {
        if (Date.now() - start > timeoutMs) reject(new Error("El servidor interno no respondió a tiempo."));
        else setTimeout(attempt, 400);
      });
    };
    attempt();
  });
}

async function startBackend() {
  process.env.AC_PORT = String(PORT);
  process.env.DASHBOARD_PORT = String(PORT);
  process.env.ELECTRON_APP = "1";
  // The dashboard-server reads its port from config; override it there.
  const { config } = require("../src/config");
  config.dashboardPort = PORT;
  config.dashboardHost = HOST;
  server = require("../src/dashboard-server");
  await waitForServer(`${URL}/api/androidclone/health`).catch(async () => {
    await waitForServer(URL);
  });
}

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 920,
    minWidth: 1024,
    minHeight: 700,
    backgroundColor: "#0b0d12",
    title: "AndroidClone",
    autoHideMenuBar: true,
    show: false,
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  mainWindow.once("ready-to-show", () => mainWindow.show());
  mainWindow.loadURL(`${URL}/#androidclone`);

  // Open external links (downloads, docs) in the real browser instead.
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    if (url.startsWith("http")) shell.openExternal(url);
    return { action: "deny" };
  });

  mainWindow.on("closed", () => {
    mainWindow = null;
  });
}

function buildMenu() {
  const template = [
    {
      label: "Archivo",
      submenu: [
        { label: "Comprobar entorno", click: () => mainWindow?.loadURL(`${URL}/#androidclone`) },
        { type: "separator" },
        { role: "quit", label: "Salir" },
      ],
    },
    {
      label: "Ver",
      submenu: [
        { role: "reload", label: "Recargar" },
        { role: "toggleDevTools", label: "Herramientas de desarrollo" },
        { type: "separator" },
        { role: "resetZoom", label: "Zoom normal" },
        { role: "zoomIn", label: "Acercar" },
        { role: "zoomOut", label: "Alejar" },
      ],
    },
    {
      label: "Ayuda",
      submenu: [
        {
          label: "Abrir carpeta de proyectos",
          click: () => {
            const projects = path.resolve(__dirname, "..", ".runtime", "androidclone", "projects");
            shell.openPath(projects);
          },
        },
        {
          label: "Acerca de AndroidClone",
          click: () => dialog.showMessageBox(mainWindow, {
            type: "info",
            title: "AndroidClone",
            message: "AndroidClone",
            detail: "Convierte un anuncio en un proyecto Android compilable.",
          }),
        },
      ],
    },
  ];
  Menu.setApplicationMenu(Menu.buildFromTemplate(template));
}

app.whenReady().then(async () => {
  try {
    await startBackend();
  } catch (error) {
    dialog.showErrorBox("Error al iniciar AndroidClone", String(error.message || error));
    app.quit();
    return;
  }
  buildMenu();
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on("window-all-closed", () => {
  app.quit();
});
