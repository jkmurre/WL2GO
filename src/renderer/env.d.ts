/// <reference types="vite/client" />
import type { Wl2goApi } from "../shared/ipcContract.ts";

declare global {
  interface Window {
    wl2go: Wl2goApi;
  }
}

export {};
