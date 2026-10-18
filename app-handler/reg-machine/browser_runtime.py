"""Locate the bundled Camoufox cache without changing the user's app directories."""
from pathlib import Path
import sys


def configure(directory):
    import camoufox.pkgman as pkgman
    import camoufox.multiversion as multiversion
    import camoufox.utils as utils
    root = pkgman.INSTALL_DIR
    destination = Path(directory)
    for module in (pkgman, multiversion, utils):
        for name, value in list(vars(module).items()):
            if isinstance(value, Path) and value.is_relative_to(root):
                setattr(module, name, destination / value.relative_to(root))
    return pkgman


if __name__ == "__main__":
    pkgman = configure(sys.argv[1])
    pkgman.CamoufoxFetcher().install()
    print("Bundled Camoufox installed")
