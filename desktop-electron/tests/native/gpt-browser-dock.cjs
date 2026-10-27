"use strict";

const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const http = require("node:http");
const { spawnSync } = require("node:child_process");
const { app, BrowserWindow, WebContentsView, session, ipcMain } = require("electron");

const source = path.resolve(__dirname, "../..");
const work = process.env.CHAT_VERIFY_WORK || path.join(source, "../aiTemp", "gpt-browser-dock");
fs.mkdirSync(work, { recursive: true });
app.setPath("userData", path.join(work, "profile"));
const deadline = setTimeout(() => { console.error("NATIVE_DOCK_TIMEOUT"); app.exit(3); }, 25000);
let browser, window, fixture;
let nativeViews = 0;
let attached = null;

async function until(check, label) {
  const end = Date.now() + 7000;
  while (Date.now() < end) {
    if (await check()) return;
    await new Promise(resolve => setTimeout(resolve, 30));
  }
  throw new Error(`Timed out: ${label}`);
}

app.whenReady().then(async () => {
  const entry = path.join(work, "entry.tsx");
  fs.writeFileSync(entry, `
import React, {useState} from "react";
import {createRoot} from "react-dom/client";
import {GptBrowserDock} from ${JSON.stringify(path.join(source,"src/features/GptBrowserDock.tsx"))};
const {ipcRenderer:ipc}=window.require("electron");
let subscriptions=0;
const api={
 gptBrowserStatus:()=>ipc.invoke("verify:status"),
 setGptBrowserSurfaceActive:active=>ipc.invoke("verify:active",active),
 setGptBrowserBounds:bounds=>ipc.invoke("verify:bounds",bounds),
 onGptBrowserChanged:fn=>{subscriptions++;const wrapped=(_e,s)=>fn(s);ipc.on("verify:changed",wrapped);return()=>{subscriptions--;ipc.removeListener("verify:changed",wrapped)}},
};
function App(){const [mode,setMode]=useState("standalone");const [standaloneHost,setStandalone]=useState(null);const [chatHost,setChat]=useState(null);
 return <><nav>{["standalone","chat","hidden"].map(m=><button id={m} key={m} onClick={()=>setMode(m)}>{m}</button>)}</nav>
 <div className="host" ref={setStandalone} hidden={mode!=="standalone"}/>
 <div className="host chat" ref={setChat} hidden={mode!=="chat"}/>
 <GptBrowserDock standaloneHost={standaloneHost} chatHost={chatHost} inChat={mode==="chat"} active={mode!=="hidden"} api={api} setError={e=>{if(e)throw Error(e)}}/>
 </>}
const root=createRoot(document.getElementById("root"));root.render(<App/>);window.verifyUnmount=()=>root.unmount();window.verifySubscriptions=()=>subscriptions;
`);
  const built = spawnSync(process.env.CODEX_WEB_GPT_BUN || "bun", ["build", entry, "--target=browser", "--format=iife", "--external=react", "--external=react/*", "--external=react-dom/*", `--outdir=${work}`], { encoding: "utf8", windowsHide: true });
  if (built.status !== 0) throw new Error(built.stderr || built.error?.message || "Renderer build failed");
  fixture = http.createServer((_req, res) => {
    res.setHeader("Content-Type", "text/html");
    res.end('<title>Native dock verification</title><h1>Native browser</h1><button id="count" onclick="this.textContent=\'Count 1\'">Count 0</button>');
  });
  await new Promise(resolve => fixture.listen(0, "127.0.0.1", resolve));
  const url = `http://127.0.0.1:${fixture.address().port}/`;
  window = new BrowserWindow({ width: 1000, height: 750, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false } });
  const { createGptBrowserHost } = require(path.join(source, "electron/gpt-browser.cjs"));
  browser = createGptBrowserHost({ dataRoot: path.join(work, "accounts"), sessionFor: p => session.fromPartition(p),
    createView: partition => {
      nativeViews++;
      const view = new WebContentsView({ webPreferences: { partition, sandbox: true, contextIsolation: true, nodeIntegration: false } });
      const load = view.webContents.loadURL.bind(view.webContents);
      view.webContents.loadURL = () => load(url);
      return view;
    },
    attachView: view => { attached = view; window.contentView.addChildView(view); },
    detachView: view => { if (attached === view) attached = null; window.contentView.removeChildView(view); },
    onChange: state => { if (!window.isDestroyed()) window.webContents.send("verify:changed", state); },
  });
  ipcMain.handle("verify:status", () => browser.status());
  ipcMain.handle("verify:active", (_event, value) => browser.setSurfaceActive(value));
  ipcMain.handle("verify:bounds", (_event, value) => { browser.setBounds(value); });
  await browser.addAccount();
  const html = path.join(work, "index.html");
  fs.writeFileSync(html, '<!doctype html><title>Dock renderer</title><link rel="stylesheet" href="entry.css"><style>body{margin:0}nav{height:40px}.host{width:600px;height:550px}.chat{margin-left:180px}[hidden]{display:none!important}</style><div id="root"></div><script>window.require=require("node:module").createRequire('+JSON.stringify(path.join(source,"package.json"))+')</script><script src="entry.js"></script>');
  await window.loadFile(html);
  await until(() => attached && attached.getBounds().width > 100, "standalone native view");
  const original = attached;
  await until(() => original.webContents.executeJavaScript('Boolean(document.getElementById("count"))'), "native page loaded");
  await original.webContents.executeJavaScript('document.getElementById("count").click()');
  const firstBounds = original.getBounds();
  await window.webContents.executeJavaScript('document.getElementById("chat").click()');
  await until(() => attached === original && original.getBounds().x > firstBounds.x + 100, "position-only host change");
  assert.equal(await original.webContents.executeJavaScript('document.getElementById("count").textContent'), "Count 1");
  assert.equal(nativeViews, 1);
  assert.equal(await window.webContents.executeJavaScript("window.verifySubscriptions()"), 1);
  console.log("NATIVE_DOCK_CHAT_HANDOFF_OK");
  await window.webContents.executeJavaScript('document.getElementById("hidden").click()');
  await until(() => attached === null, "hidden native view detached");
  assert.equal(original.webContents.isDestroyed(), false);
  await window.webContents.executeJavaScript('document.getElementById("standalone").click()');
  await until(() => attached === original && original.getBounds().x === firstBounds.x, "standalone bounds restored");
  assert.equal(await original.webContents.executeJavaScript('document.getElementById("count").textContent'), "Count 1");
  await window.webContents.executeJavaScript("window.verifyUnmount()");
  await until(() => attached === null, "unmounted native view detached");
  assert.equal(await window.webContents.executeJavaScript("window.verifySubscriptions()"), 0);
  console.log(`NATIVE_DOCK_RETENTION_AND_CLEANUP_OK electron=${process.versions.electron}`);
  browser.dispose();
  window.destroy();
  await new Promise(resolve => fixture.close(resolve));
  clearTimeout(deadline);
  app.exit(0);
}).catch(error => { console.error(error.stack); browser?.dispose(); window?.destroy(); fixture?.close(); clearTimeout(deadline); app.exit(1); });
