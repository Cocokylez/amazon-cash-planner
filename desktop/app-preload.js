/* What the app window is allowed to know about the shell around it.
 *
 * Which version it is, where updates come from, what the last check found -
 * and Ask Claude, which can connect a key, ask a question, and say whether a
 * key is connected. It can never read the key back: that stays in the shell.
 * No filesystem, no node, no way to start or stop anything.
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

  /* Ask Claude. Every result is copied out as plain data. */
  claude: {
    status: () => ipcRenderer.invoke('claude:status'),
    connect: key => ipcRenderer.invoke('claude:connect', String(key || '')),
    forget: () => ipcRenderer.invoke('claude:forget'),
    ask(req, onText) {
      const id = Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
      const listener = (_event, p) => {
        if (p && p.id === id && typeof onText === 'function') onText(String(p.text || ''));
      };
      ipcRenderer.on('claude:delta', listener);
      const r = req || {};
      return ipcRenderer.invoke('claude:ask', {
        id,
        brief: String(r.brief || ''),
        question: String(r.question || ''),
        history: Array.isArray(r.history)
          ? r.history.map(t => ({ role: t && t.role === 'assistant' ? 'assistant' : 'user',
            text: String((t && t.text) || '') }))
          : [],
      }).finally(() => ipcRenderer.removeListener('claude:delta', listener));
    },
  },
});
