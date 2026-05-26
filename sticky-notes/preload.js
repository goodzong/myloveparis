const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('noteAPI', {
  onData: (cb) => ipcRenderer.once('note:data', (_, note) => cb(note)),
  saveContent: (id, content) => ipcRenderer.send('note:update-content', { id, content }),
  saveColor: (id, color) => ipcRenderer.send('note:update-color', { id, color }),
  deleteNote: (id) => ipcRenderer.invoke('note:delete', { id }),
  createNote: () => ipcRenderer.send('note:create'),
});
