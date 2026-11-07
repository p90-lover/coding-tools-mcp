# Use your existing Chrome profile

1. In Coding Tools, start Chrome sign-in and choose **Install connector** to open this folder.
2. In the Chrome profile you normally use, open `chrome://extensions`, enable Developer mode, choose **Load unpacked**, and select this folder. Chrome itself asks you to approve the extension's permissions; Coding Tools does not install it silently or change Chrome policy.
3. Choose **Open Chrome** in Coding Tools. On the first connection, compare the code in the extension's approval tab with the code shown in Coding Tools, then approve it. Do not approve an unexpected connection or a different code.
4. Sign in to ChatGPT in that same Chrome profile, if needed. The connector detects a valid session and Coding Tools independently verifies it. There is no close-Chrome or Continue step for this mode.

The connector has page/cookie permissions only for ChatGPT/OpenAI, plus scripting and its own settings. A loopback connection to the running app is CORS-restricted to this extension, short-lived, signed by an OS-protected app key, and protected by a one-use token. The four-group pairing code binds the public app identity, token, port and expiry; approval is tied to the exact displayed code, so an older confirmation cannot approve a replacement request. You approve the app's identity in Chrome the first time; a changed identity is not silently trusted. The cookie capture is encrypted for that app key using RSA-OAEP and AES-GCM before it crosses the loopback connection.

The extension acknowledges that a session was sent without keeping its worker alive during a long app check. That acknowledgement is not a verified login: Coding Tools and the normal connection tab show the final result automatically, only after the app's own checks finish.

Only non-partitioned ChatGPT/OpenAI cookies are sent to the explicitly requested local app connection. No Google cookies, passwords, unrelated website data, local storage, access-token JSON, or other Chrome profiles are exported. Cookie values and connection tokens are never logged. Pending pairing state is in session memory; only the approved public app key is saved in extension settings.

Existing Chrome windows and account routing are not modified or closed. The app uses its selected account's own proxy/session verification; an inconclusive or rejected session is not called successful. Chrome chooses its normal default/last-used profile when the app opens a tab; no private profile-discovery or debugging API is used. If that differs from the profile you want, copy the connection link from the new tab into the profile where you installed this connector.

After an app update changes the connector, choose **Reload** for Coding Tools in `chrome://extensions` before reconnecting. The app never forces an extension installation or reload.

Extension ID: `kcolhpapmkdnjjcepadadoajhikfokgn`.
