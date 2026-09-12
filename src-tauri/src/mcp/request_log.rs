//! Best-effort MCP diagnostic traces, not the authoritative operation store.
//! One bounded, dedicated writer prevents slow disks from blocking the async
//! executor or a tool worker. Full/failed queues are counted, never retried on
//! the request thread. No credentials or tool result bodies are added here.
use serde_json::{json, Value};
use std::sync::{
    atomic::{AtomicU64, AtomicUsize, Ordering},
    mpsc::{sync_channel, SyncSender},
    Arc, OnceLock,
};

const CAPACITY: usize = 256;
const LINE_BYTES: usize = 4096;
const PROFILE_BYTES: usize = 1024;
const FILE_BYTES: usize = 64;

#[derive(Default)]
struct Counters {
    pending: AtomicUsize,
    accepted: AtomicU64,
    processed: AtomicU64,
    dropped: AtomicU64,
    truncated: AtomicU64,
    sink_panics: AtomicU64,
}
struct Entry { profile: String, file: String, line: String }
struct TraceQueue { sender: Option<SyncSender<Entry>>, counters: Arc<Counters> }

fn bounded_line(value: &str) -> (String, bool) {
    let truncated = value.len() > LINE_BYTES;
    let mut end = value.len().min(if truncated { LINE_BYTES - 20 } else { LINE_BYTES });
    while !value.is_char_boundary(end) { end -= 1; }
    // Escape controls without ever exceeding the retained byte cap. Preserve
    // the usual escaped JSON request IDs; don't interpret anything as markup.
    let mut line = String::with_capacity(LINE_BYTES.min(value.len().saturating_add(20)));
    let mut shortened = truncated;
    for c in value[..end].chars() {
        let replacement = match c { '\n' => Some("\\n"), '\r' => Some("\\r"), '\0' => Some("\\0"), _ => None };
        let n = replacement.map(str::len).unwrap_or(c.len_utf8());
        if line.len() + n > LINE_BYTES - 20 { shortened = true; break; }
        if let Some(text) = replacement { line.push_str(text); } else { line.push(c); }
    }
    if shortened { line.push_str(" [trace shortened]"); }
    (line, shortened)
}
impl TraceQueue {
    fn new(capacity: usize, mut sink: impl FnMut(&str,&str,&str) + Send + 'static) -> Self {
        let (sender, receiver) = sync_channel::<Entry>(capacity);
        let counters = Arc::new(Counters::default());
        let worker = counters.clone();
        let spawned = std::thread::Builder::new().name("mcp-trace-writer".into()).spawn(move || {
            while let Ok(entry) = receiver.recv() {
                // Diagnostic failure must never kill a request or trigger replay.
                if std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| sink(&entry.profile,&entry.file,&entry.line))).is_err() {
                    worker.sink_panics.fetch_add(1, Ordering::Relaxed);
                }
                // The existing sink is best effort: processed is NOT a durability
                // acknowledgement, and an OS write failure may still omit a line.
                worker.processed.fetch_add(1, Ordering::Relaxed);
                worker.pending.fetch_sub(1, Ordering::Relaxed);
            }
        });
        Self { sender: spawned.ok().map(|_|sender), counters }
    }
    fn append(&self, profile:&str, file:&str, value:&str) {
        // Reject oversized destination identifiers rather than truncating a
        // destination into a different workspace or log file.
        if profile.len()>PROFILE_BYTES || file.len()>FILE_BYTES {
            self.counters.dropped.fetch_add(1,Ordering::Relaxed); return;
        }
        let Some(sender)=self.sender.as_ref() else { self.counters.dropped.fetch_add(1,Ordering::Relaxed);return; };
        let (line,truncated)=bounded_line(value);
        if truncated { self.counters.truncated.fetch_add(1,Ordering::Relaxed); }
        self.counters.pending.fetch_add(1,Ordering::Relaxed);
        if sender.try_send(Entry{profile:profile.into(),file:file.into(),line}).is_ok() {
            self.counters.accepted.fetch_add(1,Ordering::Relaxed);
        } else {
            self.counters.pending.fetch_sub(1,Ordering::Relaxed);
            self.counters.dropped.fetch_add(1,Ordering::Relaxed);
        }
    }
    fn status(&self)->Value {
        json!({"writer_available":self.sender.is_some(),"queue_capacity":CAPACITY,
            "pending":self.counters.pending.load(Ordering::Relaxed),
            "accepted":self.counters.accepted.load(Ordering::Relaxed),
            "processed":self.counters.processed.load(Ordering::Relaxed),
            "dropped":self.counters.dropped.load(Ordering::Relaxed),
            "truncated":self.counters.truncated.load(Ordering::Relaxed),
            "sink_panics":self.counters.sink_panics.load(Ordering::Relaxed),
            "max_line_bytes":LINE_BYTES,"durable":false,
            "scope":"process-wide diagnostic traces; not task completion or an OS load measurement"})
    }
}
static TRACE:OnceLock<TraceQueue>=OnceLock::new();

pub(crate) fn append_profile_log(profile:&str,file:&str,line:&str) {
    TRACE.get_or_init(||TraceQueue::new(CAPACITY,crate::tunnel::append_profile_log)).append(profile,file,line);
}
/// Called by the main-window task monitor only. Observation does not start a writer.
pub(crate) fn status()->Value {
    TRACE.get().map(TraceQueue::status).unwrap_or_else(||json!({"writer_available":false,"state":"not_started","pending":0,"dropped":0,"durable":false}))
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::{sync::{mpsc,Mutex},time::Duration};
    #[test]
    fn resilience_trace_queue_bounds_order_and_failure_are_visible() {
        let (began,started)=mpsc::sync_channel(1);let (resume,gate)=mpsc::sync_channel(1);
        let seen=Arc::new(Mutex::new(Vec::<String>::new()));let output=seen.clone();
        let mut first=true;
        let q=TraceQueue::new(2,move |_,_,line| {
            if first { first=false;began.send(()).unwrap();gate.recv_timeout(Duration::from_secs(3)).unwrap(); }
            output.lock().unwrap().push(line.to_string());
        });
        q.append("profile","trace.log","first");started.recv_timeout(Duration::from_secs(2)).unwrap();
        q.append("profile","trace.log","second");q.append("profile","trace.log","third");
        for _ in 0..1000 {q.append("profile","trace.log","overflow");}
        assert_eq!(q.counters.pending.load(Ordering::Relaxed),3);
        assert_eq!(q.counters.dropped.load(Ordering::Relaxed),1000);
        resume.send(()).unwrap();
        let until=std::time::Instant::now()+Duration::from_secs(3);
        while q.counters.pending.load(Ordering::Relaxed)>0&&std::time::Instant::now()<until {std::thread::sleep(Duration::from_millis(2));}
        assert_eq!(*seen.lock().unwrap(),vec!["first","second","third"]);
        assert_eq!(q.counters.processed.load(Ordering::Relaxed),3);
        let (line,shortened)=bounded_line(&"施工\n".repeat(2000));
        assert!(shortened&&line.len()<=LINE_BYTES&&!line.contains('\n'));
        let q=TraceQueue::new(1,|_,_,_|panic!("synthetic sink failure"));q.append("p","f","safe");
        let until=std::time::Instant::now()+Duration::from_secs(2);
        while q.counters.pending.load(Ordering::Relaxed)>0&&std::time::Instant::now()<until {std::thread::sleep(Duration::from_millis(2));}
        assert_eq!(q.counters.sink_panics.load(Ordering::Relaxed),1);
        assert_eq!(q.status()["durable"],false);
        println!("TRACE_QUEUE_PASS: stalled sink cannot grow queue, reorder accepted lines or silently hide overflow; no disk files or tool calls used");
    }
}
