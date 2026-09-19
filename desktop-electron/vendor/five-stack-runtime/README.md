Bundled five-stack runtimes are materialized at package time by
`desktop-electron/scripts/prepare-five-stack-runtime.cjs` into
`desktop-electron/build/five-stack-runtime`, then copied into
`build/package-resources/five-stack-runtime` and shipped as Electron
extraResources.

Layout:

```
five-stack-runtime/
  MANIFEST.json
  cpa/<release-archive>
  <git-component>/source/...
  <git-component>/BUNDLE.json
```

Pinned git sources may be patched after checkout from
`desktop-electron/vendor/five-stack-runtime/overlays/<component-id>/`.
Overlays overwrite matching relative paths in the materialized `source/`
tree so Desktop-managed launches can ship a small identity-gate fix
without bumping the upstream commit pin.

Do not put a download or separate-app install gate in front of the Desktop
panels. Start unpacks this tree locally. Anneal still needs host Docker and,
on Windows, WSL2.
