/**
 * AndroidClone preload. The renderer talks to the backend over HTTP on
 * localhost, so no privileged bridge is exposed by default.
 */

const { contextBridge } = require("electron");

contextBridge.exposeInMainWorld("androidClone", {
  isDesktop: true,
  platform: process.platform,
});
