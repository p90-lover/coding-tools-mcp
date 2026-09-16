#!/usr/bin/env python3

from apply_bridge_patch import patch_ipc_schema, patch_main, patch_preload


if __name__ == "__main__":
    patch_ipc_schema()
    patch_preload()
    patch_main()
    print("Applied Electron IPC bridge on the already-integrated headless source.")
