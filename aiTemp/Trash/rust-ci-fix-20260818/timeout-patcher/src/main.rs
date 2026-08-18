use std::error::Error;
use std::fs;
use std::path::Path;

fn main() -> Result<(), Box<dyn Error>> {
    let path = Path::new("src-tauri/src/tools/exec.rs");
    let original = fs::read_to_string(path)?;
    let used_crlf = original.contains("\r\n");
    let mut content = original.replace("\r\n", "\n");

    let before = r#"            &json!({ "cmd": command, "timeout_ms": 10_000, "yield_time_ms": 10_000 }),"#;
    let after = r#"            // Cold PowerShell startup on hosted Windows runners can exceed ten seconds.
            &json!({ "cmd": command, "timeout_ms": 30_000, "yield_time_ms": 30_000 }),"#;

    match (content.matches(before).count(), content.matches(after).count()) {
        (1, _) => {
            content = content.replacen(before, after, 1);
            println!("applied focused Windows cold-start test timeout fix");
        }
        (0, 1) => println!("focused Windows cold-start test timeout fix already applied"),
        (before_count, after_count) => {
            return Err(format!(
                "unexpected exec.rs state: before matches={before_count}, after matches={after_count}"
            )
            .into());
        }
    }

    let output = if used_crlf {
        content.replace('\n', "\r\n")
    } else {
        content
    };
    if output != original {
        fs::write(path, output)?;
    }
    Ok(())
}
