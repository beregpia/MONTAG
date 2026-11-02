/* ============ Electron-оболочка: превращает приложение в программу Windows ============
 *
 * Загружает montag-standalone.html — там уже всё инлайном (бандл + CSS), поэтому
 * файл открывается по file:// без сервера и без Node в рантайме.
 *
 * Сборка (на машине с Windows, или где угодно с доступом в интернет):
 *   npm install
 *   npm run build:win
 * Результат: dist/MONTAG-win32-x64/ — папка с MONTAG.exe, её можно зазиповать
 * и перетащить на любой Windows. Двойной клик по .exe — программа запускается.
 */

const { app, BrowserWindow, shell } = require('electron');
const path = require('node:path');

const INDEX = path.join(__dirname, '..', 'montag-standalone.html');

function createWindow() {
  const win = new BrowserWindow({
    width: 1560,
    height: 960,
    minWidth: 1100,
    minHeight: 700,
    title: 'MONTAG — расстановка фоли',
    backgroundColor: '#0e1116',
    autoHideMenuBar: true,
    webPreferences: {
      // приложению не нужны права Node в окне — оно полностью клиентское
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  win.loadFile(INDEX);

  // внешние ссылки (если появятся) открывать в системном браузере, не в окне
  win.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url);
    return { action: 'deny' };
  });
}

app.whenReady().then(() => {
  createWindow();
  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow();
  });
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
