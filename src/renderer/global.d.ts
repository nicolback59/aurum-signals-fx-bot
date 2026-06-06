import type { AurumApi } from '../preload';

declare global {
  interface Window {
    aurum: AurumApi;
  }
}

export {};
