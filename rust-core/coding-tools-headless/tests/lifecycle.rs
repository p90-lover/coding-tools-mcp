use coding_tools_headless::Lifecycle;
use std::time::Duration;

#[tokio::test]
async fn drains_without_replaying_or_killing_owned_work() {
    let lifecycle = Lifecycle::new(2);
    let first = lifecycle
        .admit("fixture-read")
        .expect("first request admitted");
    let second = lifecycle
        .admit("fixture-command")
        .expect("second request admitted");
    assert_eq!(lifecycle.snapshot().active_requests, 2);
    assert!(lifecycle.admit("overflow").is_err());

    lifecycle.drain("fixture-upgrade").expect("drain begins");
    let draining = lifecycle.snapshot();
    assert!(!draining.accepting);
    assert_eq!(draining.active_requests, 2);
    assert_eq!(draining.drain_reason.as_deref(), Some("fixture-upgrade"));
    assert!(lifecycle.admit("new-work").is_err());

    drop(first);
    assert!(!lifecycle.wait_idle(Duration::from_millis(20)).await);
    drop(second);
    assert!(lifecycle.wait_idle(Duration::from_secs(1)).await);

    lifecycle.resume().expect("explicit resume");
    assert!(lifecycle.snapshot().accepting);
    let resumed = lifecycle
        .admit("resumed-read")
        .expect("work admitted after resume");
    drop(resumed);
    assert_eq!(lifecycle.snapshot().active_requests, 0);
}
