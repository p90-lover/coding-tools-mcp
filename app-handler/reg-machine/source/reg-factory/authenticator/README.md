# Local Encrypted Authenticator

This is a local-only TOTP authenticator app. It stores the authenticator vault encrypted on disk and requires the configured username and password before any TOTP secrets can be decrypted.

## Run

```powershell
npm start
```

Open `http://127.0.0.1:8787`.

## Security Model

- The server binds to `127.0.0.1` by default.
- The vault is encrypted with `AES-256-GCM`.
- The encryption key is derived from `username + password` using `PBKDF2-SHA512` with a random salt.
- The username is stored only as a salted SHA-256 hash.
- TOTP secrets are never stored in plaintext and are not returned by the API after creation.
- Sessions are in-memory only, expire after inactivity, and use an HttpOnly `SameSite=Strict` cookie.
- Static responses include strict security headers and a CSP.
- The app has no third-party npm dependencies.

## Files

- `src/server.js` - local server, vault encryption, auth, TOTP generation.
- `public/` - browser UI.
- `data/vault.json` - encrypted vault created after first setup. This file is intentionally ignored by git.

Set `AUTH_DATA_DIR` to an existing encrypted vault directory if you want this copy to use it. The vault from `I:\AUTHENTICATOR\data` was not duplicated into this project.

## Notes

If you forget the username or password, the encrypted vault cannot be recovered. Keep a secure backup of your recovery codes outside this app.
