const { contextBridge } = require('electron');

contextBridge.exposeInMainWorld('app', {
  platform: process.platform,
  version: '0.1.0'
});
