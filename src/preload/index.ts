import { contextBridge, ipcRenderer, type IpcRendererEvent } from "electron";
import type { IpcEventChannel, IpcEvents, Wl2goApi } from "../shared/ipcContract.ts";

const api: Wl2goApi = {
  pat: {
    getStatus: () => ipcRenderer.invoke("pat:getStatus"),
    getProcessState: () => ipcRenderer.invoke("pat:getProcessState"),
    connect: () => ipcRenderer.invoke("pat:connect"),
    connectRadio: (input) => ipcRenderer.invoke("pat:connectRadio", input),
    disconnect: () => ipcRenderer.invoke("pat:disconnect"),
    abort: () => ipcRenderer.invoke("pat:abort"),
    getConnection: () => ipcRenderer.invoke("pat:getConnection"),
    rmsList: (input) => ipcRenderer.invoke("pat:rmsList", input),
    answerPrompt: (input) => ipcRenderer.invoke("pat:answerPrompt", input),
  },
  winlink: {
    hybridStations: (input) => ipcRenderer.invoke("winlink:hybridStations", input),
    pickupStations: (input) => ipcRenderer.invoke("winlink:pickupStations", input),
    addPickupStation: (input) => ipcRenderer.invoke("winlink:addPickupStation", input),
    removePickupStation: (input) => ipcRenderer.invoke("winlink:removePickupStation", input),
    clearPickupStations: () => ipcRenderer.invoke("winlink:clearPickupStations"),
  },
  ardop: {
    getProcessState: () => ipcRenderer.invoke("ardop:getProcessState"),
    readiness: () => ipcRenderer.invoke("ardop:readiness"),
    resetModem: () => ipcRenderer.invoke("ardop:resetModem"),
    channelDecision: (input) => ipcRenderer.invoke("ardop:channelDecision", input),
  },
  rigctl: {
    getProcessState: () => ipcRenderer.invoke("rigctl:getProcessState"),
    listModels: () => ipcRenderer.invoke("rigctl:listModels"),
  },
  audio: {
    listDevices: () => ipcRenderer.invoke("audio:listDevices"),
    testDevices: (input) => ipcRenderer.invoke("audio:testDevices", input),
  },
  tuning: {
    open: (input) => ipcRenderer.invoke("tuning:open", input),
    close: () => ipcRenderer.invoke("tuning:close"),
    setDriveLevel: (input) => ipcRenderer.invoke("tuning:setDriveLevel", input),
    transmit: (input) => ipcRenderer.invoke("tuning:transmit", input),
  },
  serial: {
    listPorts: () => ipcRenderer.invoke("serial:listPorts"),
    detectRadio: () => ipcRenderer.invoke("serial:detectRadio"),
    testPtt: (input) => ipcRenderer.invoke("serial:testPtt", input),
  },
  diagnostics: {
    run: () => ipcRenderer.invoke("diagnostics:run"),
  },
  app: {
    getInfo: () => ipcRenderer.invoke("app:getInfo"),
    openLogs: () => ipcRenderer.invoke("app:openLogs"),
    openExternal: (input) => ipcRenderer.invoke("app:openExternal", input),
  },
  config: {
    get: () => ipcRenderer.invoke("config:get"),
    setStation: (input) => ipcRenderer.invoke("config:setStation", input),
    setDiagnostics: (input) => ipcRenderer.invoke("config:setDiagnostics", input),
    setWinlinkPassword: (input) => ipcRenderer.invoke("config:setWinlinkPassword", input),
  },
  profiles: {
    save: (input) => ipcRenderer.invoke("profiles:save", input),
    delete: (input) => ipcRenderer.invoke("profiles:delete", input),
    setActive: (input) => ipcRenderer.invoke("profiles:setActive", input),
    setLanPassword: (input) => ipcRenderer.invoke("profiles:setLanPassword", input),
  },
  mailbox: {
    listFolder: (input) => ipcRenderer.invoke("mailbox:listFolder", input),
    getMessage: (input) => ipcRenderer.invoke("mailbox:getMessage", input),
    getCounts: () => ipcRenderer.invoke("mailbox:getCounts"),
    markRead: (input) => ipcRenderer.invoke("mailbox:markRead", input),
    rebuild: () => ipcRenderer.invoke("mailbox:rebuild"),
    search: (input) => ipcRenderer.invoke("mailbox:search", input),
    recentContacts: () => ipcRenderer.invoke("mailbox:recentContacts"),
    archive: (input) => ipcRenderer.invoke("mailbox:archive", input),
    delete: (input) => ipcRenderer.invoke("mailbox:delete", input),
    saveAttachment: (input) => ipcRenderer.invoke("mailbox:saveAttachment", input),
    move: (input) => ipcRenderer.invoke("mailbox:move", input),
  },
  folders: {
    list: () => ipcRenderer.invoke("folders:list"),
    create: (input) => ipcRenderer.invoke("folders:create", input),
    rename: (input) => ipcRenderer.invoke("folders:rename", input),
    delete: (input) => ipcRenderer.invoke("folders:delete", input),
    listMessages: (input) => ipcRenderer.invoke("folders:listMessages", input),
  },
  menu: {
    popup: (input) => ipcRenderer.invoke("menu:popup", input),
  },
  drafts: {
    list: () => ipcRenderer.invoke("drafts:list"),
    get: (input) => ipcRenderer.invoke("drafts:get", input),
    save: (input) => ipcRenderer.invoke("drafts:save", input),
    delete: (input) => ipcRenderer.invoke("drafts:delete", input),
  },
  compose: {
    send: (input) => ipcRenderer.invoke("compose:send", input),
    editQueued: (input) => ipcRenderer.invoke("compose:editQueued", input),
    acknowledge: (input) => ipcRenderer.invoke("compose:acknowledge", input),
    pickAttachment: (input) => ipcRenderer.invoke("compose:pickAttachment", input),
    carryAttachments: (input) => ipcRenderer.invoke("compose:carryAttachments", input),
    openWindow: (input) => ipcRenderer.invoke("compose:openWindow", input),
    windowInit: () => ipcRenderer.invoke("compose:windowInit"),
    stash: (input) => ipcRenderer.invoke("compose:stash", input),
    closeWindow: () => ipcRenderer.invoke("compose:closeWindow"),
    focusWindow: (input) => ipcRenderer.invoke("compose:focusWindow", input),
  },
  on<K extends IpcEventChannel>(channel: K, listener: (payload: IpcEvents[K]) => void): () => void {
    const wrapped = (_event: IpcRendererEvent, payload: IpcEvents[K]) => listener(payload);
    ipcRenderer.on(channel, wrapped);
    return () => {
      ipcRenderer.removeListener(channel, wrapped);
    };
  },
};

contextBridge.exposeInMainWorld("wl2go", api);
