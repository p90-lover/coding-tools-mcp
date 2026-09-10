"""Fail if production source still permanently deletes files/directories.
Temporary/build fixtures are excluded; this checks shipping Rust sources only.
"""
from pathlib import Path
import re

root = Path('src-tauri/src')
patterns = [r'\b(?:std::)?fs::remove_file\s*\(', r'\b(?:std::)?fs::remove_dir_all\s*\(', r'\bstd::fs::remove_file\s*\(', r'\bstd::fs::remove_dir_all\s*\(']
findings=[]
for path in root.rglob('*.rs'):
    text=path.read_text(encoding='utf-8')
    for line_no,line in enumerate(text.splitlines(),1):
        if any(re.search(pattern,line) for pattern in patterns):
            findings.append(f'{path}:{line_no}:{line.strip()}')
if findings:
    raise SystemExit('AUDIT_PERMANENT_DELETE_API\n'+'\n'.join(findings))
print('PASS: shipping Rust source contains no remove_file/remove_dir_all calls')
