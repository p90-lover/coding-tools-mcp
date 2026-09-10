"""Repair the reproduced cmd parser failure; preserve all isolation checks and originals."""
from pathlib import Path
import os,shutil,subprocess
changed=[]
def once(text,old,new):
    assert text.count(old)==1,(old[:90],text.count(old))
    return text.replace(old,new,1)
def save(name,text):
    path=Path(name)
    if path.read_text(encoding='utf-8')==text:return
    backup=Path('aiTemp/Trash/snapshot-command-before')/os.environ['GITHUB_RUN_ID']/name
    backup.parent.mkdir(parents=True,exist_ok=True)
    assert not backup.exists() and not path.is_symlink()
    shutil.copy2(path,backup)
    path.write_text(text,encoding='utf-8');changed.append(name)
name='native-helpers/app-container/main.cpp';text=Path(name).read_text(encoding='utf-8')
if 'cmd_uses_command_string_not_crt_argv' not in text:
    old='''        std::wstring command = quote(executable.wstring());
        for (int i = 7; i < argc; ++i) { command += L" "; command += quote(argv[i]); }'''
    new='''        std::wstring command = quote(executable.wstring());
        // cmd_uses_command_string_not_crt_argv: quoting /c as a CRT argument
        // makes cmd misparse even echo. Only the real system command interpreter
        // receives this explicit grammar; ordinary EXEs retain literal argv.
        if (fs::equivalent(executable, system / L"cmd.exe")) {
            const bool long_form = argc == 11 && _wcsicmp(argv[7], L"/d") == 0
                && _wcsicmp(argv[8], L"/s") == 0 && _wcsicmp(argv[9], L"/c") == 0;
            const bool short_form = argc == 10 && _wcsicmp(argv[7], L"/d") == 0
                && _wcsicmp(argv[8], L"/c") == 0;
            require(long_form || short_form, "cmd requires /d [/s] /c and one command string; no interactive fallback");
            const std::wstring script = argv[argc - 1];
            require(!script.empty() && script.find_first_of(L"\\r\\n") == std::wstring::npos,
                "cmd command must be a nonempty single line");
            // /s strips only this outer pair; quotes inside the user's command
            // belong to cmd syntax, not the CRT backslash-quote convention.
            // The command still executes under the exact same AppContainer job.
            command += L" /d /v:off /s /c \\"";
            command += script;
            command += L"\\"";
        } else {
            for (int i = 7; i < argc; ++i) { command += L" "; command += quote(argv[i]); }
        }'''
    # The source strings above contain escaped quote delimiters, not shell input.
    new=new.replace('L" /d /v:off /s /c \\\\""','L" /d /v:off /s /c \\""')
    text=once(text,old,new);save(name,text)
name='aiTemp/completion/native_test.py';text=Path(name).read_text()
if 'cmd_parser_verified' not in text:
    insert='''# Same native boundary group also covers the real system cmd parser. The
# previous all-quoted switches failed both echo and the integrated file read.
cmd=str(Path(os.environ['SystemRoot'])/'System32/cmd.exe')
space_file=input_dir/'input with spaces.txt';space_file.write_text('SPACED_INPUT_UNCHANGED')
for extended in [False,True]:
    echo=request([cmd,'/d','/s','/c','echo SNAPSHOT_OK'],extended=extended)
    assert echo['exit_code']==0 and 'SNAPSHOT_OK' in echo['stdout'],echo
    read=request([cmd,'/d','/c','type "%MCP_SANDBOX_INPUT%\\\\input with spaces.txt"'],extended=extended)
    assert read['exit_code']==0 and read['stdout']=='SPACED_INPUT_UNCHANGED',read
assert space_file.read_text()=='SPACED_INPUT_UNCHANGED'
print('PASS: real cmd parser preserves quoted file names for ordinary and extended snapshot paths',flush=True)
'''
    text=once(text,'late=work/\'late-marker.txt\'',insert+"late=work/'late-marker.txt'")
    text=once(text,"'ordinary_and_extended_paths_verified':True,","'ordinary_and_extended_paths_verified':True,'cmd_parser_verified':True,")
    save(name,text)
name='aiTemp/sandbox-permissions/contract.rs';text=Path(name).read_text()
if 'source space.txt' not in text:
    start=text.index('fn snapshot_contract_actual_executor_and_live_revocation_stop_owned_descendants()')
    before,part=text[:start],text[start:]
    part=part.replace('source.txt','source space.txt')
    part=once(part,'"type %MCP_SANDBOX_INPUT%\\\\source space.txt"','"type \\"%MCP_SANDBOX_INPUT%\\\\source space.txt\\""')
    save(name,before+part)
subprocess.run(['rustfmt','--edition','2021','--config','skip_children=true','aiTemp/sandbox-permissions/contract.rs'],check=True)
subprocess.run(['git','add','--','native-helpers/app-container/main.cpp','aiTemp/completion/native_test.py','aiTemp/sandbox-permissions/contract.rs'],check=True)
subprocess.run(['git','diff','--cached','--check'],check=True)
assert not subprocess.check_output(['git','diff','--cached','--diff-filter=D','--name-only']).strip()
print('Command-parser patch applied; AppContainer flags, SID verification, grants and revocation unchanged.')
