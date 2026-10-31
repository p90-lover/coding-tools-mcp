# Create the saved MCP connector in the background

After configuring the automatic MCP harness and signing in to ChatGPT in Coding Tools, run:

```powershell
& '<install-folder>\Coding Tools.exe' --hidden --create-mcp-connector
```

The command uses the extra tunnel assigned to the current signed-in browser account, reconnecting it if needed. It uses the saved main MCP configuration when no tunnel is assigned to that account. It accepts no endpoint, credential, account or output-path arguments. Repeated requests for the same action share the current operation; different actions report busy. It neither raises the main window nor interrupts active browser operations.

Read `mcp-connector-command.json` in the app's user-data folder for the generated operation ID and `running`, `completed` or `failed` status. A secondary process exiting only confirms dispatch; wait for a new receipt and its terminal state. Completion means the plugin exists and its MCP app connection is confirmed in the loaded UI; a model tool call verifies actual usability separately. Access denial remains a failure and does not change tunnel authentication or account access.

## Connect another account's own tunnel

Open Platform settings in a separate hidden window using the current account's browser session:

```powershell
& '<install-folder>\Coding Tools.exe' --hidden --open-mcp-tunnel-settings
```

The window supports background browser control and closes after 15 minutes. Create a tunnel owned by this account, associate the intended ChatGPT workspace, and create a restricted runtime key with Tunnels Read and Use. The existing main tunnel remains separate.

Write a private `secrets/mcp-tunnel-add.json` under the app's resolved core data directory. Its fields are `accountId`, `label`, `tunnelId`, and `runtimeKey`; `accountId` must match the current browser account. Keep the key out of command arguments, logs, and chat. Then run:

```powershell
& '<install-folder>\Coding Tools.exe' --hidden --add-mcp-tunnel
```

This action uses the existing extra-tunnel add/reconnect path and waits for readiness. It consumes the private input only after success; a failed or replaced input remains available for retry. A successful receipt contains only `added: true`. Run `--create-mcp-connector` afterward to create the connector using this account's tunnel.

Extra runtime state, logs, and temporary files use `tunnel/extra-runtime` under the core data directory. Existing extras from a legacy state directory require migration before they can start in the dedicated directory; the app reports this instead of starting duplicate runtimes.
