# 子规格：Rich response capture and transport

## 范围

Capture content references from the current assistant message before Markdown cleanup and carry them through the browser helper without delaying text.

## 需求回链

- FR-1
- FR-2
- FR-6

## 验收标准（EARS）

1. WHEN an owned response contains media, downloads, a chart or a preview THEN the system SHALL retain typed references and the owned conversation source.
2. WHEN Markdown cleanup removes controls or chart scaffolding THEN the system SHALL preserve ordinary text formatting and the separate rich references.
3. WHEN the helper returns a rich-output event THEN the client SHALL validate and forward it without corrupting text/progress or terminal ordering.
4. WHEN a reply is plain text or a reference repeats across snapshots THEN the system SHALL avoid extra or duplicate presentation.

## 涉及文件

Browser worker, rich-output utility, browser-helper-main, launcher-helper-client and turn execution; matching runtime tests.

## 不做项

No private reasoning extraction, arbitrary captured HTML execution, cookie copying or vendor snapshot edits.

## 设计要点

Use current response ownership and existing helper limits. Transient or protected content remains accessible through the owned source view rather than an invalid cross-host URI.
