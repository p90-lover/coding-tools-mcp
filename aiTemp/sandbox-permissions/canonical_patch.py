"""Bounded fix for reproduced Rust extended-path rejection; preserve original files."""
from pathlib import Path
import os,shutil,subprocess
ROOT=Path('aiTemp/Trash/sandbox-canonical-before')/os.environ['GITHUB_RUN_ID']
changed=[]
def save(name,text):
    path=Path(name);assert not path.is_symlink()
    if path.read_text(encoding='utf-8')==text:return
    backup=ROOT/name;backup.parent.mkdir(parents=True,exist_ok=True);assert not backup.exists()
    shutil.copy2(path,backup);path.write_text(text,encoding='utf-8');changed.append(name)
def once(text,old,new):
    assert text.count(old)==1,(old[:100],text.count(old))
    return text.replace(old,new,1)
name='native-helpers/app-container/main.cpp';s=Path(name).read_text(encoding='utf-8')
s=once(s,'#include <shellapi.h>','#include <shellapi.h>\n#include <pathcch.h>')
s=once(s,'''    for (auto cursor = path; !cursor.empty(); cursor = cursor.parent_path()) {
        const DWORD attr = GetFileAttributesW(cursor.c_str());
        require(attr != INVALID_FILE_ATTRIBUTES, "Sandbox path unavailable");
        require((attr & FILE_ATTRIBUTE_REPARSE_POINT) == 0, "Sandbox paths cannot contain reparse points");
        if (cursor == cursor.parent_path()) break;
    }''','''    // MSVC filesystem treats the extended namespace prefix as root_path(),
    // so parent_path() walks past \\?\\X:\\ into invalid \\?\\X: and \\?\\.
    // Keep the extended spelling and let Windows identify the real volume root.
    const auto native = path.native();
    require(!native.empty() && native.size() < PATHCCH_MAX_CCH, "Sandbox path exceeds Windows limit");
    std::vector<wchar_t> cursor(native.begin(), native.end());
    cursor.push_back(L'\\0');
    size_t previous_length = native.size();
    for (;;) {
        const DWORD attr = GetFileAttributesW(cursor.data());
        require(attr != INVALID_FILE_ATTRIBUTES, "Sandbox path unavailable");
        require((attr & FILE_ATTRIBUTE_REPARSE_POINT) == 0, "Sandbox paths cannot contain reparse points");
        if (PathCchIsRoot(cursor.data())) break;
        const HRESULT result = PathCchRemoveFileSpec(cursor.data(), cursor.size());
        require(result == S_OK, "Cannot resolve sandbox parent");
        const size_t length = wcslen(cursor.data());
        require(length > 0 && length < previous_length, "Sandbox ancestry made no progress");
        previous_length = length;
    }''')
save(name,s)
name='native-helpers/app-container/CMakeLists.txt';s=Path(name).read_text()
s=once(s,'PRIVATE userenv advapi32 shell32)','PRIVATE userenv advapi32 shell32 pathcch)');save(name,s)
name='aiTemp/completion/native_test.py';s=Path(name).read_text()
s=once(s,'def request(command,timeout=4000):\n    run=subprocess.run([str(helper),profile,str(input_dir.resolve()),str(work.resolve()),str(timeout),\'--\',*command]', '''def request(command,timeout=4000,extended=True):
    def spelling(path):
        value=str(path)
        prefix='\\\\'*2+'?'+ '\\\\'
        return value if not extended or value.startswith(prefix) else prefix+value
    command=[spelling(command[0]),*command[1:]]
    run=subprocess.run([str(helper),profile,spelling(input_dir.resolve()),spelling(work.resolve()),str(timeout),'--',*command]''')
s=once(s,'result=request(args)\nassert result[\'exit_code\']==0', '''ordinary=request(args,extended=False)
assert ordinary['exit_code']==0 and not ordinary['timed_out'],ordinary
assert json.loads(ordinary['stdout'])=={'container':True,'input_read':True,'input_write':False,'external_read':False,'external_write':False,'work_write':True,'network':False},ordinary
result=request(args)
assert result['exit_code']==0''')
s=once(s,"'native_token_verified':True,", "'native_token_verified':True,'ordinary_and_extended_paths_verified':True,")
save(name,s)
subprocess.run(['git','add','--',*changed],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('Only parent traversal and its existing native checks changed; no isolation or permission fallback added.')
