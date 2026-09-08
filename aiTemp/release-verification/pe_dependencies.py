"""Read bounded PE import metadata; never execute a dependency to discover it."""
import struct
from pathlib import Path

def imported_dlls(path):
    data=path.read_bytes()
    assert len(data)<=64_000_000 and data[:2]==b'MZ'
    def u16(offset): return struct.unpack_from('<H',data,offset)[0]
    def u32(offset): return struct.unpack_from('<I',data,offset)[0]
    pe=u32(0x3c);assert data[pe:pe+4]==b'PE\0\0'
    count=u16(pe+6);size=u16(pe+20);opt=pe+24
    assert count<=96 and u16(opt) in (0x10b,0x20b)
    directories=opt+(112 if u16(opt)==0x20b else 96)
    sections=opt+size
    def offset(rva):
        for i in range(count):
            section=sections+i*40;va=u32(section+12);raw_size=u32(section+16);raw=u32(section+20)
            if va<=rva<va+raw_size:
                result=raw+rva-va
                assert result<len(data)
                return result
        raise ValueError('unmapped import RVA')
    def name(rva):
        start=offset(rva);end=data.index(0,start,min(len(data),start+257))
        value=data[start:end].decode('ascii').lower()
        assert '/' not in value and '\\' not in value and ':' not in value and value.endswith('.dll')
        return value
    result=set()
    for directory,stride,name_at in [(1,20,12),(13,32,4)]:
        rva=u32(directories+directory*8)
        if not rva:continue
        start=offset(rva)
        for i in range(256):
            p=start+i*stride
            row=data[p:p+stride];assert len(row)==stride
            if not any(row):break
            if directory==13:assert u32(p)&1,'VA-style delayed imports not supported by diagnostic'
            result.add(name(u32(p+name_at)))
        else:raise ValueError('import descriptor limit exceeded')
    return result

def runtime_dependencies(runtime,seeds):
    todo=list(seeds);seen=set();result=[]
    while todo:
        name=todo.pop().lower()
        if name in seen:continue
        seen.add(name)
        if name.startswith(('api-ms-','ext-ms-')):continue
        path=runtime/name
        if not path.is_file():continue
        assert len(result)<128
        result.append(path)
        todo.extend(imported_dlls(path))
    return sorted(result)
