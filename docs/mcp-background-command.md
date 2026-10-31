# Create the saved MCP connector in the background

After configuring the automatic MCP harness and signing in to ChatGPT in Coding Tools, run:

```powershell
& '<install-folder>\Coding Tools.exe' --hidden --create-mcp-connector
```

The command uses the saved main MCP configuration and current signed-in browser account. It accepts no endpoint, credential, account or output-path arguments. Repeated requests share the current operation. It neither raises the main window nor interrupts active browser operations.

Read `mcp-connector-command.json` in the app's user-data folder for the generated operation ID and `running`, `completed` or `failed` status. A secondary process exiting only confirms dispatch; wait for a new receipt and its terminal state. Completion means the connector was created or already exists; MCP availability is checked separately by the app. Access denial remains a failure and does not change tunnel authentication or account access.
