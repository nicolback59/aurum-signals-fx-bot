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
} from '../types';

const IPC = {
  BOT_START: 'bot:start',
  BOT_STOP: 'bot:stop',
  BOT_STATE: 'bot:state',
  BOT_GET_STATE: 'bot:get-state',
  TRADE_EXECUTED: 'bot:trade-executed',
  SIGNAL_EVALUATED: 'bot:signal-evaluated',
  BACKTEST_RUN: 'backtest:run',
  TRADES_LIST: 'trades:list',
  REPORT_WEEKLY: 'report:weekly',
  REPORT_DAILY: 'report:daily',
  LOGS_LIST: 'logs:list',
} as const;

export interface AurumApi {
  startBot(): Promise<BotState>;
  stopBot(): Promise<BotState>;
  getState(): Promise<BotState>;
  listTrades(): Promise<BotTrade[]>;
  listLogs(): Promise<SystemLogEntry[]>;
  weeklyReport(): Promise<WeeklyStats>;
  dailyReport(): Promise<DailyStats>;
  runBacktest(period: BacktestPeriod): Promise<BacktestResult>;
  onState(cb: (state: BotState) => void): () => void;
  onTradeExecuted(cb: (trade: BotTrade) => void): () => void;
  onSignalEvaluated(cb: (sig: SignalSnapshot) => void): () => void;
}

const api: AurumApi = {
  startBot: () => ipcRenderer.invoke(IPC.BOT_START),
  stopBot: () => ipcRenderer.invoke(IPC.BOT_STOP),
  getState: () => ipcRenderer.invoke(IPC.BOT_GET_STATE),
  listTrades: () => ipcRenderer.invoke(IPC.TRADES_LIST),
  listLogs: () => ipcRenderer.invoke(IPC.LOGS_LIST),
  weeklyReport: () => ipcRenderer.invoke(IPC.REPORT_WEEKLY),
  dailyReport: () => ipcRenderer.invoke(IPC.REPORT_DAILY),
  runBacktest: (period) => ipcRenderer.invoke(IPC.BACKTEST_RUN, { period }),
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
};

contextBridge.exposeInMainWorld('aurum', api);
