const { app, BrowserWindow, dialog } = require('electron');
const path = require('path');
const { start } = require('../server');

let mainWindow;
let serverInfo;

app.whenReady().then(async () => {
  try {
    // Server INLINE im Main-Prozess starten (kein fork — das braucht in gepackten
    // Electron-Apps ELECTRON_RUN_AS_NODE und macht mit asar Aerger). Port 0 = freier
    // Zufallsport, verhindert Kollisionen mit anderen lokalen Diensten.
    serverInfo = await start({ port: 0 });
    createWindow(serverInfo.port);
  } catch (e) {
    dialog.showErrorBox('Startfehler', e.message || String(e));
    app.quit();
  }
});

function createWindow(port) {
  mainWindow = new BrowserWindow({
    width: 1400,
    height: 900,
    minWidth: 1000,
    minHeight: 700,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      sandbox: true,
      nodeIntegration: false
    },
    icon: path.join(__dirname, '..', 'build', 'icon.ico')
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL('http://localhost:' + port);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('will-quit', () => {
  if (serverInfo && serverInfo.server) serverInfo.server.close();
});

app.on('window-all-closed', () => app.quit());
