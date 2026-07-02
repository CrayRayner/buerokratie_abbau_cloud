const { app, BrowserWindow } = require('electron');
const path = require('path');
const { fork } = require('child_process');

let mainWindow;
let serverProcess;

app.on('ready', () => {
  const serverPath = path.join(__dirname, '..', 'server', 'index.js');
  serverProcess = fork(serverPath, [], { stdio: 'inherit' });

  serverProcess.on('message', (msg) => {
    if (msg.type === 'ready') {
      createWindow(msg.port || 3456);
    }
  });
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
    icon: path.join(__dirname, '..', '..', 'build', 'icon.ico')
  });

  mainWindow.setMenuBarVisibility(false);
  mainWindow.loadURL(`http://localhost:${port}`);
  mainWindow.on('closed', () => { mainWindow = null; });
}

app.on('will-quit', () => {
  if (serverProcess) serverProcess.kill();
  process.exit(0);
});

app.on('window-all-closed', () => {
  app.quit();
});
