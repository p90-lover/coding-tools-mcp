from pathlib import Path
import shutil
p=Path('aiTemp/completion/native_probe.cpp')
s=p.read_text(encoding='utf-8')
old='if(s!=INVALID_SOCKET){network=connect(s,reinterpret_cast<sockaddr*>(&address),sizeof(address))==0;closesocket(s);}WSACleanup();'
new='''if(s!=INVALID_SOCKET){
            // A policy-denied connect can stall rather than return WSAEACCES.
            // Bound the probe, not the sandbox policy; baseline must still connect.
            u_long nonblocking=1;ioctlsocket(s,FIONBIO,&nonblocking);
            const int connected=connect(s,reinterpret_cast<sockaddr*>(&address),sizeof(address));
            if(connected==0)network=true;
            else if(WSAGetLastError()==WSAEWOULDBLOCK){
                fd_set writes,errors;FD_ZERO(&writes);FD_ZERO(&errors);FD_SET(s,&writes);FD_SET(s,&errors);
                timeval deadline{0,300000};
                if(select(0,nullptr,&writes,&errors,&deadline)>0 && FD_ISSET(s,&writes)){
                    int error=0;int length=sizeof(error);
                    network=getsockopt(s,SOL_SOCKET,SO_ERROR,reinterpret_cast<char*>(&error),&length)==0 && error==0;
                }
            }
            closesocket(s);
        }WSACleanup();'''
assert s.count(old)==1
backup=Path('aiTemp/Trash/native-probe-before.cpp');backup.parent.mkdir(parents=True,exist_ok=True)
assert not backup.exists();shutil.copy2(p,backup)
p.write_text(s.replace(old,new),encoding='utf-8')
