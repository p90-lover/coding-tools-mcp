//! Probe OS access without ever removing or overwriting an existing file.
use std::{env, fs::{self,OpenOptions}, net::{SocketAddr,TcpStream}, time::Duration};
fn main() {
    let a:Vec<String>=env::args().collect();
    if a.get(1).map(String::as_str)==Some("sleep") {
        std::thread::sleep(Duration::from_secs(20));return;
    }
    assert_eq!(a.len(),6);
    let root=std::path::Path::new(&a[1]);let outside=std::path::Path::new(&a[2]);
    let addr:SocketAddr=a[3].parse().unwrap();let suffix=&a[4];let expected=&a[5];
    let read=fs::read_to_string(root.join("sentinel.txt")).map(|v|v==*expected).unwrap_or(false);
    let outside_read=fs::read_to_string(outside.join("sentinel.txt")).map(|v|v==*expected).unwrap_or(false);
    let overwrite_access=OpenOptions::new().write(true).open(root.join("sentinel.txt")).is_ok();
    let create=OpenOptions::new().write(true).create_new(true).open(root.join(format!("probe-{suffix}"))).is_ok();
    let outside_create=OpenOptions::new().write(true).create_new(true).open(outside.join(format!("probe-{suffix}"))).is_ok();
    let network=TcpStream::connect_timeout(&addr,Duration::from_millis(800)).is_ok();
    #[cfg(windows)]
    let delete_access={use std::os::windows::fs::OpenOptionsExt;
        OpenOptions::new().access_mode(0x00010000).open(root.join("sentinel.txt")).is_ok()};
    #[cfg(not(windows))]
    let delete_access=false;
    println!("{{\"read\":{read},\"outside_read\":{outside_read},\"overwrite_access\":{overwrite_access},\"create\":{create},\"outside_create\":{outside_create},\"network\":{network},\"delete_access\":{delete_access}}}");
}
