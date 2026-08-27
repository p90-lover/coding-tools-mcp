# Security hardening materialization

This directory contains only deterministic hardening applicators and verification evidence. Every applicator must back up modified files under `aiTemp/Trash/`, reject path traversal and symlinks, refuse source deletions, and pass full Rust/frontend gates before committing materialized source.
