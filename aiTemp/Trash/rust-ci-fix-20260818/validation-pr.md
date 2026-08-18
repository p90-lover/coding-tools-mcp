# Rust port validation

This temporary marker opens the same-repository validation pull request. The workflow runs the idempotent Rust patcher in each operating-system job, executes the complete Rust test and Clippy suites, then commits the verified Rust source without deleting files.
