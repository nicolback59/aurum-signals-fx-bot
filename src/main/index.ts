/**
 * Electron main entry point. Loads env, constructs the bot controller, wires
 * IPC and creates the main window.
 */

import { app, BrowserWindow } from 'electron';
import path from 'node:path';
import dotenv from 'dotenv';

import { BotController, loadConfig } from '../botController';
import { createMainWindow } from './windowManager';
import { registerIpc } from './ipc';

dotenv.config({ path: path.join(process.cwd(), '.env') });

let controller: BotController | null = null;

function bootstrap(): void {
  const config = loadConfig(process.env);
  controller = new BotController(config);
  registerIpc(controller);
  createMainWindow();
}

app.whenReady().then(bootstrap).catch((e) => {
  // eslint-disable-next-line no-console
  console.error('Failed to start Aurum bot', e);
  app.quit();
});

app.on('activate', () => {
  if (BrowserWindow.getAllWindows().length === 0) createMainWindow();
});

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') {
    void controller?.stop().finally(() => app.quit());
  }
});

app.on('before-quit', () => {
  void controller?.stop();
});
