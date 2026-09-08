"""Complete the same native runtime probe with bounded system import discovery."""
from pathlib import Path
import struct

def dependency_closure(runtime, names):
    pending=list(names)+['fwpuclnt.dll','rasadhlp.dll']
    found={}
    while pending:
        name=pending.pop().lower()
        assert len(name)<=128 and Path(name).name==name and '/' not in name and '\\' not in name and ':' not in name
        assert name.endswith(('.exe','.dll'))
        if name in found:continue
        file=runtime/name
        if not file.is_file():continue
        assert not file.is_symlink()
        found[name]=file
        assert len(found)<=256
        data=file.read_bytes();assert 64<=len(data)<=64*1024*1024 and data[:2]==b'MZ'
        nt=struct.unpack_from('<I',data,60)[0]
        assert data[nt:nt+4]==b'PE\0\0'
        n,optional=struct.unpack_from('<H',data,nt+6)[0],struct.unpack_from('<H',data,nt+20)[0]
        assert n<=96
        op=nt+24;magic=struct.unpack_from('<H',data,op)[0];assert magic in (0x10b,0x20b)
        directory=op+(112 if magic==0x20b else 96)
        sections=op+optional
        def offset(rva):
            for i in range(n):
                virtual_size,va,raw_size,raw=struct.unpack_from('<IIII',data,sections+i*40+8)
                if va<=rva<va+max(virtual_size,raw_size):
                    out=raw+rva-va;assert out<len(data);return out
            raise AssertionError(('unmapped resource RVA',name,rva))
        import_rva,import_size=struct.unpack_from('<II',data,directory+8)
        if not import_rva:continue
        start=offset(import_rva)
        for i in range(min(import_size//20+1,1024)):
            entry=struct.unpack_from('<IIIII',data,start+i*20)
            if not any(entry):break
            pos=offset(entry[3]);end=data.index(b'\0',pos,min(pos+129,len(data)))
            dependency=data[pos:end].decode('ascii').lower()
            pending.append(dependency)
        else:raise AssertionError(('unterminated import table',name))
    print('runtime dependency closure',sorted(found),flush=True)
    files=list(found.values())
    languages=[p for p in runtime.iterdir() if p.is_dir() and not p.is_symlink() and '-' in p.name and len(p.name)<32]
    assert len(languages)<=128
    for directory in languages:
        for name in found:
            resource=directory/(name+'.mui')
            if resource.is_file():
                assert not resource.is_symlink();files.append(resource)
    assert len(files)<=1024
    return files

source=Path('aiTemp/release-verification/runtime_acl_probe.py').read_text(encoding='utf-8')
old="files=[runtime/n for n in names if (runtime/n).is_file()]"
assert source.count(old)==1
source=source.replace(old,"files=dependency_closure(runtime,names)")
# The original experiment remains preserved and the real ver/network assertions
# remain unchanged. No release proof or production files are materialized here.
exec(compile(source,'runtime_dependency_experiment','exec'),globals())
