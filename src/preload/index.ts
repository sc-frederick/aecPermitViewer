import { contextBridge, ipcRenderer } from "electron";
import type { PermitBridge } from "../shared/bridge.js";

const bridge: PermitBridge = {
  snapshot: () => ipcRenderer.invoke("permit:snapshot"),
  addAndCheck: (input) => ipcRenderer.invoke("permit:add-and-check", input),
  checkNow: (permitId) => ipcRenderer.invoke("permit:check", permitId),
  cancel: (permitId) => ipcRenderer.invoke("permit:cancel", permitId),
  history: (permitId) => ipcRenderer.invoke("permit:history", permitId),
  saveKey: (key) => ipcRenderer.invoke("permit:save-key", key),
  removeKey: () => ipcRenderer.invoke("permit:remove-key"),
  openRecord: (permitId) => ipcRenderer.invoke("permit:open-record", permitId),
  openObservationRecord: (observationId) => ipcRenderer.invoke("permit:open-observation-record", observationId),
  removePermit: (permitId) => ipcRenderer.invoke("permit:remove", permitId),
  setMonitoring: (mode) => ipcRenderer.invoke("permit:set-monitoring", mode),
  setPermitMonitoring: (permitId, enabled) => ipcRenderer.invoke("permit:set-permit-monitoring", { permitId, enabled }),
  setPreference: (key, value) => ipcRenderer.invoke("permit:set-preference", { key, value }),
  checkForUpdate: () => ipcRenderer.invoke("permit:check-update"),
  downloadUpdate: () => ipcRenderer.invoke("permit:download-update"),
  installUpdate: () => ipcRenderer.invoke("permit:install-update"),
  deleteLocalData: (confirmation) => ipcRenderer.invoke("permit:delete-local-data", confirmation),
  onSnapshot: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, snapshot: Parameters<typeof callback>[0]) => callback(snapshot);
    ipcRenderer.on("permit:snapshot-changed", listener);
    return () => ipcRenderer.removeListener("permit:snapshot-changed", listener);
  },
  onLocalError: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, message: string) => callback(message);
    ipcRenderer.on("permit:local-error", listener);
    return () => ipcRenderer.removeListener("permit:local-error", listener);
  },
  onOpenDetails: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, permitId: string) => callback(permitId);
    ipcRenderer.on("permit:open-details", listener);
    return () => ipcRenderer.removeListener("permit:open-details", listener);
  },
  onAppEvent: (callback) => {
    const listener = (_event: Electron.IpcRendererEvent, event: Parameters<typeof callback>[0]) => callback(event);
    ipcRenderer.on("permit:app-event", listener);
    return () => ipcRenderer.removeListener("permit:app-event", listener);
  },
};

contextBridge.exposeInMainWorld("permitMonitor", bridge);
