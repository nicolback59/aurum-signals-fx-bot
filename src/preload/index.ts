/**
 * Preload — exposes a typed, minimal `window.aurum` bridge to the renderer.
 * No Node APIs leak into the renderer; everything goes through ipcRenderer.
 */

import { contextBridge, ipcRenderer } from 'electron';

import type {
  BotState,
  BotTrade,
  SignalSnapshot,
  WeeklyStats,
  DailyStats,
  BacktestResult,
  BacktestPeriod,
  SystemLogEntry,
  StartupLogEntry,
} from '../types';

const IPC = {
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
  TRADES_LIST: 'trades:list',
  REPORT_WEEKLY: 'report:weekly',
  REPORT_DAILY: 'report:daily',
  LOGS_LIST: 'logs:list',
  AUTH_LOGIN: 'auth:login',
  SETTINGS_GET: 'settings:get',
  SETTINGS_SAVE: 'settings:save',
} as const;

export interface AurumApi {
  startBot(): Promise<BotState>;
  stopBot(): Promise<BotState>;
  getState(): Promise<BotState>;
  validateApi(): Promise<{ success: boolean; message: string }>;
  getStartupLogs(): Promise<StartupLogEntry[]>;
  listTrades(): Promise<BotTrade[]>;
  listLogs(): Promise<SystemLogEntry[]>;
  weeklyReport(): Promise<WeeklyStats>;
  dailyReport(): Promise<DailyStats>;
  runBacktest(period: BacktestPeriod): Promise<BacktestResult>;
  login(username: string, passwordHash: string): Promise<{ success: boolean }>;
  getSettings(): Promise<Record<string, string>>;
  saveSettings(settings: Record<string, string>): Promise<{ success: boolean }>;
  onState(cb: (state: BotState) => void): () => void;
  onTradeExecuted(cb: (trade: BotTrade) => void): () => void;
  onSignalEvaluated(cb: (sig: SignalSnapshot) => void): () => void;
  onStartupLog(cb: (entry: StartupLogEntry) => void): () => void;
}

const api: AurumApi = {
  startBot: () => ipcRenderer.invoke(IPC.BOT_START),
  stopBot: () => ipcRenderer.invoke(IPC.BOT_STOP),
  getState: () => ipcRenderer.invoke(IPC.BOT_GET_STATE),
  validateApi: () => ipcRenderer.invoke(IPC.BOT_VALIDATE_API),
  getStartupLogs: () => ipcRenderer.invoke(IPC.BOT_GET_STARTUP_LOGS),
  listTrades: () => ipcRenderer.invoke(IPC.TRADES_LIST),
  listLogs: () => ipcRenderer.invoke(IPC.LOGS_LIST),
  weeklyReport: () => ipcRenderer.invoke(IPC.REPORT_WEEKLY),
  dailyReport: () => ipcRenderer.invoke(IPC.REPORT_DAILY),
  runBacktest: (period) => ipcRenderer.invoke(IPC.BACKTEST_RUN, { period }),
  login: (username, passwordHash) => ipcRenderer.invoke(IPC.AUTH_LOGIN, { username, passwordHash }),
  getSettings: () => ipcRenderer.invoke(IPC.SETTINGS_GET),
  saveSettings: (settings) => ipcRenderer.invoke(IPC.SETTINGS_SAVE, settings),
  onState: (cb) => {
    const handler = (_e: unknown, state: BotState): void => cb(state);
    ipcRenderer.on(IPC.BOT_STATE, handler);
    return () => ipcRenderer.removeListener(IPC.BOT_STATE, handler);
  },
  onTradeExecuted: (cb) => {
    const handler = (_e: unknown, trade: BotTrade): void => cb(trade);
    ipcRenderer.on(IPC.TRADE_EXECUTED, handler);
    return () => ipcRenderer.removeListener(IPC.TRADE_EXECUTED, handler);
  },
  onSignalEvaluated: (cb) => {
    const handler = (_e: unknown, sig: SignalSnapshot): void => cb(sig);
    ipcRenderer.on(IPC.SIGNAL_EVALUATED, handler);
    return () => ipcRenderer.removeListener(IPC.SIGNAL_EVALUATED, handler);
  },
  onStartupLog: (cb) => {
    const handler = (_e: unknown, entry: StartupLogEntry): void => cb(entry);
    ipcRenderer.on(IPC.BOT_STARTUP_LOG, handler);
    return () => ipcRenderer.removeListener(IPC.BOT_STARTUP_LOG, handler);
  },
};

contextBridge.exposeInMainWorld('aurum', api);
