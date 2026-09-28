use std::error::Error;
use std::fs;
use std::path::Path;

fn main() -> Result<(), Box<dyn Error>> {
    let path = Path::new("src-tauri/src/tools/exec.rs");
    let original = fs::read_to_string(path)?;
    let used_crlf = original.contains("\r\n");
    let mut content = original.replace("\r\n", "\n");

    let function_start =
        "    fn windows_workspace_scripts_and_python_unicode_execute_successfully() {";
    let next_test = "\n    #[cfg(windows)]\n    #[test]\n    fn windows_batch_scripts_preserve_space_paths_and_arguments() {";
    let start = content
        .find(function_start)
        .ok_or("Windows workspace-script integration test was not found")?;
    let end = start
        + content[start..]
            .find(next_test)
            .ok_or("end of Windows workspace-script integration test was not found")?;

    let before = r#"            &json!({ "cmd": command, "timeout_ms": 10_000, "yield_time_ms": 10_000 }),"#;
    let after = r#"            // Cold PowerShell startup on hosted Windows runners can exceed ten seconds.
            &json!({ "cmd": command, "timeout_ms": 30_000, "yield_time_ms": 30_000 }),"#;
    let section = &content[start..end];

    match (section.matches(before).count(), section.matches(after).count()) {
        (1, _) => {
            let updated = section.replacen(before, after, 1);
            content.replace_range(start..end, &updated);
            println!("applied focused Windows cold-start test timeout fix");
        }
        (0, 1) => println!("focused Windows cold-start test timeout fix already applied"),
        (before_count, after_count) => {
            return Err(format!(
                "unexpected target test state: before matches={before_count}, after matches={after_count}"
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
