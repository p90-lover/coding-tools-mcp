// Isolated CI diagnosis: observe loader failures, never relax the production token.
#define NOMINMAX
#include <windows.h>
#include <sddl.h>
#include <aclapi.h>
#include <winternl.h>
#include <cstdio>
#include <string>
#include <vector>
#pragma comment(lib,"advapi32.lib")
#pragma comment(lib,"user32.lib")
static std::vector<BYTE> token_info(HANDLE token,TOKEN_INFORMATION_CLASS kind) {
 DWORD size=0;GetTokenInformation(token,kind,nullptr,0,&size);std::vector<BYTE> bytes(size);
 if (!size || !GetTokenInformation(token,kind,bytes.data(),size,&size)) throw GetLastError();return bytes;
}
static void check_file(const std::wstring& path) {
 HANDLE h=CreateFileW(path.c_str(),GENERIC_READ|GENERIC_EXECUTE,FILE_SHARE_READ|FILE_SHARE_WRITE|FILE_SHARE_DELETE,nullptr,OPEN_EXISTING,0,nullptr);
 std::wprintf(L"FILE %ls = %lu\n",path.c_str(),h==INVALID_HANDLE_VALUE?GetLastError():0);if(h!=INVALID_HANDLE_VALUE) CloseHandle(h);
}
static void check_kernel(const wchar_t* path,bool section) {
 UNICODE_STRING name{};name.Buffer=const_cast<PWSTR>(path);name.Length=static_cast<USHORT>(wcslen(path)*2);name.MaximumLength=name.Length+2;
 OBJECT_ATTRIBUTES attr{};attr.Length=sizeof(attr);attr.ObjectName=&name;attr.Attributes=0x40;
 using Open=NTSTATUS(NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
 auto fn=reinterpret_cast<Open>(GetProcAddress(GetModuleHandleW(L"ntdll.dll"),section?"NtOpenSection":"NtOpenDirectoryObject"));
 HANDLE h=nullptr;auto status=fn(&h,section?0x0d:0x03,&attr);std::wprintf(L"KERNEL %ls = 0x%08lx\n",path,status);if(h)CloseHandle(h);
}
int wmain(int argc,wchar_t** argv) {
 if(argc<4)return 2;
 try {
 HANDLE base=nullptr;if(!OpenProcessToken(GetCurrentProcess(),TOKEN_ALL_ACCESS,&base))throw GetLastError();
 auto groups=token_info(base,TokenGroups);auto user=token_info(base,TokenUser);
 PSID logon=nullptr;auto tg=reinterpret_cast<TOKEN_GROUPS*>(groups.data());
 for(DWORD i=0;i<tg->GroupCount;i++)if((tg->Groups[i].Attributes&SE_GROUP_LOGON_ID)==SE_GROUP_LOGON_ID)logon=tg->Groups[i].Sid;
 if(!logon)throw static_cast<DWORD>(ERROR_NO_SUCH_LOGON_SESSION);
 std::vector<PSID> owned;std::vector<SID_AND_ATTRIBUTES> restricted;
 for(int i=3;i<argc;i++){PSID sid=nullptr;if(!ConvertStringSidToSidW(argv[i],&sid))throw GetLastError();owned.push_back(sid);restricted.push_back({sid,0});}
 restricted.push_back({logon,0});HANDLE token=nullptr;
 if(!CreateRestrictedToken(base,DISABLE_MAX_PRIVILEGE|LUA_TOKEN,0,nullptr,0,nullptr,static_cast<DWORD>(restricted.size()),restricted.data(),&token))throw GetLastError();
 std::vector<EXPLICIT_ACCESSW> entries(restricted.size());
 for(size_t i=0;i<entries.size();i++){entries[i].grfAccessPermissions=GENERIC_ALL;entries[i].grfAccessMode=GRANT_ACCESS;entries[i].Trustee.TrusteeForm=TRUSTEE_IS_SID;entries[i].Trustee.ptstrName=reinterpret_cast<LPWSTR>(restricted[i].Sid);}
 PACL acl=nullptr;DWORD code=SetEntriesInAclW(static_cast<ULONG>(entries.size()),entries.data(),nullptr,&acl);if(code)throw code;
 TOKEN_DEFAULT_DACL dacl{acl};if(!SetTokenInformation(token,TokenDefaultDacl,&dacl,sizeof(dacl)))throw GetLastError();LocalFree(acl);
 wchar_t windows[MAX_PATH]{};GetWindowsDirectoryW(windows,MAX_PATH);
 if(!ImpersonateLoggedOnUser(token))throw GetLastError();check_file(argv[1]);
 for(auto name:{L"ntdll.dll",L"kernel32.dll",L"kernelbase.dll",L"msvcrt.dll",L"ucrtbase.dll",L"vcruntime140.dll",L"bcryptprimitives.dll"})check_file(std::wstring(windows)+L"\\System32\\"+name);
 check_kernel(L"\\KnownDlls",false);check_kernel(L"\\KnownDlls\\ntdll.dll",true);check_kernel(L"\\KnownDlls\\kernel32.dll",true);check_kernel(L"\\BaseNamedObjects",false);
 for(auto name:{L"SYSTEM\\CurrentControlSet\\Control\\Nls",L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options",L"SYSTEM\\CurrentControlSet\\Control\\Session Manager"}){
 HKEY key=nullptr;auto rc=RegOpenKeyExW(HKEY_LOCAL_MACHINE,name,0,KEY_READ,&key);std::wprintf(L"REGISTRY %ls = %ld\n",name,rc);if(key)RegCloseKey(key);}
 if(!RevertToSelf())throw GetLastError();std::fflush(stdout);
 HKEY ifeo=nullptr;code=RegCreateKeyExW(HKEY_LOCAL_MACHINE,L"SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\Image File Execution Options\\ctmcp-startup-fixture.exe",0,nullptr,0,KEY_SET_VALUE,nullptr,&ifeo,nullptr);
 if(code)throw code;DWORD flags=2;code=RegSetValueExW(ifeo,L"GlobalFlag",0,REG_DWORD,reinterpret_cast<BYTE*>(&flags),sizeof(flags));RegCloseKey(ifeo);if(code)throw code;
 LPWSTR owner=nullptr;if(!ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(user.data())->User.Sid,&owner))throw GetLastError();
 std::wstring sd=L"D:P(A;;GA;;;"+std::wstring(owner)+L")(A;;GA;;;"+argv[3]+L")";LocalFree(owner);
 PSECURITY_DESCRIPTOR descriptor=nullptr;if(!ConvertStringSecurityDescriptorToSecurityDescriptorW(sd.c_str(),SDDL_REVISION_1,&descriptor,nullptr))throw GetLastError();
 SECURITY_ATTRIBUTES sa{sizeof(sa),descriptor,FALSE};std::wstring desktop_name=L"CTMcpDiag-"+std::to_wstring(GetCurrentProcessId());
 HDESK desktop=CreateDesktopW(desktop_name.c_str(),nullptr,nullptr,0,GENERIC_ALL,&sa);LocalFree(descriptor);if(!desktop)throw GetLastError();
 STARTUPINFOW si{};si.cb=sizeof(si);std::wstring full_desktop=L"WinSta0\\"+desktop_name;si.lpDesktop=full_desktop.data();PROCESS_INFORMATION pi{};
 std::wstring command=L"\""+std::wstring(argv[1])+L"\"";
 SetErrorMode(SEM_FAILCRITICALERRORS|SEM_NOGPFAULTERRORBOX|SEM_NOOPENFILEERRORBOX);
 if(!CreateProcessAsUserW(token,nullptr,command.data(),nullptr,nullptr,FALSE,DEBUG_ONLY_THIS_PROCESS|CREATE_NO_WINDOW,nullptr,argv[2],&si,&pi))throw GetLastError();
 DebugSetProcessKillOnExit(TRUE);ULONGLONG until=GetTickCount64()+12000;bool done=false;size_t budget=65536;
 while(!done && GetTickCount64()<until){DEBUG_EVENT event{};if(!WaitForDebugEvent(&event,500))continue;DWORD continuation=DBG_CONTINUE;
 switch(event.dwDebugEventCode){
 case OUTPUT_DEBUG_STRING_EVENT:{auto& data=event.u.DebugString;size_t n=static_cast<size_t>(data.nDebugStringLength)*(data.fUnicode?2:1);if(n>8192)n=8192;if(n>budget)n=budget;std::vector<BYTE> text(n+2,0);SIZE_T read=0;
  if(n && ReadProcessMemory(pi.hProcess,data.lpDebugStringData,text.data(),n,&read)){budget-=read;if(data.fUnicode)std::wprintf(L"LOADER %.*ls\n",static_cast<int>(read/2),reinterpret_cast<wchar_t*>(text.data()));else std::printf("LOADER %.*s\n",static_cast<int>(read),text.data());}break;}
 case LOAD_DLL_DEBUG_EVENT:{auto h=event.u.LoadDll.hFile;if(h){wchar_t name[2048]{};if(GetFinalPathNameByHandleW(h,name,2048,0))std::wprintf(L"DLL %ls\n",name);CloseHandle(h);}break;}
 case CREATE_PROCESS_DEBUG_EVENT:if(event.u.CreateProcessInfo.hFile)CloseHandle(event.u.CreateProcessInfo.hFile);break;
 case EXCEPTION_DEBUG_EVENT:std::printf("EXCEPTION 0x%08lx first=%lu\n",event.u.Exception.ExceptionRecord.ExceptionCode,event.u.Exception.dwFirstChance);if(event.u.Exception.ExceptionRecord.ExceptionCode!=EXCEPTION_BREAKPOINT)continuation=DBG_EXCEPTION_NOT_HANDLED;break;
 case EXIT_PROCESS_DEBUG_EVENT:std::printf("EXIT 0x%08lx\n",event.u.ExitProcess.dwExitCode);done=true;break;
 default:break;}
 ContinueDebugEvent(event.dwProcessId,event.dwThreadId,continuation);std::fflush(stdout);}
 if(!done){TerminateProcess(pi.hProcess,124);DebugActiveProcessStop(pi.dwProcessId);std::puts("DEBUG_TIMEOUT");}
 CloseHandle(pi.hThread);CloseHandle(pi.hProcess);CloseDesktop(desktop);CloseHandle(token);CloseHandle(base);for(auto sid:owned)LocalFree(sid);
 return done?0:1;
 }catch(DWORD e){RevertToSelf();std::printf("HARNESS_ERROR %lu\n",e);return 3;}
}
