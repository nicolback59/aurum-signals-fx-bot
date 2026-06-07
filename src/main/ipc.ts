/**
 * IPC bridge — wires renderer requests and bot events across the main/renderer
 * boundary. All channel names are namespaced and mirror the preload API.
 */

import { ipcMain, BrowserWindow, safeStorage } from 'electron';

import { runBacktest } from '../backtest/backtestEngine';
import { weeklyReport } from '../reporting/weeklyReport';
import { dailyReport } from '../reporting/dailyReport';
import type { BotController } from '../botController';
import type { BacktestPeriod } from '../types';

export const IPC = {
  BOT_START: 'bot:start',
  BOT_STOP: 'bot:stop',
  BOT_STATE: 'bot:state',
  BOT_GET_STATE: 'bot:get-state',
  BOT_VALIDATE_API: 'bot:validate-api',
  BOT_GET_STARTUP_LOGS: 'bot:get-startup-logs',
  BOT_STARTUP_LOG: 'bot:startup-log',
  TRADE_EXECUTED: 'bot:trade-executed',
  SIGNAL_EVALUATED: 'bot:signal-evaluated',
  BACKTEST_RUN: 'backtest:run',
  BACKTEST_RESULT: 'backtest:result',
  TRADES_LIST: 'trades:list',
  REPORT_WEEKLY: 'report:weekly',
  REPORT_DAILY: 'report:daily',
  LOGS_LIST: 'logs:list',
  AUTH_LOGIN: 'auth:login',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
} as const;

export function registerIpc(controller: BotController): void {
  ipcMain.handle(IPC.BOT_START, async () => {
    await controller.start();
    return controller.getState();
  });

  ipcMain.handle(IPC.BOT_STOP, async () => {
    await controller.stop();
    return controller.getState();
  });

  ipcMain.handle(IPC.BOT_GET_STATE, () => controller.getState());

  ipcMain.handle(IPC.TRADES_LIST, () => controller.getDb().listTrades());

  ipcMain.handle(IPC.LOGS_LIST, () => controller.getLogger().recent(300));

  ipcMain.handle(IPC.AUTH_LOGIN, (_e, { username, passwordHash }: { username: string; passwordHash: string }) => {
    const db = controller.getDb();
    const ok = db.verifyUser(username, passwordHash);
    return { success: ok };
  });

  ipcMain.handle(IPC.SETTINGS_GET, () => {
    const all = controller.getDb().getAllSettings();
    // Return a masked placeholder when an encrypted key exists, so the renderer
    // shows the field as configured without leaking the raw key.
    if (all.broker_api_key_enc) {
      all.broker_api_key = '••••••••••••••••';
    }
    return all;
  });

  ipcMain.handle(IPC.SETTINGS_SAVE, (_e, settings: Record<string, string>) => {
    const db = controller.getDb();
    for (const [key, value] of Object.entries(settings)) {
      if (key === 'broker_api_key' && value && safeStorage.isEncryptionAvailable()) {
        // Store API key encrypted; persist the base64-encoded ciphertext
        const encrypted = safeStorage.encryptString(value);
        db.setSetting('broker_api_key_enc', encrypted.toString('base64'));
        db.setSetting(key, '');
      } else {
        db.setSetting(key, value);
      }
    }
    controller.reloadSettings();
    return { success: true };
  });

  ipcMain.handle(IPC.BOT_VALIDATE_API, async () => {
    return controller.validateApiConnection();
  });

  ipcMain.handle(IPC.BOT_GET_STARTUP_LOGS, () => controller.getStartupLogs());

  ipcMain.handle(IPC.REPORT_WEEKLY, () => weeklyReport(controller.getDb()));

  ipcMain.handle(IPC.REPORT_DAILY, () => dailyReport(controller.getDb()));

  ipcMain.handle(IPC.BACKTEST_RUN, (_e, params: { period: BacktestPeriod }) => {
    // The live feed does not retain a year of intraday history; the backtest
    // runs on whatever the controller's feed currently holds. A dedicated data
    // loader can be wired here later. We pass empty series for unavailable data.
    return runBacktest(params.period, {
      mnq1m: [],
      mnq5m: [],
      es5m: [],
      nq1m: [],
    });
  });

  // Fan bot events out to all renderer windows.
  const broadcast = (channel: string, payload: unknown): void => {
    for (const win of BrowserWindow.getAllWindows()) {
      win.webContents.send(channel, payload);
    }
  };

  controller.on('state', (state) => broadcast(IPC.BOT_STATE, state));
  controller.on('trade-executed', (trade) => broadcast(IPC.TRADE_EXECUTED, trade));
  controller.on('signal-evaluated', (sig) => broadcast(IPC.SIGNAL_EVALUATED, sig));
  controller.on('startup-log', (entry) => broadcast(IPC.BOT_STARTUP_LOG, entry));
}
