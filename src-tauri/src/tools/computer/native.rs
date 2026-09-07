//! Windows-only execution. UIA reads structure; SendInput uses the foreground desktop.
use std::collections::VecDeque;
use std::sync::{mpsc,OnceLock};
use std::time::{Duration,Instant};
use windows::core::{BOOL,PWSTR};
use windows::Win32::Foundation::{CloseHandle,HWND,LPARAM,POINT};
use windows::Win32::System::Com::{CoCreateInstance,CoInitializeEx,CoUninitialize,CLSCTX_INPROC_SERVER,COINIT_MULTITHREADED};
use windows::Win32::System::Threading::{GetCurrentProcessId,OpenProcess,QueryFullProcessImageNameW,PROCESS_NAME_WIN32,PROCESS_QUERY_LIMITED_INFORMATION};
use windows::Win32::UI::Accessibility::{CUIAutomation8,IUIAutomation,IUIAutomationElement,HWINEVENTHOOK,SetWinEventHook,UnhookWinEvent};
use windows::Win32::UI::Input::KeyboardAndMouse::*;
use windows::Win32::UI::WindowsAndMessaging::*;
use super::{error,Bounds,Control,Result,Target};

fn hwnd(t:&Target)->HWND {HWND(t.window_id as usize as *mut std::ffi::c_void)}
fn failure(message:&str)->super::WorkspaceError {error("WINDOWS_AUTOMATION_ERROR",message)}
struct Com;
impl Com {
    fn initialize()->Result<Self> {unsafe{CoInitializeEx(None,COINIT_MULTITHREADED)}.ok().map_err(|_|failure("Cannot initialize the UI Automation thread"))?;Ok(Self)}
}
impl Drop for Com {fn drop(&mut self){unsafe{CoUninitialize()};}}
fn automation()->Result<IUIAutomation> {unsafe{CoCreateInstance(&CUIAutomation8,None,CLSCTX_INPROC_SERVER)}.map_err(|_|failure("Windows UI Automation is unavailable"))}

unsafe extern "system" fn enum_window(window:HWND,param:LPARAM)->BOOL {
    if IsWindowVisible(window).as_bool() && !IsIconic(window).as_bool() {
        let mut text=[0u16;257];let n=GetWindowTextW(window,&mut text);
        let mut pid=0;GetWindowThreadProcessId(window,Some(&mut pid));
        if n>0 && pid!=GetCurrentProcessId() {
            let targets=&mut *(param.0 as *mut Vec<Target>);
            targets.push(Target{window_id:window.0 as usize as u32,pid,title:String::from_utf16_lossy(&text[..n as usize])});
            if targets.len()>=100 {return BOOL(0);}
        }
    }
    BOOL(1)
}
pub fn targets()->Result<Vec<Target>> {
    let mut targets=Vec::<Target>::new();
    // Returning false after the bounded limit also causes EnumWindows to stop.
    let result=unsafe{EnumWindows(Some(enum_window),LPARAM((&mut targets as *mut Vec<Target>) as isize))};
    if result.is_err() && targets.is_empty() {return Err(failure("Cannot list desktop windows"));}
    Ok(targets)
}
fn executable_name(pid:u32)->Result<String> {
    let process=unsafe{OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION,false,pid)}.map_err(|_|error("TARGET_ACCESS_DENIED","Target process cannot be inspected; no elevation is attempted"))?;
    let mut path=[0u16;32768];let mut len=path.len() as u32;
    let result=unsafe{QueryFullProcessImageNameW(process,PROCESS_NAME_WIN32,PWSTR(path.as_mut_ptr()),&mut len)};
    let _=unsafe{CloseHandle(process)};
    result.map_err(|_|failure("Cannot verify the target process identity"))?;
    Ok(String::from_utf16_lossy(&path[..len as usize]).rsplit(['\\','/']).next().unwrap_or("").to_ascii_lowercase())
}
pub fn validate_identity(target:&Target,foreground:bool)->Result<()> {
    let window=hwnd(target);let mut pid=0;
    unsafe{GetWindowThreadProcessId(window,Some(&mut pid))};
    if pid!=target.pid || !unsafe{IsWindow(Some(window))}.as_bool() || !unsafe{IsWindowVisible(window)}.as_bool() || unsafe{IsIconic(window)}.as_bool() {
        return Err(error("TARGET_CHANGED","Selected window closed, minimized, or changed process; no substitute was chosen"));
    }
    if target.pid==unsafe{GetCurrentProcessId()} {return Err(error("PROTECTED_TARGET","The controller cannot control its own permission or Stop interface"));}
    let name=executable_name(pid)?;
    if ["cmd.exe","powershell.exe","pwsh.exe","windowsterminal.exe","wt.exe","regedit.exe","taskmgr.exe","mmc.exe","consent.exe","credentialuibroker.exe","wscript.exe","cscript.exe"].contains(&name.as_str()) {
        return Err(error("PROTECTED_TARGET","Shell, system administration and credential windows are not computer-control targets; use their separately governed tools"));
    }
    if foreground && unsafe{GetForegroundWindow()}!=window {return Err(error("TARGET_NOT_FOREGROUND","The target is no longer foreground. Input stopped instead of acting on another window."));}
    Ok(())
}
pub fn validate_target(target:&Target,foreground:bool)->Result<Bounds> {
    validate_identity(target,foreground)?;
    let w=xcap::Window::all().map_err(|_|failure("Cannot verify target geometry"))?.into_iter()
        .find(|w|w.id().ok()==Some(target.window_id)&&w.pid().ok()==Some(target.pid))
        .ok_or_else(||error("TARGET_CHANGED","Target is no longer capturable"))?;
    let (x,y,width,height)=(w.x(),w.y(),w.width(),w.height());
    match (x,y,width,height) {
        (Ok(x),Ok(y),Ok(width),Ok(height)) if width>0&&height>0=>Ok(Bounds{x,y,width,height}),
        _=>Err(failure("Cannot determine target physical-pixel bounds")),
    }
}
pub fn focus(target:&Target)->Result<()> {
    validate_target(target,false)?;
    if !unsafe{SetForegroundWindow(hwnd(target))}.as_bool(){return Err(error("FOREGROUND_NOT_GRANTED","Windows did not grant focus. Click the selected target yourself, then retry."));}
    Ok(())
}
pub fn validate_point(target:&Target,x:i32,y:i32)->Result<()> {
    let bounds=validate_target(target,true)?;
    if !bounds.contains(x,y){return Err(error("POINT_OUTSIDE_TARGET","Input must remain inside the selected window"));}
    let under=unsafe{WindowFromPoint(POINT{x,y})};
    let root=unsafe{GetAncestor(under,GA_ROOT)};
    if root!=hwnd(target) {return Err(error("TARGET_OCCLUDED","Another window covers this point; no click or move was sent"));}
    Ok(())
}
pub fn validate_focus(target:&Target)->Result<()> {
    validate_target(target,true)?;
    let _com=Com::initialize()?;let uia=automation()?;
    let element=unsafe{uia.GetFocusedElement()}.map_err(|_|failure("Cannot verify focused control"))?;
    if unsafe{element.CurrentProcessId()}.unwrap_or(0) as u32!=target.pid || unsafe{element.CurrentIsPassword()}.map(|v|v.as_bool()).unwrap_or(true) {
        return Err(error("PROTECTED_FOCUS","Keyboard input is blocked for password controls or focus outside the selected process"));
    }
    Ok(())
}
fn role(id:i32)->String {
    match id {50000=>"Button",50002=>"CheckBox",50003=>"ComboBox",50004=>"Edit",50005=>"Hyperlink",50007=>"ListItem",50008=>"List",50009=>"Menu",50011=>"MenuItem",50013=>"RadioButton",50016=>"Tab",50017=>"TabItem",50020=>"Text",50023=>"Tree",50024=>"TreeItem",50025=>"Custom",50030=>"Document",50032=>"Window",50033=>"Pane",_=>return id.to_string()}.into()
}
fn control(e:&IUIAutomationElement,depth:u32)->Result<Control> {
    let password=unsafe{e.CurrentIsPassword()}.map(|v|v.as_bool()).unwrap_or(true);
    let rect=unsafe{e.CurrentBoundingRectangle()}.map_err(|_|failure("Control geometry unavailable"))?;
    Ok(Control{name:if password{"[protected]".into()}else{unsafe{e.CurrentName()}.map(|s|s.to_string().chars().take(256).collect()).unwrap_or_default()},
        automation_id:if password{String::new()}else{unsafe{e.CurrentAutomationId()}.map(|s|s.to_string().chars().take(256).collect()).unwrap_or_default()},
        role:role(unsafe{e.CurrentControlType()}.map(|v|v.0).unwrap_or(0)),
        enabled:unsafe{e.CurrentIsEnabled()}.map(|v|v.as_bool()).unwrap_or(false),
        offscreen:unsafe{e.CurrentIsOffscreen()}.map(|v|v.as_bool()).unwrap_or(true),password,
        focused:unsafe{e.CurrentHasKeyboardFocus()}.map(|v|v.as_bool()).unwrap_or(false),
        bounds:Bounds{x:rect.left,y:rect.top,width:rect.right.saturating_sub(rect.left).max(0) as u32,height:rect.bottom.saturating_sub(rect.top).max(0) as u32},depth})
}
pub fn inspect(target:&Target)->Result<(Vec<Control>,bool)> {
    validate_target(target,false)?;
    let _com=Com::initialize()?;let uia=automation()?;
    let root=unsafe{uia.ElementFromHandle(hwnd(target))}.map_err(|_|failure("No UI Automation root for this window"))?;
    let walker=unsafe{uia.ControlViewWalker()}.map_err(|_|failure("Cannot obtain control view"))?;
    let start=Instant::now();let mut pending=VecDeque::from([(root,0u32)]);let mut controls=Vec::new();let mut truncated=false;
    while let Some((node,depth))=pending.pop_front() {
        if controls.len()>=256||start.elapsed()>Duration::from_secs(2) {truncated=true;break;}
        if unsafe{node.CurrentProcessId()}.unwrap_or(0) as u32 != target.pid {continue;}
        if let Ok(c)=control(&node,depth) {controls.push(c);}
        if let Ok(mut child)=unsafe{walker.GetFirstChildElement(&node)} {
            if depth>=10 {truncated=true;continue;}
            loop {
                if pending.len()+controls.len()>=256||start.elapsed()>Duration::from_secs(2) {truncated=true;break;}
                pending.push_back((child.clone(),depth+1));
                match unsafe{walker.GetNextSiblingElement(&child)} {Ok(next)=>child=next,Err(_)=>break}
            }
        }
    }
    Ok((controls,truncated))
}
fn modifiers_clear()->Result<()> {
    for code in [VK_SHIFT,VK_CONTROL,VK_MENU,VK_LWIN,VK_RWIN] {
        if unsafe{GetAsyncKeyState(code.0 as i32)}<0 {return Err(error("USER_INPUT_ACTIVE","A physical modifier key is held; input was not interleaved"));}
    }Ok(())
}
fn send(events:&[INPUT])->Result<()> {
    let n=unsafe{SendInput(events,std::mem::size_of::<INPUT>() as i32)};
    if n as usize!=events.len() {return Err(error("INPUT_OUTCOME_UNKNOWN","Windows did not acknowledge every input. It may have been blocked by integrity protection; do not replay automatically."));}
    Ok(())
}
fn mouse(flags:MOUSE_EVENT_FLAGS,dx:i32,dy:i32,data:u32)->INPUT {
    INPUT{r#type:INPUT_MOUSE,Anonymous:INPUT_0{mi:MOUSEINPUT{dx,dy,mouseData:data,dwFlags:flags,time:0,dwExtraInfo:0}}}
}
fn move_event(point:(i32,i32))->Result<INPUT> {
    let (vx,vy,w,h)=unsafe{(GetSystemMetrics(SM_XVIRTUALSCREEN),GetSystemMetrics(SM_YVIRTUALSCREEN),GetSystemMetrics(SM_CXVIRTUALSCREEN),GetSystemMetrics(SM_CYVIRTUALSCREEN))};
    if w<2||h<2 {return Err(failure("Desktop geometry is invalid"));}
    let x=((i64::from(point.0)-i64::from(vx))*65535/(i64::from(w)-1)) as i32;
    let y=((i64::from(point.1)-i64::from(vy))*65535/(i64::from(h)-1)) as i32;
    if !(0..=65535).contains(&x)||!(0..=65535).contains(&y) {return Err(error("INVALID_COORDINATE","Point lies outside the physical desktop"));}
    Ok(mouse(MOUSEEVENTF_MOVE|MOUSEEVENTF_ABSOLUTE|MOUSEEVENTF_VIRTUALDESK,x,y,0))
}
pub fn move_pointer(t:&Target,p:(i32,i32),check:&dyn Fn()->Result<()>)->Result<()> {check()?;modifiers_clear()?;validate_point(t,p.0,p.1)?;send(&[move_event(p)?])}
pub fn click(t:&Target,p:(i32,i32),button:&str,check:&dyn Fn()->Result<()>)->Result<()> {
    let (down,up)=if button=="right"{(MOUSEEVENTF_RIGHTDOWN,MOUSEEVENTF_RIGHTUP)}else{(MOUSEEVENTF_LEFTDOWN,MOUSEEVENTF_LEFTUP)};
    for _ in 0..if button=="double"{2}else{1} {
        check()?;modifiers_clear()?;validate_point(t,p.0,p.1)?;
        let result=send(&[move_event(p)?,mouse(down,0,0,0),mouse(up,0,0,0)]);
        if result.is_err(){let _=send(&[mouse(up,0,0,0)]);return result;}
    }Ok(())
}
fn keyboard(vk:u16,scan:u16,flags:KEYBD_EVENT_FLAGS)->INPUT {INPUT{r#type:INPUT_KEYBOARD,Anonymous:INPUT_0{ki:KEYBDINPUT{wVk:VIRTUAL_KEY(vk),wScan:scan,dwFlags:flags,time:0,dwExtraInfo:0}}}}
pub fn type_text(t:&Target,text:&str,check:&dyn Fn()->Result<()>)->Result<()> {
    modifiers_clear()?;validate_focus(t)?;
    for (i,ch) in text.chars().enumerate() {
        check()?;
        if i%32==0 {modifiers_clear()?;validate_focus(t)?;}
        let mut units=[0u16;2];let mut inputs=Vec::new();let mut releases=Vec::new();
        for unit in ch.encode_utf16(&mut units).iter() {
            inputs.push(keyboard(0,*unit,KEYEVENTF_UNICODE));
            inputs.push(keyboard(0,*unit,KEYEVENTF_UNICODE|KEYEVENTF_KEYUP));
            releases.push(keyboard(0,*unit,KEYEVENTF_UNICODE|KEYEVENTF_KEYUP));
        }
        if let Err(e)=send(&inputs) {let _=send(&releases);return Err(e);}
    }Ok(())
}
pub fn key(t:&Target,key:&str,check:&dyn Fn()->Result<()>)->Result<()> {
    let keys=super::types::key_codes(key)?;check()?;modifiers_clear()?;validate_focus(t)?;
    let mut events=Vec::new();
    let flags=|k:u16|if matches!(k,0x21..=0x28){KEYEVENTF_EXTENDEDKEY}else{KEYBD_EVENT_FLAGS(0)};
    for k in &keys {events.push(keyboard(*k,0,flags(*k)));}
    let releases:Vec<_>=keys.iter().rev().map(|k|keyboard(*k,0,flags(*k)|KEYEVENTF_KEYUP)).collect();events.extend_from_slice(&releases);
    if let Err(e)=send(&events) {let _=send(&releases);return Err(e);}Ok(())
}
pub fn scroll(t:&Target,amount:i32,check:&dyn Fn()->Result<()>)->Result<()> {
    check()?;modifiers_clear()?;let mut p=POINT::default();unsafe{GetCursorPos(&mut p)}.map_err(|_|failure("Cursor position unavailable"))?;
    validate_point(t,p.x,p.y)?;send(&[mouse(MOUSEEVENTF_WHEEL,0,0,(amount*120) as u32)])
}
static MONITOR:OnceLock<std::result::Result<(),String>>=OnceLock::new();
unsafe extern "system" fn event_hook(_:HWINEVENTHOOK,_:u32,_:HWND,_:i32,_:i32,_:u32,_:u32) {super::wake();}
pub fn ensure_monitor()->Result<()> {
    let result=MONITOR.get_or_init(||{
        let (tx,rx)=mpsc::sync_channel(1);
        std::thread::spawn(move||unsafe{
            let registered=RegisterHotKey(None,0x43A1,MOD_CONTROL|MOD_ALT|MOD_NOREPEAT,0x1B);
            if registered.is_err(){let _=tx.send(Err("Cannot register Ctrl+Alt+Escape emergency Stop; control stays disabled".into()));return;}
            let hook=SetWinEventHook(0x0003,0x800C,None,Some(event_hook),0,0,0);
            if hook.0.is_null(){let _=UnregisterHotKey(None,0x43A1);let _=tx.send(Err("Cannot register desktop change notifications".into()));return;}
            let _=tx.send(Ok(()));let mut msg=MSG::default();
            while GetMessageW(&mut msg,None,0,0).0>0 {
                if msg.message==WM_HOTKEY && msg.wParam.0==0x43A1 {super::emergency_stop("Emergency Stop shortcut pressed");}
                let _=TranslateMessage(&msg);DispatchMessageW(&msg);
            }
            let _=UnhookWinEvent(hook);let _=UnregisterHotKey(None,0x43A1);
            super::emergency_stop("Emergency Stop monitor exited");
        });
        rx.recv_timeout(Duration::from_secs(2)).unwrap_or_else(|_|Err("Emergency Stop monitor did not start".into()))
    });
    result.clone().map_err(|m|error("STOP_MONITOR_UNAVAILABLE",&m))
}

#[cfg(test)]
mod fixture_test {
    use super::*;
    use windows::core::w;
    use windows::Win32::Foundation::WPARAM;
    use windows::Win32::System::LibraryLoader::GetModuleHandleW;
    use windows::Win32::System::Threading::GetCurrentThreadId;
    use base64::Engine;
    use serde_json::json;
    use std::io::{BufRead,Write};
    use std::process::{Child,Command,Stdio};

    unsafe extern "system" fn fixture_proc(w:HWND,m:u32,wp:WPARAM,lp:LPARAM)->windows::Win32::Foundation::LRESULT {
        if m==WM_DESTROY {PostQuitMessage(0);return windows::Win32::Foundation::LRESULT(0);}
        DefWindowProcW(w,m,wp,lp)
    }
    struct Fixture { target:Target,edit:usize,thread:u32,join:Option<std::thread::JoinHandle<()>> }
    impl Drop for Fixture {
        fn drop(&mut self) {
            super::super::emergency_stop("Test fixture ended");
            let _=unsafe{PostThreadMessageW(self.thread,WM_QUIT,WPARAM(0),LPARAM(0))};
            if let Some(handle)=self.join.take(){let _=handle.join();}
        }
    }
    fn fixture()->Fixture {
        let(tx,rx)=mpsc::sync_channel(1);
        let join=std::thread::spawn(move||unsafe {
            let instance=GetModuleHandleW(None).expect("test module");
            let class=WNDCLASSW{lpfnWndProc:Some(fixture_proc),hInstance:instance.into(),lpszClassName:w!("CodingToolsMemoryOnlySmoke"),..Default::default()};
            assert!(RegisterClassW(&class)!=0);
            let top=CreateWindowExW(WINDOW_EX_STYLE(0),w!("CodingToolsMemoryOnlySmoke"),w!("Computer use isolated native fixture"),WS_OVERLAPPEDWINDOW|WS_VISIBLE,160,120,660,360,None,None,Some(instance.into()),None).expect("fixture window");
            let edit=CreateWindowExW(WINDOW_EX_STYLE(0),w!("EDIT"),w!(""),WS_CHILD|WS_VISIBLE|WS_BORDER|WINDOW_STYLE(ES_AUTOHSCROLL as u32),40,60,500,60,Some(top),Some(HMENU(101usize as *mut std::ffi::c_void)),Some(instance.into()),None).expect("fixture edit");
            let _=ShowWindow(top,SW_SHOW);let _=SetForegroundWindow(top);let _=SetFocus(Some(edit));
            let mut msg=MSG::default();let _=PeekMessageW(&mut msg,None,0,0,PM_NOREMOVE);
            tx.send((top.0 as usize,edit.0 as usize,GetCurrentThreadId(),GetCurrentProcessId())).expect("fixture handoff");
            while GetMessageW(&mut msg,None,0,0).0>0 {let _=TranslateMessage(&msg);DispatchMessageW(&msg);}
            let _=DestroyWindow(top);
        });
        let(top,edit,thread,pid)=rx.recv_timeout(Duration::from_secs(10)).expect("fixture became ready");
        Fixture{target:Target{window_id:top as u32,pid,title:"Computer use isolated native fixture".into()},edit,thread,join:Some(join)}
    }
    // xcap deliberately excludes its own process. Keep that production safeguard
    // and exercise a separate fixture process, never a real user application.
    #[test]
    #[ignore="internal child-process host for the isolated native fixture"]
    fn computer_native_fixture_host() {
        assert_eq!(std::env::var("COMPUTER_USE_NATIVE_FIXTURE_HOST").as_deref(),Ok("1"));
        let f=fixture();
        println!("COMPUTER_FIXTURE_READY:{}",json!(f.target));
        std::io::stdout().flush().unwrap();
        for line in std::io::stdin().lock().lines() {
            match line.as_deref() {
                Ok("READ")=>{
                    let mut buffer=[0u16;256];
                    let n=unsafe{GetWindowTextW(HWND(f.edit as *mut std::ffi::c_void),&mut buffer)};
                    println!("COMPUTER_FIXTURE_TEXT:{}",json!(String::from_utf16_lossy(&buffer[..n as usize])));
                    std::io::stdout().flush().unwrap();
                },
                _=>break,
            }
        }
    }
    struct ExternalFixture { target:Target, child:Child, messages:mpsc::Receiver<String> }
    impl ExternalFixture {
        fn read_text(&mut self)->String {
            let input=self.child.stdin.as_mut().expect("fixture input pipe");
            writeln!(input,"READ").unwrap();input.flush().unwrap();
            let line=self.messages.recv_timeout(Duration::from_secs(3)).expect("actual fixture text response");
            let text=line.split_once("COMPUTER_FIXTURE_TEXT:").expect("fixture text protocol").1;
            serde_json::from_str(text).expect("fixture text JSON")
        }
    }
    impl Drop for ExternalFixture {
        fn drop(&mut self) {
            super::super::emergency_stop("External fixture ended");
            if let Some(mut input)=self.child.stdin.take(){let _=writeln!(input,"STOP");}
            let deadline=Instant::now()+Duration::from_secs(3);
            loop {
                if self.child.try_wait().ok().flatten().is_some(){break;}
                if Instant::now()>=deadline {let _=self.child.kill();let _=self.child.wait();break;}
                super::super::wait_tick(Duration::from_millis(20));
            }
        }
    }
    fn external_fixture()->ExternalFixture {
        let mut child=Command::new(std::env::current_exe().unwrap())
            .args(["--exact","tools::computer::native::fixture_test::computer_native_fixture_host","--ignored","--nocapture","--test-threads=1"])
            .env("COMPUTER_USE_NATIVE_FIXTURE_HOST","1")
            .stdin(Stdio::piped()).stdout(Stdio::piped()).stderr(Stdio::inherit()).spawn().expect("isolated fixture process");
        let stdout=child.stdout.take().unwrap();let(tx,rx)=mpsc::channel();
        std::thread::spawn(move||{
            for line in std::io::BufReader::new(stdout).lines().map_while(std::result::Result::ok) {
                if line.contains("COMPUTER_FIXTURE_") && tx.send(line).is_err(){break;}
            }
        });
        let ready=rx.recv_timeout(Duration::from_secs(10));
        let line=match ready {Ok(line)=>line,Err(e)=>{let _=child.kill();let _=child.wait();panic!("fixture readiness failed: {e}")}};
        let target:Target=serde_json::from_str(line.split_once("COMPUTER_FIXTURE_READY:").expect("fixture ready protocol").1).expect("fixture identity");
        assert_eq!(target.pid,child.id());
        ExternalFixture{target,child,messages:rx}
    }
    /// Explicitly run only on the isolated Windows CI desktop. No user windows or files.
    #[test]
    #[ignore="requires an isolated interactive Windows desktop"]
    fn computer_native_fixture_round_trip() {
        assert_eq!(std::env::var("COMPUTER_USE_NATIVE_SMOKE").as_deref(),Ok("1"));
        let mut f=external_fixture();let _=focus(&f.target);
        let root=std::env::current_dir().expect("workspace");
        super::super::local_arm(root,f.target.clone(),60).expect("arm isolated fixture");
        super::super::local_status(true,None);
        let lease=super::super::state().lease.clone().expect("local grant");
        let sel=super::super::Selector{role:Some("Edit".into()),..Default::default()};
        let found=super::super::find(&lease,&sel,true).expect("UIA Edit found uniquely");
        assert!(found.enabled&&!found.password);
        let click=super::super::types::Step::Click{selector:Some(sel.clone()),x:None,y:None,snapshot_id:None,button:"left".into()};
        let result=super::super::execute_step(&lease,&click,"fixture-click",&json!({"action":"click","selector":{"role":"Edit"}})).expect("scoped click");
        assert_eq!(result["ok"],true,"{result}");
        let raw=json!({"action":"type","text":"Memory-only vision ✓"});
        let step:super::super::types::Step=serde_json::from_value(raw.clone()).unwrap();
        super::super::local_status(true,None);
        let typed=super::super::execute_step(&lease,&step,"fixture-type",&raw).expect("real Unicode input");
        assert_eq!(typed["ok"],true,"{typed}");
        // Read the actual Edit control, waiting for its message loop to consume input.
        let start=Instant::now();let mut actual=String::new();
        while start.elapsed()<Duration::from_secs(3) {
            actual=f.read_text();
            if actual=="Memory-only vision ✓"{break;}
            super::super::wait_tick(Duration::from_millis(20));
        }
        assert_eq!(actual,"Memory-only vision ✓");
        super::super::local_status(true,None);
        let duplicate=super::super::execute_step(&lease,&step,"fixture-type",&raw).expect("idempotent receipt");
        assert_eq!(duplicate["already_executed"],true);assert_eq!(duplicate["replayed"],false);
        let frame=super::super::record_frame(&lease).expect("real in-memory window capture");
        let bytes=base64::engine::general_purpose::STANDARD.decode(frame["base64"].as_str().unwrap()).unwrap();
        let decoded=image::load_from_memory(&bytes).expect("native PNG/JPEG decodes");
        assert!(decoded.width()>100&&decoded.height()>100);
        let rgb=decoded.to_rgb8();
        assert!(rgb.pixels().any(|p|p.0.iter().all(|v|*v>200)),"real Edit background is present");
        assert!(rgb.pixels().any(|p|p.0.iter().any(|v|*v<80)),"frame is not blank white");
        assert_eq!(frame["persisted"],false);assert_eq!(frame["capture_storage"],"memory_only");
        let local=super::super::local_status(true,None);
        assert_eq!(local["agent_frame"]["base64"],frame["base64"]);
        let envelope=crate::tools::workspace::wrap_mcp_tool_result("computer_snapshot",&json!({}),frame.clone());
        assert_eq!(envelope["content"][0]["type"],"image");assert!(envelope["structuredContent"].get("base64").is_none());
        let mut failure_frame=frame;failure_frame["ok"]=json!(false);
        let failure=crate::tools::workspace::wrap_mcp_tool_result("computer_action",&json!({}),failure_frame);
        assert_eq!(failure["isError"],true);assert_eq!(failure["content"][0]["type"],"image");assert!(failure["structuredContent"].get("base64").is_none());
        super::super::pause();assert!(super::super::check_same_lease(&lease,true).is_err());
        super::super::emergency_stop("Fixture stop check");assert!(super::super::state().lease.is_none());
        println!("PASS: UIA find → real click → Unicode SendInput → actual Edit verification → RAM capture → identical local/MCP pixels → retry not replayed → Pause/Stop");
    }
}
