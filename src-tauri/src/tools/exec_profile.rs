//! Ordinary command timing. No execution modes and no implicit process deadline.
//! These options never authorize filesystem, network or process access.
use serde_json::Value;

#[derive(Debug)]
pub struct ExecutionProfile {
    pub timeout_ms: Option<u64>,
    pub yield_time_ms: u64,
}

pub fn resolve(args: &Value) -> Result<ExecutionProfile, String> {
    if args.get("execution_profile").is_some() {
        return Err("execution_profile is no longer used. Ordinary commands have no automatic deadline; omit timeout_ms or pass null/0.".into());
    }
    let timeout_ms = match args.get("timeout_ms") {
        None | Some(Value::Null) => None,
        Some(value) => match value
            .as_u64()
            .ok_or("timeout_ms must be null or a nonnegative integer")?
        {
            0 => None,
            milliseconds => Some(milliseconds),
        },
    };
    let requested_yield = match args.get("yield_time_ms") {
        None => 1000,
        Some(value) => value
            .as_u64()
            .filter(|v| *v <= 30_000)
            .ok_or("yield_time_ms must be an integer from 0 to 30000")?,
    };
    Ok(ExecutionProfile {
        timeout_ms,
        yield_time_ms: requested_yield,
    })
}
