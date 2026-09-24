/* The smallest bridge that does the job.
 *
 * The status window needs to hear what is happening, and - when what is
 * happening is "the helper is not set up" - to ask for that to be fixed. It
 * gets a callback and two named requests. No filesystem, no network, no node,
 * and no way to name a command: `runSetup` runs install.py and nothing else.
 * A shell that hands a page more than it needs is a shell that has to be
 * trusted more than it needs to be.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellStatus', {
  on(handler) {
    ipcRenderer.on('status', (_event, payload) => {
      /* Copied out of the event, so the page never holds an ipcRenderer
         object it could use for anything else. */
      handler({
        text: String((payload && payload.text) || ''),
        kind: String((payload && payload.kind) || 'working'),
        action: payload && payload.action
          ? { label: String(payload.action.label || ''),
            kind: String(payload.action.kind || '') }
          : null,
      });
    });
  },

  /* Asked once on load, so a window that finished loading after the shell
     spoke still shows what it said rather than "Starting..." forever. */
  current: () => ipcRenderer.invoke('shell:status'),

  /* Nothing here runs without being clicked. */
  runSetup: () => ipcRenderer.invoke('shell:run-setup'),
  openPython: () => ipcRenderer.invoke('shell:open-python'),
  openReleases: () => ipcRenderer.invoke('shell:open-releases'),
});
