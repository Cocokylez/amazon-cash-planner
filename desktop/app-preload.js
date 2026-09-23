/* What the app window is allowed to know about the shell around it.
 *
 * Three things, and nothing else: which version it is, where updates come
 * from, and what the last check found. No filesystem, no node, no way to
 * start or stop anything. A page that only needs to display a version number
 * should not be handed the ability to do more than that.
 *
 * Absent entirely in a browser, which is the point: the app can then say
 * "running in a browser" rather than inventing a version it has no way to
 * know.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopShell', {
  /* { appVersion, updates: { configured, state, detail, checkedAt } } */
  info: () => ipcRenderer.invoke('shell:info'),

  /* Asks for a check now. Resolves with the same shape as info(). */
  check: () => ipcRenderer.invoke('shell:check-updates'),

  /* Applies an update that has already downloaded. Nothing happens
     unless it is asked for. */
  install: () => ipcRenderer.invoke('shell:install-update'),

  /* Fired as the check progresses, so the panel does not have to poll. */
  onUpdate(handler) {
    ipcRenderer.on('update-status', (_event, payload) => {
      /* Copied out, so the page never holds an object it could reach
         ipcRenderer through. */
      handler(JSON.parse(JSON.stringify(payload)));
    });
  },
});
