const { app, BrowserWindow, ipcMain, Tray, Menu, nativeImage, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
const zlib = require('zlib');

let dataFile;
let tray;
const noteWindows = new Map();

// ── PNG icon generator (no external deps) ───────────────────────────────────

function crc32(buf) {
  if (!crc32._table) {
    crc32._table = new Uint32Array(256);
    for (let i = 0; i < 256; i++) {
      let c = i;
      for (let j = 0; j < 8; j++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      crc32._table[i] = c;
    }
  }
  let crc = 0xFFFFFFFF;
  for (const b of buf) crc = (crc >>> 8) ^ crc32._table[(crc ^ b) & 0xFF];
  return (crc ^ 0xFFFFFFFF) >>> 0;
}

function pngChunk(type, data) {
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(data.length);
  const typeBuf = Buffer.from(type, 'ascii');
  const crcBuf = Buffer.alloc(4);
  crcBuf.writeUInt32BE(crc32(Buffer.concat([typeBuf, data])));
  return Buffer.concat([lenBuf, typeBuf, data, crcBuf]);
}

function makeSolidPNG(size, r, g, b) {
  const sig = Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]);
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(size, 0);
  ihdr.writeUInt32BE(size, 4);
  ihdr[8] = 8; ihdr[9] = 2; // 8-bit RGB

  const stride = 1 + size * 3;
  const raw = Buffer.alloc(size * stride);
  for (let y = 0; y < size; y++) {
    for (let x = 0; x < size; x++) {
      const i = y * stride + 1 + x * 3;
      raw[i] = r; raw[i + 1] = g; raw[i + 2] = b;
    }
  }

  return Buffer.concat([
    sig,
    pngChunk('IHDR', ihdr),
    pngChunk('IDAT', zlib.deflateSync(raw)),
    pngChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Note persistence ────────────────────────────────────────────────────────

function loadNotes() {
  try {
    if (fs.existsSync(dataFile)) return JSON.parse(fs.readFileSync(dataFile, 'utf8'));
  } catch {}
  return [];
}

function saveNotes(notes) {
  fs.writeFileSync(dataFile, JSON.stringify(notes, null, 2));
}

function patchNote(id, changes) {
  const notes = loadNotes();
  const i = notes.findIndex(n => n.id === id);
  if (i !== -1) { Object.assign(notes[i], changes); saveNotes(notes); }
}

// ── Window management ───────────────────────────────────────────────────────

function openNoteWindow(note) {
  const win = new BrowserWindow({
    x: Math.round(note.x ?? 120),
    y: Math.round(note.y ?? 120),
    width: note.width ?? 260,
    height: note.height ?? 290,
    minWidth: 160,
    minHeight: 160,
    frame: false,
    transparent: true,
    resizable: true,
    skipTaskbar: true,
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
    },
  });

  win.loadFile(path.join(__dirname, 'note.html'));
  win.webContents.once('did-finish-load', () => win.webContents.send('note:data', note));

  let moveTimer, resizeTimer;
  win.on('moved', () => {
    clearTimeout(moveTimer);
    moveTimer = setTimeout(() => {
      if (!win.isDestroyed()) {
        const [x, y] = win.getPosition();
        patchNote(note.id, { x, y });
      }
    }, 300);
  });
  win.on('resized', () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (!win.isDestroyed()) {
        const [width, height] = win.getSize();
        patchNote(note.id, { width, height });
      }
    }, 300);
  });

  noteWindows.set(note.id, win);
  win.on('closed', () => noteWindows.delete(note.id));
}

function createNote() {
  const notes = loadNotes();
  const off = (notes.length % 8) * 25;
  const note = {
    id: `n${Date.now()}`,
    x: 120 + off,
    y: 120 + off,
    width: 260,
    height: 290,
    color: '#fff176',
    content: '',
  };
  notes.push(note);
  saveNotes(notes);
  openNoteWindow(note);
}

// ── App lifecycle ───────────────────────────────────────────────────────────

app.whenReady().then(() => {
  dataFile = path.join(app.getPath('userData'), 'sticky-notes.json');

  const notes = loadNotes();
  if (notes.length === 0) createNote();
  else notes.forEach(openNoteWindow);

  const iconBuf = makeSolidPNG(32, 255, 241, 118); // yellow #fff176
  tray = new Tray(nativeImage.createFromBuffer(iconBuf));
  tray.setToolTip('포스트잇 메모');

  const buildMenu = () => Menu.buildFromTemplate([
    { label: '+ 새 메모 추가', click: createNote },
    { type: 'separator' },
    {
      label: '모든 메모 보이기', click: () => {
        noteWindows.forEach(w => { if (!w.isDestroyed()) { w.show(); w.focus(); } });
      }
    },
    { type: 'separator' },
    { label: '종료', click: () => app.quit() },
  ]);

  tray.setContextMenu(buildMenu());
  tray.on('double-click', createNote);
});

app.on('window-all-closed', () => { /* tray 앱 — 창이 없어도 유지 */ });

// ── IPC handlers ────────────────────────────────────────────────────────────

ipcMain.on('note:update-content', (_, { id, content }) => patchNote(id, { content }));
ipcMain.on('note:update-color', (_, { id, color }) => patchNote(id, { color }));
ipcMain.on('note:create', () => createNote());

ipcMain.handle('note:delete', async (event, { id }) => {
  const note = loadNotes().find(n => n.id === id);
  if (note?.content?.trim()) {
    const win = BrowserWindow.fromWebContents(event.sender);
    const { response } = await dialog.showMessageBox(win, {
      type: 'question',
      buttons: ['삭제', '취소'],
      defaultId: 1,
      cancelId: 1,
      message: '이 메모를 삭제할까요?',
      detail: '삭제하면 되돌릴 수 없습니다.',
    });
    if (response !== 0) return false;
  }
  saveNotes(loadNotes().filter(n => n.id !== id));
  const w = noteWindows.get(id);
  if (w && !w.isDestroyed()) w.close();
  return true;
});
