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

Do not put a download or separate-app install gate in front of the Desktop
panels. Start unpacks this tree locally. Anneal still needs host Docker and,
on Windows, WSL2.
