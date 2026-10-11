// The prompts behind Codex's slash commands, as the chat sends them. /init is Codex's own prompt
// (codex-rs, prompt_for_init_command.md); /review and plan mode keep the substance of Codex's
// review guidelines and Plan Mode rules, shortened because a chat's text is capped at 8,192
// characters and asks for readable Markdown instead of the review tool's JSON.

export const INIT_PROMPT = `Generate a file named AGENTS.md that serves as a contributor guide for this repository.
Before writing, check whether AGENTS.md already exists in the current working directory. If it does, do not overwrite or modify it.
Your goal is to produce a clear, concise, and well-structured document with descriptive headings and actionable explanations for each section.
Follow the outline below, but adapt as needed — add sections if relevant, and omit those that do not apply to this project.

Document Requirements

- Title the document "Repository Guidelines".
- Use Markdown headings (#, ##, etc.) for structure.
- Keep the document concise. 200-400 words is optimal.
- Keep explanations short, direct, and specific to this repository.
- Provide examples where helpful (commands, directory paths, naming patterns).
- Maintain a professional, instructional tone.

Recommended Sections

Project Structure & Module Organization

- Outline the project structure, including where the source code, tests, and assets are located.

Build, Test, and Development Commands

- List key commands for building, testing, and running locally (e.g., npm test, make build).
- Briefly explain what each command does.

Coding Style & Naming Conventions

- Specify indentation rules, language-specific style preferences, and naming patterns.
- Include any formatting or linting tools used.

Testing Guidelines

- Identify testing frameworks and coverage requirements.
- State test naming conventions and how to run tests.

Commit & Pull Request Guidelines

- Summarize commit message conventions found in the project’s Git history.
- Outline pull request requirements (descriptions, linked issues, screenshots, etc.).

(Optional) Add other sections if relevant, such as Security & Configuration Tips, Architecture Overview, or Agent-Specific Instructions.`;

/** /review [focus]: Codex's uncommitted-changes review, its reviewer guidelines kept to their core. */
export function reviewPrompt(focus = ""): string {
  return [
    "Review the current code changes (staged, unstaged, and untracked files). Do not change any files.",
    focus ? `Focus: ${focus}` : "",
    "",
    "Flag an issue only when it meaningfully affects accuracy, performance, security or maintainability; is discrete and actionable; was introduced by these changes; does not rest on unstated assumptions; and the author would fix it if told. Proving another part of the code is affected is required, speculation is not. Ignore style and nits unless they hide meaning or break documented project rules (AGENTS.md and similar files apply).",
    "",
    "For each finding: a title starting with its priority — [P0] blocking, [P1] urgent, [P2] normal, [P3] low — then one matter-of-fact paragraph saying why it is a bug, when it happens and how severe it is, with the file and the shortest line range. Keep code quotes to 3 lines. List every finding the author would want, not just the first; if none qualify, say so.",
    "",
    "End with an overall verdict: \"patch is correct\" or \"patch is incorrect\", with a one to three sentence explanation.",
  ].filter((line, index, all) => line || all[index - 1]).join("\n");
}

/** Plan mode (Codex's collaboration mode): explore and plan, never change anything. */
export const PLAN_PREFIX = `[Plan mode] Do not change anything: no file edits, formatters that rewrite files, patches, migrations or other mutating commands. You may read, search and run non-mutating checks to ground the plan. Ask only what you can't discover. Reply with a decision-complete plan another engineer could implement without making decisions — goal, approach, the exact files and changes, tests, risks and open questions — and wait for approval before implementing.

Request:
`;

/** A message sent while plan mode is on asks for a plan instead of the change itself. */
export function planMessage(message: string): string {
  return PLAN_PREFIX + message;
}
