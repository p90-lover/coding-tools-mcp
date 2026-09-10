#define WIN32_LEAN_AND_MEAN
#define NOMINMAX
#include <winsock2.h>
#include <windows.h>
#include <filesystem>
#include <fstream>
#include <iostream>
#include <string>
#pragma comment(lib, "ws2_32.lib")
static bool can_open(const wchar_t* path, DWORD access) {
    HANDLE h=CreateFileW(path,access,FILE_SHARE_READ|FILE_SHARE_WRITE,nullptr,OPEN_EXISTING,0,nullptr);
    if(h==INVALID_HANDLE_VALUE)return false;CloseHandle(h);return true;
}
int wmain(int argc,wchar_t** argv){
    if(argc<2)return 2;
    if(std::wstring(argv[1])==L"hold"){
        const auto marker=std::filesystem::current_path()/L"late-marker.txt";
        std::wstring command=L"\""+std::wstring(argv[0])+L"\" late \""+marker.wstring()+L"\"";
        STARTUPINFOW si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};
        if(!CreateProcessW(argv[0],command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&si,&pi))return 3;
        CloseHandle(pi.hThread);CloseHandle(pi.hProcess);
        {std::ofstream started{std::filesystem::path(L"started.txt")};started<<"owned_child_started";}
        Sleep(15000);return 0;
    }
    if(std::wstring(argv[1])==L"linger"){
        if(argc==3){
            std::wstring command=L"\""+std::wstring(argv[0])+L"\" late \""+argv[2]+L"\"";
            STARTUPINFOW si{};si.cb=sizeof(si);PROCESS_INFORMATION pi{};
            if(!CreateProcessW(argv[0],command.data(),nullptr,nullptr,FALSE,CREATE_NO_WINDOW,nullptr,nullptr,&si,&pi))return 3;
            std::cout<<"owned_child_started="<<pi.dwProcessId<<std::endl;
            CloseHandle(pi.hThread);CloseHandle(pi.hProcess);
        }
        Sleep(15000);return 0;
    }
    if(std::wstring(argv[1])==L"late"){
        Sleep(2000);std::ofstream file{std::filesystem::path(argv[2])};file<<"must_not_survive";return 0;
    }
    if(std::wstring(argv[1])==L"overflow"){
        std::string block(4096,'x');for(int i=0;i<10000;i++)std::cout<<block;return 0;
    }
    if(argc!=6)return 4;
    HANDLE token=nullptr;DWORD is_container=0,size=0;
    if(OpenProcessToken(GetCurrentProcess(),TOKEN_QUERY,&token)){
        GetTokenInformation(token,TokenIsAppContainer,&is_container,sizeof(is_container),&size);CloseHandle(token);
    }
    const bool input=can_open(argv[2],GENERIC_READ),input_write=can_open(argv[2],GENERIC_WRITE);
    const bool external=can_open(argv[3],GENERIC_READ),external_write=can_open(argv[3],GENERIC_WRITE);
    std::ofstream output{std::filesystem::path(argv[4])};output<<"sandbox-output";const bool work_write=output.good();output.close();
    WSADATA wsa{};bool network=false;
    if(WSAStartup(MAKEWORD(2,2),&wsa)==0){
        SOCKET s=socket(AF_INET,SOCK_STREAM,IPPROTO_TCP);sockaddr_in address{};address.sin_family=AF_INET;
        address.sin_addr.s_addr=htonl(INADDR_LOOPBACK);address.sin_port=htons(static_cast<unsigned short>(_wtoi(argv[5])));
        if(s!=INVALID_SOCKET){
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
        }WSACleanup();
    }
    std::cout<<"{\"container\":"<<(is_container?"true":"false")<<",\"input_read\":"<<(input?"true":"false")
      <<",\"input_write\":"<<(input_write?"true":"false")<<",\"external_read\":"<<(external?"true":"false")
      <<",\"external_write\":"<<(external_write?"true":"false")<<",\"work_write\":"<<(work_write?"true":"false")
      <<",\"network\":"<<(network?"true":"false")<<"}";
    return 0;
}
