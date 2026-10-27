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
const deadline = setTimeout(() => { console.error("NATIVE_DOCK_TIMEOUT"); app.exit(3); }, 45000);
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
import {ChatMarkdown} from ${JSON.stringify(path.join(source,"src/features/ChatMarkdown.tsx"))};
import ${JSON.stringify(path.join(source,"src/features/codex-chat.css"))};
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
const root=createRoot(document.getElementById("root"));root.render(<App/>);window.verifyUnmount=()=>root.unmount();window.verifySubscriptions=()=>subscriptions;window.verifyFault=()=>ipc.emit("verify:changed",null,{accounts:null});window.verifyMarkdown=text=>{const markdownRoot=createRoot(document.getElementById("root"));markdownRoot.render(<ChatMarkdown text={text}/>)};
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
    webPreferences: { nodeIntegration: true, contextIsolation: false, backgroundThrottling: false } });
  window.webContents.on("console-message", (details, ...args) => {
    if ((details.level ?? args[0]) === "error" || (details.level ?? args[0]) === 3) console.error("RENDERER:", details.message ?? args[1]);
  });
  // Keep the real launcher CSP; only the HTTPS response is local to this test process.
  await session.defaultSession.protocol.handle("https", () => new Response(
    Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=", "base64"),
    { headers: { "Content-Type": "image/png" } },
  ));
  const { createGptBrowserHost } = require(path.join(source, "electron/gpt-browser.cjs"));
  browser = createGptBrowserHost({ dataRoot: fs.mkdtempSync(path.join(work, "accounts-")), sessionFor: p => session.fromPartition(p),
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
  const policy = /http-equiv="Content-Security-Policy" content="([^"]+)"/.exec(fs.readFileSync(path.join(source, "index.html"), "utf8"))[1];
  fs.writeFileSync(path.join(work, "bootstrap.cjs"), 'window.require=require("node:module").createRequire('+JSON.stringify(path.join(source,"package.json"))+');');
  fs.writeFileSync(html, '<!doctype html><meta charset="UTF-8"><meta http-equiv="Content-Security-Policy" content="'+policy+'"><title>Dock renderer</title><link rel="stylesheet" href="entry.css"><style>body{margin:0}nav{height:40px}.host{width:600px;height:550px}.chat{margin-left:180px}[hidden]{display:none!important}</style><div id="root"></div><script src="bootstrap.cjs"></script><script src="entry.js"></script>');
  await window.loadFile(html);
  window.showInactive();
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
  await window.webContents.executeJavaScript("window.verifyFault()");
  await until(() => window.webContents.executeJavaScript('Boolean(document.querySelector(".host:not([hidden]) .part-error"))'), "visible browser recovery control");
  await until(() => attached === null, "faulted native view detached");
  await window.webContents.executeJavaScript('document.getElementById("chat").click()');
  assert.equal(await window.webContents.executeJavaScript('Boolean(document.querySelector(".chat:not([hidden]) .part-error"))'), true);
  await window.webContents.executeJavaScript('document.getElementById("hidden").click()');
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".part-error").getClientRects().length'), 0);
  await window.webContents.executeJavaScript('document.getElementById("standalone").click();document.querySelector(".part-error button").click()');
  await until(() => attached === original, "browser retry recovered original session");
  console.log("NATIVE_DOCK_ERROR_RECOVERY_OK");
  await window.webContents.executeJavaScript("window.verifyUnmount()");
  await until(() => attached === null, "unmounted native view detached");
  assert.equal(await window.webContents.executeJavaScript("window.verifySubscriptions()"), 0);
  console.log(`NATIVE_DOCK_RETENTION_AND_CLEANUP_OK electron=${process.versions.electron}`);
  const markdown = process.env.CHAT_VERIFY_MARKDOWN_PATH ? fs.readFileSync(process.env.CHAT_VERIFY_MARKDOWN_PATH, "utf8")
    : "| Check | Value |\n| --- | --- |\n| Result | 391 |\n\n```text\nalpha\nbeta\n```\n\n[OpenAI](<https://openai.com>)";
  await window.webContents.executeJavaScript(`window.verifyMarkdown(${JSON.stringify(markdown + "\n\n![CSP test](https://image.test/pixel.png)")})`);
  await until(() => window.webContents.executeJavaScript('Boolean(document.querySelector(".cx-md table") && document.querySelector(".cx-md pre code"))'), "rich reply rendered");
  assert.equal(await window.webContents.executeJavaScript('document.querySelector(".cx-md pre code").textContent'), "alpha\nbeta");
  assert.ok(await window.webContents.executeJavaScript('document.querySelectorAll(".cx-md table").length >= 1 && document.querySelectorAll(\'.cx-md a[href^="https://openai.com"]\').length >= 1'));
  await until(() => window.webContents.executeJavaScript('Boolean(document.querySelector(".cx-md img")?.naturalWidth)'), "HTTPS image loaded under production CSP");
  window.showInactive();
  await window.webContents.executeJavaScript('new Promise(resolve=>requestAnimationFrame(()=>requestAnimationFrame(resolve)))');
  fs.writeFileSync(path.join(work, "rich-reply.png"), (await window.webContents.capturePage()).toPNG());
  console.log("CODING_TOOLS_RICH_REPLY_RENDER_OK");
  browser.dispose();
  window.destroy();
  await new Promise(resolve => fixture.close(resolve));
  clearTimeout(deadline);
  app.exit(0);
}).catch(async error => { console.error(error.stack); if (window && !window.isDestroyed()) console.error(await window.webContents.executeJavaScript('JSON.stringify({ready:document.readyState,body:document.body.innerText.slice(0,800),root:document.getElementById("root")?.innerHTML.slice(0,1600)})').catch(()=>"Renderer unavailable")); browser?.dispose(); window?.destroy(); fixture?.close(); clearTimeout(deadline); app.exit(1); });
