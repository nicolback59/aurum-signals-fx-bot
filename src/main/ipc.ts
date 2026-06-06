/**
 * IPC bridge — wires renderer requests and bot events across the main/renderer
 * boundary. All channel names are namespaced and mirror the preload API.
 */

import { ipcMain, BrowserWindow } from 'electron';

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
  TRADE_EXECUTED: 'bot:trade-executed',
  SIGNAL_EVALUATED: 'bot:signal-evaluated',
  BACKTEST_RUN: 'backtest:run',
  BACKTEST_RESULT: 'backtest:result',
  TRADES_LIST: 'trades:list',
  REPORT_WEEKLY: 'report:weekly',
  REPORT_DAILY: 'report:daily',
  LOGS_LIST: 'logs:list',
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
}
