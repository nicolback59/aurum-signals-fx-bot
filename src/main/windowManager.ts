/**
 * Window manager — creates and tracks the main BrowserWindow.
 */

import { BrowserWindow, app } from 'electron';
import path from 'node:path';
import fs from 'node:fs';

declare const MAIN_WINDOW_WEBPACK_ENTRY: string;
declare const MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY: string;

let mainWindow: BrowserWindow | null = null;

function resolveIcon(): string | undefined {
  const candidates = [
    path.join(app.getAppPath(), 'assets', process.platform === 'win32' ? 'icon.ico' : process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
    path.join(__dirname, '..', 'assets', process.platform === 'win32' ? 'icon.ico' : process.platform === 'darwin' ? 'icon.icns' : 'icon.png'),
  ];
  return candidates.find((p) => fs.existsSync(p));
}

export function createMainWindow(): BrowserWindow {
  mainWindow = new BrowserWindow({
    width: 1440,
    height: 900,
    minWidth: 1120,
    minHeight: 720,
    backgroundColor: '#0D0D0D',
    title: 'Aurum Signals FX Bot',
    icon: resolveIcon(),
    autoHideMenuBar: true,
    webPreferences: {
      preload:
        typeof MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY !== 'undefined'
          ? MAIN_WINDOW_PRELOAD_WEBPACK_ENTRY
          : path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  const entry =
    typeof MAIN_WINDOW_WEBPACK_ENTRY !== 'undefined'
      ? MAIN_WINDOW_WEBPACK_ENTRY
      : path.join(__dirname, '../renderer/index.html');

  void mainWindow.loadURL(entry);

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  return mainWindow;
}

export function getMainWindow(): BrowserWindow | null {
  return mainWindow;
}
