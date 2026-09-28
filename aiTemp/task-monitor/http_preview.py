"""Loopback-only static preview of the existing compiled SPA; no MCP/backend calls."""
from http.server import ThreadingHTTPServer, SimpleHTTPRequestHandler
from pathlib import Path
from urllib.parse import urlsplit

root=Path(__file__).resolve().parents[2]/'build'
assert (root/'index.html').is_file(), 'Compile the actual frontend before browser verification'
class Handler(SimpleHTTPRequestHandler):
    def __init__(self,*args,**kwargs): super().__init__(*args,directory=str(root),**kwargs)
    def do_GET(self):
        target=Path(self.translate_path(urlsplit(self.path).path))
        if not target.exists() and '.' not in target.name: self.path='/index.html'
        super().do_GET()
    def log_message(self,*args): pass
ThreadingHTTPServer(('127.0.0.1',1438),Handler).serve_forever()
