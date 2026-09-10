// Native no-network AppContainer command runner. No Codex, provider or model SDK.
// Every requested process starts suspended and joins a kill-on-close Job before
// it may execute. Input is a read-only copy; output is a separate scratch tree.
#include <windows.h>
#include <userenv.h>
#include <sddl.h>
#include <aclapi.h>
#include <shellapi.h>
#include <pathcch.h>
#include <algorithm>
#include <atomic>
#include <chrono>
#include <filesystem>
#include <iostream>
#include <stdexcept>
#include <string>
#include <thread>
#include <vector>
namespace fs = std::filesystem;

struct Handle {
    HANDLE value = nullptr;
    Handle() = default;
    explicit Handle(HANDLE h) : value(h) {}
    Handle(const Handle&) = delete;
    Handle& operator=(const Handle&) = delete;
    ~Handle() { close(); }
    void close() { if (value && value != INVALID_HANDLE_VALUE) CloseHandle(value); value = nullptr; }
};
struct LocalMemory {
    void* value = nullptr;
    ~LocalMemory() { if (value) LocalFree(value); }
};
struct SidMemory {
    PSID value = nullptr;
    ~SidMemory() { if (value) FreeSid(value); }
};
struct Attributes {
    std::vector<unsigned char> memory;
    LPPROC_THREAD_ATTRIBUTE_LIST list = nullptr;
    Attributes() {
        SIZE_T size = 0;
        InitializeProcThreadAttributeList(nullptr, 2, 0, &size);
        if (!size) throw std::runtime_error("Cannot allocate process attributes");
        memory.resize(size);
        list = reinterpret_cast<LPPROC_THREAD_ATTRIBUTE_LIST>(memory.data());
        if (!InitializeProcThreadAttributeList(list, 2, 0, &size)) throw std::runtime_error("Cannot initialize process attributes");
    }
    ~Attributes() { if (list) DeleteProcThreadAttributeList(list); }
};
static void require(bool ok, const char* text) {
    if (!ok) throw std::runtime_error(std::string(text) + " (Win32=" + std::to_string(GetLastError()) + ")");
}
static std::wstring current_user_sid() {
    Handle token;
    require(OpenProcessToken(GetCurrentProcess(), TOKEN_QUERY, &token.value) != 0, "Cannot read caller identity");
    DWORD size = 0;
    GetTokenInformation(token.value, TokenUser, nullptr, 0, &size);
    std::vector<unsigned char> bytes(size);
    require(GetTokenInformation(token.value, TokenUser, bytes.data(), size, &size) != 0, "Cannot read caller SID");
    LPWSTR value = nullptr;
    require(ConvertSidToStringSidW(reinterpret_cast<TOKEN_USER*>(bytes.data())->User.Sid, &value) != 0, "Cannot encode caller SID");
    LocalMemory text{value};
    return value;
}
static std::wstring sid_text(PSID sid) {
    LPWSTR value = nullptr;
    require(ConvertSidToStringSidW(sid, &value) != 0, "Cannot encode sandbox SID");
    LocalMemory text{value};
    return value;
}
static void safe_path(const fs::path& path, bool directory) {
    require(path.is_absolute(), "Sandbox path must be absolute");
    // MSVC filesystem treats the extended namespace prefix as root_path(),
    // so parent_path() walks past \?\X:\ into invalid \?\X: and \?\.
    // Keep the extended spelling and let Windows identify the real volume root.
    const auto native = path.native();
    require(!native.empty() && native.size() < PATHCCH_MAX_CCH, "Sandbox path exceeds Windows limit");
    std::vector<wchar_t> cursor(native.begin(), native.end());
    cursor.push_back(L'\0');
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
    }
    require(directory ? fs::is_directory(path) : fs::is_regular_file(path), "Unexpected sandbox path kind");
}
static bool within(const fs::path& child, const fs::path& root) {
    auto c = child.begin();
    for (auto r = root.begin(); r != root.end(); ++r, ++c) {
        if (c == child.end() || _wcsicmp(c->c_str(), r->c_str()) != 0) return false;
    }
    return true;
}
static void protect_tree(const fs::path& path, const std::wstring& owner, const std::wstring& sandbox, bool writable) {
    // Protected DACLs do not inherit broad rights from a project or temp parent.
    // The container never receives DELETE/DELETE_CHILD/WRITE_DAC/WRITE_OWNER.
    const std::wstring rights = writable ? L"0x1201bf" : L"0x1200a9";
    const std::wstring sddl = L"D:P(A;OICI;FA;;;SY)(A;OICI;FA;;;" + owner + L")(A;OICI;" + rights + L";;;" + sandbox + L")";
    PSECURITY_DESCRIPTOR descriptor = nullptr;
    require(ConvertStringSecurityDescriptorToSecurityDescriptorW(sddl.c_str(), SDDL_REVISION_1, &descriptor, nullptr) != 0, "Cannot build restricted ACL");
    LocalMemory memory{descriptor};
    PACL acl = nullptr;
    BOOL present = FALSE, defaulted = FALSE;
    require(GetSecurityDescriptorDacl(descriptor, &present, &acl, &defaulted) != 0 && present, "Cannot read restricted ACL");
    auto apply = [&](const fs::path& p) {
        const DWORD attr = GetFileAttributesW(p.c_str());
        require(attr != INVALID_FILE_ATTRIBUTES && !(attr & FILE_ATTRIBUTE_REPARSE_POINT), "Reparse point encountered before ACL grant");
        const DWORD error = SetNamedSecurityInfoW(const_cast<wchar_t*>(p.c_str()), SE_FILE_OBJECT,
            DACL_SECURITY_INFORMATION | PROTECTED_DACL_SECURITY_INFORMATION, nullptr, nullptr, acl, nullptr);
        if (error != ERROR_SUCCESS) { SetLastError(error); require(false, "Cannot restrict sandbox directory"); }
    };
    apply(path);
    for (const auto& entry : fs::recursive_directory_iterator(path)) apply(entry.path());
}
static std::wstring quote(const std::wstring& value) {
    std::wstring result = L"\"";
    size_t slashes = 0;
    for (wchar_t c : value) {
        if (c == L'\\') { ++slashes; continue; }
        if (c == L'\"') result.append(slashes * 2 + 1, L'\\'); else result.append(slashes, L'\\');
        slashes = 0; result += c;
    }
    result.append(slashes * 2, L'\\'); result += L'\"';
    return result;
}
static std::string b64(const std::string& input) {
    static constexpr char alphabet[] = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    std::string output;
    output.reserve((input.size() + 2) / 3 * 4);
    for (size_t i = 0; i < input.size(); i += 3) {
        const unsigned a = static_cast<unsigned char>(input[i]);
        const unsigned b = i + 1 < input.size() ? static_cast<unsigned char>(input[i + 1]) : 0;
        const unsigned c = i + 2 < input.size() ? static_cast<unsigned char>(input[i + 2]) : 0;
        const unsigned n = (a << 16) | (b << 8) | c;
        output += alphabet[(n >> 18) & 63]; output += alphabet[(n >> 12) & 63];
        output += i + 1 < input.size() ? alphabet[(n >> 6) & 63] : '=';
        output += i + 2 < input.size() ? alphabet[n & 63] : '=';
    }
    return output;
}
static void read_pipe(HANDLE pipe, std::string& output, std::atomic_bool& overflow) {
    char buffer[4096]; DWORD count = 0;
    while (ReadFile(pipe, buffer, sizeof(buffer), &count, nullptr) && count) {
        const size_t keep = std::min<size_t>(count, 65536 - output.size());
        output.append(buffer, keep);
        if (keep < count) overflow.store(true);
    }
}
static bool disk_budget(const fs::path& path) {
    uintmax_t bytes = 0; size_t entries = 0;
    try {
        for (const auto& entry : fs::recursive_directory_iterator(path)) {
            if (++entries > 1024) return false;
            const DWORD attr = GetFileAttributesW(entry.path().c_str());
            if (attr == INVALID_FILE_ATTRIBUTES || (attr & FILE_ATTRIBUTE_REPARSE_POINT)) return false;
            if (entry.is_regular_file()) bytes += entry.file_size();
            if (bytes > 64ull * 1024 * 1024) return false;
        }
        return true;
    } catch (...) { return false; }
}
int wmain(int argc, wchar_t** argv) {
    try {
        if (argc == 2 && std::wstring(argv[1]) == L"--version") {
            std::cout << "{\"backend\":\"windows-appcontainer-v1\",\"model_requests\":0}"; return 0;
        }
        require(argc >= 7 && argc <= 38, "Expected profile, input, output, timeout, --, executable and literal arguments");
        // Rust assigns this trusted helper to an outer kill-on-close Job first.
        // No ACL or process side effect is permitted until admission is acknowledged.
        char admission[5]{};
        std::cin.read(admission, 5);
        require(std::cin.gcount() == 5 && std::string(admission,5) == "start", "Parent supervision handshake missing");
        const std::wstring profile = argv[1];
        require(profile.rfind(L"CodingToolsMcp.Snapshot.", 0) == 0 && profile.size() == 54
            && std::all_of(profile.begin() + 24, profile.end(), [](wchar_t c) { return (c >= L'0' && c <= L'9') || (c >= L'a' && c <= L'f'); }), "Invalid sandbox identity");
        const fs::path input = fs::canonical(argv[2]), output = fs::canonical(argv[3]);
        safe_path(fs::path(argv[2]), true); safe_path(fs::path(argv[3]), true);
        require(input != output && input.parent_path() == output.parent_path() && input.filename() == L"input" && output.filename() == L"work", "Input and work must be sibling snapshot directories");
        wchar_t* end = nullptr; const unsigned long timeout = wcstoul(argv[4], &end, 10);
        require(end && *end == L'\0' && timeout >= 100 && timeout <= 30000 && std::wstring(argv[5]) == L"--", "Invalid sandbox deadline");
        wchar_t system_buffer[MAX_PATH]{};
        const UINT system_length = GetSystemDirectoryW(system_buffer, MAX_PATH);
        require(system_length && system_length < MAX_PATH, "Cannot locate Windows system directory");
        const fs::path system = fs::canonical(system_buffer), executable = fs::canonical(argv[6]);
        safe_path(fs::path(argv[6]), false);
        require(within(executable, input) || within(executable, system), "Executable must be a copied input or Windows system program");
        require(disk_budget(input) && disk_budget(output), "Snapshot exceeds disk budget");
        SidMemory sid;
        HRESULT hr = CreateAppContainerProfile(profile.c_str(), L"Coding Tools MCP snapshot sandbox", L"Locally approved, no network capabilities", nullptr, 0, &sid.value);
        if (hr == HRESULT_FROM_WIN32(ERROR_ALREADY_EXISTS)) hr = DeriveAppContainerSidFromAppContainerName(profile.c_str(), &sid.value);
        require(SUCCEEDED(hr) && sid.value, "Cannot create or derive AppContainer identity");
        const auto owner = current_user_sid(), package = sid_text(sid.value);
        protect_tree(input, owner, package, false); protect_tree(output, owner, package, true);

        Handle job(CreateJobObjectW(nullptr, nullptr)); require(job.value != nullptr, "Cannot create process job");
        JOBOBJECT_EXTENDED_LIMIT_INFORMATION limits{};
        limits.BasicLimitInformation.LimitFlags = JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE | JOB_OBJECT_LIMIT_ACTIVE_PROCESS | JOB_OBJECT_LIMIT_JOB_MEMORY;
        limits.BasicLimitInformation.ActiveProcessLimit = 16; limits.JobMemoryLimit = 512ull * 1024 * 1024;
        require(SetInformationJobObject(job.value, JobObjectExtendedLimitInformation, &limits, sizeof(limits)) != 0, "Cannot enforce process limits");
        JOBOBJECT_BASIC_UI_RESTRICTIONS ui{};
        ui.UIRestrictionsClass = JOB_OBJECT_UILIMIT_HANDLES | JOB_OBJECT_UILIMIT_READCLIPBOARD | JOB_OBJECT_UILIMIT_WRITECLIPBOARD | JOB_OBJECT_UILIMIT_SYSTEMPARAMETERS | JOB_OBJECT_UILIMIT_DISPLAYSETTINGS | JOB_OBJECT_UILIMIT_GLOBALATOMS | JOB_OBJECT_UILIMIT_DESKTOP | JOB_OBJECT_UILIMIT_EXITWINDOWS;
        require(SetInformationJobObject(job.value, JobObjectBasicUIRestrictions, &ui, sizeof(ui)) != 0, "Cannot enforce UI isolation");
        SECURITY_ATTRIBUTES security{sizeof(SECURITY_ATTRIBUTES), nullptr, TRUE};
        Handle out_read, out_write, err_read, err_write;
        require(CreatePipe(&out_read.value, &out_write.value, &security, 0) != 0 && CreatePipe(&err_read.value, &err_write.value, &security, 0) != 0, "Cannot create isolated output pipes");
        require(SetHandleInformation(out_read.value, HANDLE_FLAG_INHERIT, 0) != 0 && SetHandleInformation(err_read.value, HANDLE_FLAG_INHERIT, 0) != 0, "Cannot restrict pipe inheritance");
        Handle null_input(CreateFileW(L"NUL", GENERIC_READ, FILE_SHARE_READ | FILE_SHARE_WRITE, &security, OPEN_EXISTING, 0, nullptr));
        require(null_input.value != INVALID_HANDLE_VALUE, "Cannot create empty input");
        HANDLE handles[] = {null_input.value, out_write.value, err_write.value};
        SECURITY_CAPABILITIES capabilities{}; capabilities.AppContainerSid = sid.value;
        Attributes attributes;
        require(UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_SECURITY_CAPABILITIES, &capabilities, sizeof(capabilities), nullptr, nullptr) != 0, "Cannot configure AppContainer");
        require(UpdateProcThreadAttribute(attributes.list, 0, PROC_THREAD_ATTRIBUTE_HANDLE_LIST, handles, sizeof(handles), nullptr, nullptr) != 0, "Cannot restrict inherited handles");
        STARTUPINFOEXW startup{}; startup.StartupInfo.cb = sizeof(startup);
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES;
        startup.StartupInfo.hStdInput = null_input.value; startup.StartupInfo.hStdOutput = out_write.value; startup.StartupInfo.hStdError = err_write.value;
        startup.lpAttributeList = attributes.list;
        std::wstring command = quote(executable.wstring());
        // cmd_uses_command_string_not_crt_argv: quoted /c switches misparse even
        // echo. Only the real system interpreter receives explicit cmd grammar;
        // other EXEs retain literal argv. Native isolation is unchanged.
        if (fs::equivalent(executable, system / L"cmd.exe")) {
            const bool long_form = argc == 11 && _wcsicmp(argv[7], L"/d") == 0
                && _wcsicmp(argv[8], L"/s") == 0 && _wcsicmp(argv[9], L"/c") == 0;
            const bool short_form = argc == 10 && _wcsicmp(argv[7], L"/d") == 0
                && _wcsicmp(argv[8], L"/c") == 0;
            require(long_form || short_form, "cmd requires /d [/s] /c and one command string; no interactive fallback");
            const std::wstring script = argv[argc - 1];
            require(!script.empty() && script.find_first_of(std::wstring{wchar_t{13},wchar_t{10}}) == std::wstring::npos,
                "cmd command must be a nonempty single line");
            // /s strips this outer pair. Inner quotes are cmd syntax, not CRT
            // backslash-quote escapes. AutoRun and delayed expansion stay off.
            command += L" /d /v:off /s /c ";
            command.push_back(wchar_t{34});
            command += script;
            command.push_back(wchar_t{34});
        } else {
            for (int i = 7; i < argc; ++i) { command += L" "; command += quote(argv[i]); }
        }
        require(command.size() < 24000, "Command line exceeds limit");
        const fs::path windows = system.parent_path();
        std::vector<std::wstring> variables = {
            L"COMSPEC=" + (system / L"cmd.exe").wstring(), L"HOME=" + output.wstring(), L"USERPROFILE=" + output.wstring(),
            L"TEMP=" + output.wstring(), L"TMP=" + output.wstring(), L"APPDATA=" + output.wstring(), L"LOCALAPPDATA=" + output.wstring(),
            L"MCP_SANDBOX_INPUT=" + input.wstring(), L"MCP_SANDBOX_OUTPUT=" + output.wstring(),
            L"PATH=" + system.wstring() + L";" + (system / L"WindowsPowerShell/v1.0").wstring(),
            L"PATHEXT=.COM;.EXE;.BAT;.CMD", L"SystemRoot=" + windows.wstring(), L"WINDIR=" + windows.wstring(),
            L"POWERSHELL_TELEMETRY_OPTOUT=1", L"DOTNET_CLI_TELEMETRY_OPTOUT=1"
        };
        std::sort(variables.begin(), variables.end(), [](const auto& a, const auto& b) { return _wcsicmp(a.c_str(), b.c_str()) < 0; });
        std::vector<wchar_t> environment;
        for (const auto& variable : variables) { environment.insert(environment.end(), variable.begin(), variable.end()); environment.push_back(0); }
        environment.push_back(0);
        PROCESS_INFORMATION process{};
        require(CreateProcessW(executable.c_str(), command.data(), nullptr, nullptr, TRUE,
            CREATE_SUSPENDED | CREATE_NO_WINDOW | CREATE_UNICODE_ENVIRONMENT | EXTENDED_STARTUPINFO_PRESENT,
            environment.data(), output.c_str(), &startup.StartupInfo, &process) != 0, "AppContainer launch failed; no host fallback");
        Handle child(process.hProcess), thread(process.hThread);
        if (!AssignProcessToJobObject(job.value, child.value)) { TerminateProcess(child.value, 125); WaitForSingleObject(child.value, 5000); require(false, "Cannot supervise child; it was never resumed"); }
        out_write.close(); err_write.close(); null_input.close();
        // Verify the actual child token, not just the requested startup flag.
        Handle child_token; DWORD is_container = 0, returned = 0;
        if (!OpenProcessToken(child.value, TOKEN_QUERY, &child_token.value)
            || !GetTokenInformation(child_token.value, TokenIsAppContainer, &is_container, sizeof(is_container), &returned) || !is_container) {
            TerminateJobObject(job.value, 125); require(false, "Child AppContainer token could not be verified");
        }
        DWORD sid_size = 0;
        GetTokenInformation(child_token.value, TokenAppContainerSid, nullptr, 0, &sid_size);
        std::vector<unsigned char> actual_sid(sid_size);
        if (!sid_size || !GetTokenInformation(child_token.value, TokenAppContainerSid, actual_sid.data(), sid_size, &returned)
            || !EqualSid(reinterpret_cast<TOKEN_APPCONTAINER_INFORMATION*>(actual_sid.data())->TokenAppContainer, sid.value)) {
            TerminateJobObject(job.value,125); require(false,"Child sandbox identity did not match the requested profile");
        }
        require(ResumeThread(thread.value) != static_cast<DWORD>(-1), "Could not resume isolated process");
        std::string stdout_bytes, stderr_bytes; std::atomic_bool overflow{false};
        std::thread stdout_reader(read_pipe, out_read.value, std::ref(stdout_bytes), std::ref(overflow));
        std::thread stderr_reader(read_pipe, err_read.value, std::ref(stderr_bytes), std::ref(overflow));
        const auto start = std::chrono::steady_clock::now();
        bool timed_out = false, budget_exceeded = false;
        while (WaitForSingleObject(child.value, 20) == WAIT_TIMEOUT) {
            timed_out = std::chrono::steady_clock::now() - start >= std::chrono::milliseconds(timeout);
            budget_exceeded = overflow.load() || !disk_budget(output);
            if (timed_out || budget_exceeded) break;
        }
        DWORD exit = 125; GetExitCodeProcess(child.value, &exit);
        // Completion of the parent never grants descendants a longer lifetime.
        TerminateJobObject(job.value, timed_out ? 124 : 125);
        WaitForSingleObject(child.value, 5000);
        stdout_reader.join(); stderr_reader.join();
        std::cout << "{\"backend\":\"windows-appcontainer-v1\",\"appcontainer_token_verified\":true,\"requested_identity_verified\":true,\"network_capabilities\":0,\"model_requests\":0,\"exit_code\":"
            << (timed_out ? 124 : budget_exceeded ? 125 : exit) << ",\"timed_out\":" << (timed_out ? "true" : "false")
            << ",\"limit_exceeded\":" << ((budget_exceeded || overflow.load()) ? "true" : "false")
            << ",\"stdout_base64\":\"" << b64(stdout_bytes) << "\",\"stderr_base64\":\"" << b64(stderr_bytes) << "\"}";
        return 0;
    } catch (const std::exception& error) {
        std::cerr << "AppContainer refused: " << error.what() << '\n'; return 125;
    }
}
