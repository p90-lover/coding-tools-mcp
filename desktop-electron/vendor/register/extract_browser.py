"""Extract the hash-pinned browser archive, preserving macOS executable links."""
import os
from pathlib import Path
import stat
import sys
import zipfile

archive, destination = Path(sys.argv[1]), Path(sys.argv[2]).resolve()
destination.mkdir(parents=True, exist_ok=False)
with zipfile.ZipFile(archive) as zipped:
    for item in zipped.infolist():
        target = (destination / item.filename).resolve()
        if not target.is_relative_to(destination):
            raise ValueError("Browser archive path escapes its destination")
        target.parent.mkdir(parents=True, exist_ok=True)
        mode = item.external_attr >> 16
        if item.is_dir():
            target.mkdir(exist_ok=True)
        elif stat.S_ISLNK(mode):
            link = zipped.read(item).decode()
            if not (target.parent / link).resolve().is_relative_to(destination):
                raise ValueError("Browser archive link escapes its destination")
            target.symlink_to(link)
        else:
            with zipped.open(item) as source, target.open("xb") as output:
                import shutil
                shutil.copyfileobj(source, output)
            if os.name != "nt" and mode:
                target.chmod(mode)
