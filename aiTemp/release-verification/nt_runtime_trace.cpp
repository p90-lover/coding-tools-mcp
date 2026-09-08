// Fixture-only self-instrumentation. No injection into other processes and no access-policy changes.
#include <winsock2.h>
#include <windows.h>
#include <winternl.h>
#include <cstdio>
#include "detours.h"
using OpenKey = NTSTATUS (NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
using OpenKeyEx = NTSTATUS (NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,ULONG);
using CreateFile = NTSTATUS (NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,PLARGE_INTEGER,ULONG,ULONG,ULONG,ULONG,PVOID,ULONG);
using OpenFile = NTSTATUS (NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES,PIO_STATUS_BLOCK,ULONG,ULONG);
using OpenObject = NTSTATUS (NTAPI*)(PHANDLE,ACCESS_MASK,POBJECT_ATTRIBUTES);
using QueryValue = NTSTATUS (NTAPI*)(HANDLE,PUNICODE_STRING,KEY_VALUE_INFORMATION_CLASS,PVOID,ULONG,PULONG);
static OpenKey originalKey; static OpenKeyEx originalKeyEx;
static CreateFile originalCreate; static OpenFile originalFile;
static OpenObject originalSection, originalDirectory, originalEvent;
static QueryValue originalQuery;
static thread_local bool printing=false;
static LONG count=0;
static void record(const char* op, NTSTATUS status, ACCESS_MASK access, POBJECT_ATTRIBUTES attrs) {
    if (status>=0 || printing || InterlockedIncrement(&count)>100) return;
    printing=true;
    const auto n=attrs?attrs->ObjectName:nullptr;
    std::printf("NT_FAILURE %s status=%08lx access=%08lx root=%p path=%.*ls\n",op,(ULONG)status,(ULONG)access,attrs?attrs->RootDirectory:nullptr,n?int(n->Length/2):0,n?n->Buffer:L"");
    std::fflush(stdout);printing=false;
}
static NTSTATUS NTAPI tracedKey(PHANDLE h,ACCESS_MASK a,POBJECT_ATTRIBUTES o) {auto r=originalKey(h,a,o);record("OpenKey",r,a,o);return r;}
static NTSTATUS NTAPI tracedKeyEx(PHANDLE h,ACCESS_MASK a,POBJECT_ATTRIBUTES o,ULONG f) {auto r=originalKeyEx(h,a,o,f);record("OpenKeyEx",r,a,o);return r;}
static NTSTATUS NTAPI tracedCreate(PHANDLE h,ACCESS_MASK a,POBJECT_ATTRIBUTES o,PIO_STATUS_BLOCK s,PLARGE_INTEGER z,ULONG at,ULONG sh,ULONG d,ULONG opt,PVOID ea,ULONG en) {auto r=originalCreate(h,a,o,s,z,at,sh,d,opt,ea,en);record("CreateFile",r,a,o);return r;}
static NTSTATUS NTAPI tracedFile(PHANDLE h,ACCESS_MASK a,POBJECT_ATTRIBUTES o,PIO_STATUS_BLOCK s,ULONG sh,ULONG opt) {auto r=originalFile(h,a,o,s,sh,opt);record("OpenFile",r,a,o);return r;}
static NTSTATUS NTAPI tracedSection(PHANDLE h,ACCESS_MASK a,POBJECT_ATTRIBUTES o) {auto r=originalSection(h,a,o);record("OpenSection",r,a,o);return r;}
static NTSTATUS NTAPI tracedDirectory(PHANDLE h,ACCESS_MASK a,POBJECT_ATTRIBUTES o) {auto r=originalDirectory(h,a,o);record("OpenDirectory",r,a,o);return r;}
static NTSTATUS NTAPI tracedEvent(PHANDLE h,ACCESS_MASK a,POBJECT_ATTRIBUTES o) {auto r=originalEvent(h,a,o);record("OpenEvent",r,a,o);return r;}
static NTSTATUS NTAPI tracedQuery(HANDLE h,PUNICODE_STRING n,KEY_VALUE_INFORMATION_CLASS c,PVOID b,ULONG z,PULONG out) {auto r=originalQuery(h,n,c,b,z,out);if(r==LONG(0xc0000022)||r==LONG(0xc0000034)){OBJECT_ATTRIBUTES o={};o.RootDirectory=h;o.ObjectName=n;record("QueryValue",r,0,&o);}return r;}
static bool install() {
    HMODULE n=GetModuleHandleW(L"ntdll.dll");
    if(DetourTransactionBegin()!=NO_ERROR || DetourUpdateThread(GetCurrentThread())!=NO_ERROR) return false;
#define HOOK(variable, api, replacement) variable=(decltype(variable))GetProcAddress(n,api); if(!variable || DetourAttach((PVOID*)&variable,(PVOID)replacement)!=NO_ERROR) {DetourTransactionAbort();return false;}
    HOOK(originalKey,"NtOpenKey",tracedKey)
    HOOK(originalKeyEx,"NtOpenKeyEx",tracedKeyEx)
    HOOK(originalCreate,"NtCreateFile",tracedCreate)
    HOOK(originalFile,"NtOpenFile",tracedFile)
    HOOK(originalSection,"NtOpenSection",tracedSection)
    HOOK(originalDirectory,"NtOpenDirectoryObject",tracedDirectory)
    HOOK(originalEvent,"NtOpenEvent",tracedEvent)
    HOOK(originalQuery,"NtQueryValueKey",tracedQuery)
#undef HOOK
    return DetourTransactionCommit()==NO_ERROR;
}
int main() {
    if(!install()){std::printf("Self-instrumentation unavailable: %lu\n",GetLastError());return 2;}
    WSADATA data={}; int r=WSAStartup(MAKEWORD(2,2),&data);
    std::printf("WSAStartup=%d\n",r); std::fflush(stdout);
    if(r!=0)return 3;
    for(int i=0;i<2;i++) {SOCKET s=WSASocketW(AF_INET,SOCK_STREAM,IPPROTO_TCP,nullptr,0,i?WSA_FLAG_OVERLAPPED:0);std::printf("WSASocket flags=%d success=%d error=%d\n",i,s!=INVALID_SOCKET,WSAGetLastError());std::fflush(stdout);if(s!=INVALID_SOCKET)closesocket(s);}
    WSACleanup();return 0;
}
