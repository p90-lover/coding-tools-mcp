"""Diagnose fixed fixture startup only; no production source changes or model calls."""
import hashlib,json,os,subprocess
from pathlib import Path
root=Path('aiTemp/startup-diagnostic').resolve();out=root/'evidence';out.mkdir(exist_ok=False)
workspace=root/'workspace';workspace.mkdir(exist_ok=False)
home=root/'sandbox-state';(home/'aiTemp').mkdir(parents=True,exist_ok=False)
helpers=Path(os.environ['GITHUB_WORKSPACE'])/'aiTemp/helpers'
manifest=json.loads((helpers/'manifest.json').read_text())
assert manifest['upstream_commit']=='3caf9f9586baedb4158a7b91545ead3dd320c348'
for name,digest in manifest['files'].items():assert hashlib.sha256((helpers/name).read_bytes()).hexdigest()==digest
probe=workspace/'ctmcp-startup-fixture.exe'
source=root/'fixture.rs';source.write_text('fn main() { println!("FIXTURE_MAIN_REACHED"); }\n')
subprocess.run(['rustc','--edition','2021',str(source),'-o',str(probe)],check=True)
vswhere=Path(os.environ['ProgramFiles(x86)'])/'Microsoft Visual Studio/Installer/vswhere.exe'
install=subprocess.check_output([str(vswhere),'-latest','-products','*','-requires','Microsoft.VisualStudio.Component.VC.Tools.x86.x64','-property','installationPath'],text=True).strip()
assert install and Path(install).is_dir()
script=root/'compile.cmd';binary=root/'access-diagnostic.exe'
script.write_text(f'@echo off\ncall "{install}\\Common7\\Tools\\VsDevCmd.bat" -arch=x64 >nul\nif errorlevel 1 exit /b 1\ncl /nologo /std:c++17 /EHsc /W4 /MT "{root / "probe.cpp"}" /Fo"{root / "probe.obj"}" /Fe"{binary}"\n',encoding='utf-8')
subprocess.run([os.environ['COMSPEC'],'/d','/c',str(script)],check=True)
env={k:v for k,v in os.environ.items() if k.upper() in {'SYSTEMROOT','SYSTEMDRIVE','WINDIR','PROGRAMFILES','PROGRAMFILES(X86)','PROGRAMDATA','USERNAME','USERPROFILE','LOCALAPPDATA','APPDATA'}}
env.update(CODING_TOOLS_LOCAL_SANDBOX_SETUP='1',TEMP=str(home/'aiTemp'),TMP=str(home/'aiTemp'),OTEL_SDK_DISABLED='true')
request={'operation':'setup','workspace':str(workspace),'home':str(home),'argv':[],'timeout_ms':8000}
result=subprocess.run([str(helpers/'coding-tools-codex-sandbox.exe')],input=json.dumps(request).encode(),capture_output=True,env=env,timeout=180)
value=json.loads(result.stdout);assert value.get('ok') and value.get('ready'),value
(out/'setup.txt').write_text(json.dumps(value)+'\n')
caps=json.loads((home/'cap_sid').read_text());sids=[*caps['workspace_by_cwd'].values(),*caps['writable_root_by_path'].values()]
assert len(sids)>=3
for label,extra in [('strict',[]),('restricted-code-comparison',['S-1-5-12'])]:
 result=subprocess.run([str(binary),str(probe),str(workspace),*sids,*extra],capture_output=True,timeout=30)
 text=result.stdout.decode('utf-8',errors='replace')+'\n'+result.stderr.decode('utf-8',errors='replace')
 (out/(label+'.txt')).write_text(text,encoding='utf-8')
 print(label,'diagnostic_exit=',result.returncode);print(text)
 assert result.returncode==0,'Diagnostic harness must finish normally'
