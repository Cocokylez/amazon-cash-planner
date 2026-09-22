/* The smallest bridge that does the job.
 *
 * The status window needs to hear one thing from the main process: what is
 * happening. It gets a callback and nothing else - no filesystem, no network,
 * no node. A shell that hands a page more than it needs is a shell that has
 * to be trusted more than it needs to be.
 */
'use strict';

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('shellStatus', {
  on(handler) {
    ipcRenderer.on('status', (_event, payload) => {
      /* Copied out of the event, so the page never holds an ipcRenderer
         object it could use for anything else. */
      handler({ text: String(payload && payload.text || ''),
        kind: String(payload && payload.kind || 'working') });
    });
  },
});
