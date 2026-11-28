"use strict";
// The SSH commands an agent types in a shell tool, judged before they run.
//
// The user asked for SSH support with this scope (2026-11-26): "a list of SSH hosts the user
// approves, an in-app SSH terminal for them, and agents may run ssh/scp only to approved hosts,
// under review; key files, tunnels and ProxyCommand stay blocked."
//
// So every ssh-family segment of a command line (ssh, scp, sftp, rsync over ssh, ssh-keygen,
// ssh-keyscan, ssh-add, and the Git settings that choose the ssh program) is read from its parsed
// arguments, whatever the program is called (ssh, ssh.exe, a full path, behind PowerShell's `&`,
// behind an environment prefix), and put in one of four classes:
//
//   blocked  a hard rule, on any host: options that run a local program or load a library, another
//            config file, tunnels and forwarding, weaker host-key checks, a malformed destination,
//            scp's unsafe modes, writes to the SSH trust files, and a remote command the existing
//            hard rules refuse.
//   person   no model may allow it: a destination that is not an approved host, an interactive
//            session, an option outside the short allow-list, a key file, anything the parser
//            cannot read, a risky remote command, and every command on a production host.
//   review   the model reviewer judges it, told the approved host and the exact remote command.
//   allow    `ssh -V` and `ssh-add -l` only.
//
// Approved hosts come only from the caller (the app's SSH hosts store). Nothing an agent writes,
// and nothing a remote host prints, adds one.
//
// The words come from the command approver's own shell reader (commandLines, shellSegments and
// QUOTED in agent-orchestrator-workflow.cjs), handed in as `shell`, so there is one tokenizer and
// the hard rules and these rules read a command line the same way. That reader and the real shells
// disagree in places (review 2026-11-27): Git Bash drops a backslash before any character, takes
// \" outside quotes as a plain quote and expands {a,b}, $'...' and ${IFS}; PowerShell ends "..." at
// \" and splits words at U+0085. So the line is also read as each of those shells reads it,
// written back in the reader's own dialect, and the strictest verdict stands.
const path = require("node:path");
// What ssh_exec takes as a remote command: one rule, kept with the command line it ends up in.
const { execCommandProblem } = require("./ssh-connections.cjs");

const RANK ={ allow: 0, review: 1, person: 2, blocked: 3 };
const names = (list) => new Set(list.split(" ").filter(Boolean));
const FAMILY = names("ssh scp sftp rsync ssh-keygen ssh-keyscan ssh-add");
// Other SSH clients and helpers: their options are not read here, so only the person may approve
// them. KiTTY's klink and kitty, WinSCP, Bitvise's stermc, sftpc and sexec, and sshuttle (a VPN
// that starts ssh itself) were missing (review 2026-11-27).
const OTHER_CLIENTS = names("slogin ssh-agent ssh-copy-id ssh-import-id sshpass autossh sshfs mosh plink pscp psftp putty dbclient "
  + "klink kitty kitty_portable winscp stermc sftpc sexec sshuttle");
const isClient = (name) => FAMILY.has(name) || OTHER_CLIENTS.has(name);
// PowerShell 7 remoting: with -HostName (or -SSHTransport, -SSHConnection) it starts ssh itself.
const POWERSHELL_REMOTING = names("invoke-command icm enter-pssession etsn new-pssession nsn");
// Programs that reach a host over SSH when they are given an sftp:// or scp:// address.
const URL_CLIENTS = names("curl wget lftp rclone aria2c");
const SSH_URL = /(?:^|[^A-Za-z0-9+.-])(?:sftp|scp|fish):\/\/|^:sftp[,:]|^--sftp-/i;
// What defines an alias: `Set-Alias s ssh`, `alias s='ssh -NL ...'`, `doskey s=ssh $*`.
const ALIAS_DEFINERS = names("set-alias new-alias sal nal alias doskey");

// A command that names none of these has no ssh-family segment: most commands stop here. Read too
// with its quotes, escapes and empty expansions taken off, as a shell joins s\sh, s''sh, s^sh and
// s${UNSET}sh into ssh (and PowerShell 's'+'sh'), and with a wildcard read as the names it could
// match (/usr/bin/ss?).
const NAMES = /ssh|scp|sftp|rsync|known_hosts|authorized_keys|plink|putty|dbclient|mosh|-hostname|klink|kitty|lftp|rclone|stermc|sexec/i;
const squeezed = (command) => command.replace(/["'][ \t]*\+[ \t]*["']/g, "").replace(/\$\{\w*\}|\$(?=["'])|[\\^"'\x60]/g, "");
const mentionsSsh = (command) => typeof command === "string" && (NAMES.test(command) || NAMES.test(squeezed(command)) || globbedClient(command));
// An SSH program named as a word anywhere in a request: `$s = 'ssh'`, `Get-Command ssh.exe`.
const CLIENT_TOKEN = new RegExp(String.raw`(?<![\w.-])(?:${[...FAMILY, ...OTHER_CLIENTS].sort((a, b) => b.length - a.length).join("|")})(?:\.exe|\.com)?(?![\w.-])`, "i");

// Why a hard rule blocks, as it reads after "Blocked by the safety rules: ".
const BLOCKED_WHY = {
  program: "SSH options that run a local program or load a library are never allowed for agents",
  forwarding: "SSH tunnels, forwarding and shared connections are never allowed for agents",
  config: "SSH may not be pointed at another config file",
  hostkey: "SSH host-key checking may not be switched off or pointed at another file",
  keyscan: "ssh-keyscan output may not be saved to a file: nobody has compared those host keys",
  destination: "The SSH destination is not a plain host name",
  transfer: "This scp transfer mode is never allowed for agents",
  trust: "Agents may not write SSH trust files (known_hosts, authorized_keys, an ssh config or the app's SSH hosts list)",
  env: "Agents may not change the program or library that Git, SSH or rsync runs",
};
const SSH_TRUST_WHY = BLOCKED_WHY.trust;

const clip = (text, limit = 60) => String(text ?? "").replace(/\s+/g, " ").trim().slice(0, limit);
/** One segment's verdict. `why` is a plain sentence for the person; `rule` names the rule for tests and logs. */
function finding(status, rule, why, extra = {}) {
  return { status, rule, why, match: "", host: null, port: null, user: null, approved: null, production: false, remote: "", kind: "ssh",
    notes: [], ...extra };
}
const blockedFinding = (rule, match, extra = {}) => finding("blocked", rule, `${BLOCKED_WHY[rule]}.`, { ...extra, match: clip(match) });

/**
 * A word as a program name: /usr/bin/ssh and C:\Windows\System32\OpenSSH\ssh.exe read ssh. Windows
 * drops trailing dots and spaces from a file name, so `ssh.` and `ssh.exe.` are ssh too.
 */
const programName = (word) => String(word).replace(/^.*[\\/]/, "").replace(/(?<=[^.\s])[.\s]+$/, "").replace(/\.(?:exe|com|cmd|bat)$/i, "").toLowerCase();
// The ssh programs a machine is known to ship: a bare name (found on PATH) or one of these folders.
// Any other path may be any program that calls itself ssh.
const KNOWN_PROGRAM = /^(?:[a-z]:[\\/]windows[\\/]system32[\\/]openssh[\\/]|[a-z]:[\\/]program files[\\/](?:git[\\/]usr[\\/]bin|openssh)[\\/]|\/usr\/bin\/|\/bin\/|\/usr\/local\/bin\/|\/opt\/homebrew\/bin\/)?[a-z-]+(?:\.exe)?$/i;

/** The SSH programs a wildcard word could name: `/usr/bin/ss?` and `s*h.exe` run ssh. */
function globClients(word) {
  const name = programName(word);
  // A wildcard with no letter of its own (`dist/*`, `*.exe`) names no program in particular.
  if (!/[*?[]/.test(name) || !/[a-z0-9]/.test(name.replace(/\[[^\]]*\]|[*?]/g, ""))) return [];
  let source = "";
  for (let at = 0; at < name.length; at += 1) {
    const char = name[at];
    const close = char === "[" ? name.indexOf("]", at + 2) : -1;
    if (char === "*") source += "[^\\\\/]*";
    else if (char === "?") source += "[^\\\\/]";
    else if (close > 0) {
      source += `[${name.slice(at + 1, close).replace(/^!/, "^").replace(/\\/g, "\\\\")}]`;
      at = close;
    } else source += char.replace(/[.*+?^${}()|[\]\\-]/g, "\\$&");
  }
  let pattern;
  try { pattern = new RegExp(`^${source}(?:\\.exe)?$`, "i"); } catch { return [...FAMILY]; }
  return [...FAMILY, ...OTHER_CLIENTS].filter((client) => pattern.test(client));
}
function globbedClient(command) {
  // Split, not matched: a pattern scan backtracked over a long word (100 KB took 9 s).
  return /[*?[]/.test(command) && command.split(/[\s;&|()"'<>=,]+/).some((word) => /[*?[]/.test(word) && globClients(word).length > 0);
}

// Programs that run another program: what follows their own options is the command. The value is
// the options that take a value of their own.
const WRAPPERS = new Map(Object.entries({
  sudo: "-u -g -h -p -C -D -R -T -U --user --group --host --prompt --chdir", doas: "-u -C", env: "-u -C --unset --chdir",
  command: "", exec: "-a", nohup: "", time: "-o -f", builtin: "", timeout: "-k -s --kill-after --signal", nice: "-n --adjustment",
  ionice: "-c -n -p", stdbuf: "-i -o -e", setsid: "", winpty: "", xargs: "-I -n -P -L -d -E -s -a", call: "", start: "/d",
  // wsl's --shell-type and --distribution-id take a value too (wsl --help on the target machine, 2026-11-27).
  runas: "", wsl: "-d -u --distribution --user --cd --shell-type --distribution-id", busybox: "", cmd: "",
  powershell: "-executionpolicy -ep -ex -windowstyle",
  pwsh: "-executionpolicy -ep -ex -windowstyle", bash: "", sh: "", zsh: "", dash: "", ksh: "", eval: "", iex: "", "invoke-expression": "",
  "start-process": "", saps: "",
  // PowerShell's dot-source runs the command after it: `. ssh -NL ...` is ssh.
  ".": "",
  // Less common ones an agent could reach for: a lock, a repeat, another network route, a tracer.
  watch: "-n -d --interval --differences", flock: "-w -E --timeout --conflict-exit-code", taskset: "", chroot: "--userspec --groups",
  proxychains: "-f", proxychains4: "-f", torsocks: "-a -P -u -p", torify: "", unbuffer: "", caffeinate: "-t -w", chronic: "",
  strace: "-o -e -p -s -u -a", ltrace: "-o -e -p -s -u -a", fakeroot: "", firejail: "", "systemd-run": "-p -u --unit --property --uid",
  gsudo: "-u --user --integrity", pkexec: "--user", parallel: "-j --jobs", su: "-s -g -G --shell --group", runuser: "-u -s -g -G --user --shell --group",
  script: "-I -O -B -T -E -o -m --log-in --log-out --log-io --log-timing --echo --output-limit --logging-format",
}).map(([name, values]) => [name, names(values)]));
// Wrappers whose one quoted argument is a script of its own (`runas /user:x "ssh ..."` too).
const SCRIPT_RUNNERS = names("eval iex invoke-expression bash sh zsh dash ksh cmd powershell pwsh wsl watch parallel runas");
// Wrappers that name the script they run after -c (su -c "...", script -qc "...").
const SCRIPT_OPTION = names("su runuser script");
// Wrappers that take one argument of their own before the command: a lock file, a CPU mask, a new root.
const LEADING_ARGUMENT = names("flock taskset chroot");
const SLASH_SWITCHES = names("cmd start runas");
const KEYWORDS = names("if then else elif elseif do while until try catch finally !");
// What PowerShell keeps a command's output in: `$out = ssh host uptime`, `[string]$out = & ssh ...`.
const KEPT_IN = /^(?:\[[\w.[\],]+\])?\$(?:\{[^}]+\}|[\w:]+)(?:\.\w+|\[[^\]]*\])*$/;
// A program word that is a variable, an expression's value or a splat: what it runs is not on the
// command line (`& $s`, `!S!` in cmd, `s${UNSET}sh`, PowerShell's `"s`sh"`, `Start-Process @p`).
// A hashtable or an array (@{...}, @(...)) is a value, not a program.
const INDIRECT = /^(?:\$|@(?![{(])|%[^%\s]+%|![^!\s]+!)|\$\{|\$\(|\x60/;
// What follows a value that is compared or assigned, not called: `if ($x -eq 1)`, `$a += 1`.
const EXPRESSION_OPERATOR = /^(?:-(?:c|i)?(?:eq|ne|gt|ge|lt|le|like|notlike|match|notmatch|contains|notcontains|in|notin|replace|split)|-(?:is|isnot|as|and|or|xor|not|band|bor|bxor|join|f)|[-+*/%]?=|\.\.)$/i;

/**
 * Where a segment's program is, past environment assignments, shell keywords and wrappers:
 * { at, name, word, wrapped, kept, odd, assigns, via } (`kept`: PowerShell assigns its output to a
 * variable; `via`: the wrappers passed), { script } when a wrapper is handed a quoted script, or
 * null for a segment with no program.
 */
function locate(words) {
  let at = 0, wrapped = false, kept = false;
  const assigns = [], via = [];
  while (at < words.length) {
    let word = words[at];
    if (word === "" || /^[{}]+$/.test(word) || KEYWORDS.has(word.toLowerCase())) { wrapped = wrapped || word !== ""; at += 1; continue; }
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word)) { assigns.push(word); at += 1; continue; }
    // PowerShell's `$out = ssh host uptime` runs ssh all the same; `$out=ssh` glues the two.
    if (KEPT_IN.test(word) && /^[-+*/%]?=$/.test(words[at + 1] ?? "")) { kept = true; at += 2; continue; }
    const glued = /^(?:\[[\w.[\],]+\])?\$[\w:]+[-+]?=(.+)$/.exec(word);
    if (glued) { kept = true; word = glued[1]; }
    const name = programName(word);
    const known = isClient(name);
    // `s\sh` is ssh to a POSIX shell and `s^sh` to cmd: read too with those escapes taken off.
    const bare = programName(word.replace(/\\(?=[\w-])|\^/g, ""));
    if (!known && isClient(bare)) return { at, name: bare, word, wrapped, kept, odd: true, assigns, via };
    // A wildcard where the program is: PowerShell runs `& C:\Windows\System32\OpenSSH\s*h.exe`.
    const globbed = known ? [] : globClients(word);
    if (globbed.length) return { at, name: globbed[0], word, wrapped, kept, odd: true, assigns, via, globbed };
    const values = WRAPPERS.get(name);
    if (known || !values) {
      // `find . -exec ssh host {} \;` runs what follows -exec.
      const exec = known || !/^(?:find|fd|fdfind)$/.test(name) ? -1
        : words.findIndex((next, index) => index > at && /^(?:-exec|-execdir|-ok|-okdir|-x|--exec|-X|--exec-batch)$/.test(next));
      if (exec < 0) return { at, name, word, wrapped, kept, odd: false, assigns, via };
      wrapped = true;
      at = exec + 1;
      continue;
    }
    wrapped = true;
    via.push(name);
    at += 1;
    // `command -v ssh-keygen` only prints where the program is: it runs nothing.
    if ((name === "command" || name === "builtin") && /^-[A-Za-z]*[vV]/.test(words[at] ?? "")) return null;
    if (SCRIPT_OPTION.has(name)) {
      const option = words.findIndex((next, index) => index >= at && /^(?:-[A-Za-z]*c|--command|--session-command)$/.test(next));
      if (option >= 0 && words[option + 1] !== undefined) return { script: words[option + 1] };
    }
    while (at < words.length) {
      const next = words[at];
      if (next === "--") { at += 1; break; }
      // `env -S 'ssh -NL ...'` splits its value into the command it runs.
      const split = name === "env" ? /^(?:-[iv0]*S|--split-string(?:=|$))([\s\S]*)$/.exec(next) : null;
      if (split) {
        const script = split[1] || words[at + 1];
        return script === undefined ? null : { script };
      }
      if (values.has(next) || values.has(next.toLowerCase())) { at += 2; continue; }
      if (next === "" || /^-/.test(next) || /^\d+(?:\.\d+)?[smhd]?$/.test(next)
        || (SLASH_SWITCHES.has(name) && /^\/[a-z]+(?::\S*)?$/i.test(next))) { at += 1; continue; }
      break;
    }
    // cmd's `start "tunnel" ssh ...`: the first quoted word is the window's title.
    if (name === "start" && at + 1 < words.length && !isClient(programName(words[at])) && !WRAPPERS.has(programName(words[at]))
      && (isClient(programName(words[at + 1])) || WRAPPERS.has(programName(words[at + 1])))) at += 1;
    const leading = programName(words[at] ?? "");
    if (LEADING_ARGUMENT.has(name) && !isClient(leading)) {
      at += 1;
      if (words[at] === "-c" && words[at + 1] !== undefined) return { script: words[at + 1] };
    }
    if (SCRIPT_RUNNERS.has(name) && at < words.length && /\s/.test(words[at])) return { script: words[at] };
    // Start-Process hands the arguments over as its own parameters, not as words to read here.
    if ((name === "start-process" || name === "saps") && at < words.length) {
      const started = programName(words[at]);
      if (isClient(started)) {
        return { at, name: started, word: words[at], wrapped: true, kept, odd: true, assigns, via, opaque: true };
      }
      // `Start-Process @p` or `-FilePath $x`: what it starts is not on the command line.
      if (INDIRECT.test(words[at])) return { at, name: started, word: words[at], wrapped: true, kept, odd: true, assigns, via, indirect: true };
      // Start-Process cmd -ArgumentList '/c ssh ...': the shell it starts is handed a script.
      const handed = SCRIPT_RUNNERS.has(started) ? words.slice(at + 1).find((next) => /\s/.test(next)) : undefined;
      return handed ? { script: handed.replace(/^(?:\s*(?:\/[a-z]|-[a-z]+)(?=\s))+/i, "") } : null;
    }
  }
  return null;
}

/**
 * A segment's words split at the braces of a script block or a shell group, so each block is read
 * as a command of its own: `1..3 | % { ssh host uptime }`, `Invoke-Command -ScriptBlock { ... }`,
 * `f() { ssh host; }`. A word with a space in it was quoted, and `${name}` and xargs' `{}` are no
 * blocks. `state.depth` carries the open blocks across one line's segments.
 */
function blocks(words, state) {
  const parts = [[]];
  for (let word of words) {
    if (/^[{}]+$/.test(word) && word !== "{}") {
      state.depth = Math.max(0, state.depth + (word.includes("{") ? 1 : -1));
      state.braced = true;
      parts.push([]);
      continue;
    }
    // `{ssh host uptime}` with no space after the brace.
    const opened = /^\{+([^\s{}]+)$/.exec(word);
    if (opened && (isClient(programName(opened[1])) || WRAPPERS.has(programName(opened[1])))) {
      state.depth += 1;
      state.braced = true;
      parts.push([]);
      [, word] = opened;
    }
    const closed = state.depth > 0 && /^[^\s{}]+\}+$/.test(word);
    if (closed) word = word.replace(/\}+$/, "");
    parts.at(-1).push(word);
    if (closed) { state.depth -= 1; parts.push([]); }
  }
  return parts.filter((part) => part.length);
}

/** `text` with `change` applied to the stretches outside quoted strings. */
function outsideQuotes(text, QUOTED, change) {
  let out = "", from = 0;
  for (const found of text.matchAll(new RegExp(QUOTED.source, "g"))) {
    out += change(text.slice(from, found.index)) + found[0];
    from = found.index + found[0].length;
  }
  return out + change(text.slice(from));
}
/**
 * `text` without its `#` comments: a "#" that starts a word outside quoted strings, to the end of
 * its line. Git Bash and PowerShell, the two shells an agent's command line runs in, never run
 * one; read as a command, `Get-Content README.md  # (ssh -A ...)` was refused (review 2026-11-27).
 * Where the reader's quotes are not the shell's, that shell's own reading (below) still sees all.
 */
function withoutComments(text, QUOTED) {
  const quoted = new RegExp(QUOTED.source, "y");
  let out = "";
  for (let at = 0; at < text.length;) {
    const char = text[at];
    if (char === "\"" || char === "'") {
      quoted.lastIndex = at;
      const found = quoted.exec(text);
      if (found) { out += found[0]; at += found[0].length; continue; }
    }
    if (char === "#" && (at === 0 || /[\s;|&({]/.test(text[at - 1]))) {
      const stop = text.slice(at).search(/\r?\n/);
      at = stop < 0 ? text.length : at + stop;
      continue;
    }
    out += char;
    at += 1;
  }
  return out;
}

// Where output goes to nothing.
const DISCARDS = /^(?:\/dev\/null|\$null|nul)$/i;
/**
 * A segment's words without its redirects: `> file`, `>> file`, `2> file`, `< file`, `<<TAG`.
 * `outs` and `ins` are the files written and read; output dropped (2>/dev/null, 2>$null) is neither.
 */
function splitRedirects(words) {
  const kept = [], outs = [], ins = [];
  let heredoc = false;
  for (let at = 0; at < words.length; at += 1) {
    const found = /^[0-9*]?(>>?|<{1,3})([\s\S]*)$/.exec(words[at]);
    // A space right after the sign means the whole word was quoted: text (a search pattern
    // ">> known_hosts", a quoted line "> note"), not a redirect.
    if (!found || /^\s/.test(found[2])) { kept.push(words[at]); continue; }
    let target = found[2];
    if (!target) { at += 1; target = words[at] ?? ""; }
    if (found[1].startsWith("<<")) heredoc = true;
    else if (found[1] === "<") ins.push(target);
    else if (!DISCARDS.test(target)) outs.push(target);
  }
  return { words: kept, outs, ins, heredoc };
}

// The files SSH trusts: who a host is (known_hosts), who may log in (authorized_keys), how the
// client and server behave (the user's and the machine's ssh configs), and the app's own approved
// hosts and pinned keys. A backup or temporary name beside one counts (ssh-keygen -R leaves
// known_hosts.old). A project's own file called sshd_config (a container image's) is not one.
// The app's own two files also count with any suffix (the atomic writer's ssh-hosts.json.tmp-<pid>-...,
// the set-aside ssh-hosts.json.unreadable-<stamp>) and by their 8.3 short names (SSH-HO~1.JSO, SSH-KN~1).
const TRUST_NAME = /(?:^|[\\/:])(?:(?:known_hosts2?|ssh_known_hosts2?|authorized_keys2?)(?:\.(?:old|tmp|bak|new|orig|\d+))?|(?:ssh-known-hosts|ssh-hosts\.json)(?:[.-][^\\/]*)?|ssh-(?:ho|kn)~\d+(?:\.[^\\/]*)?)$/i;
const PROGRAM_DATA = String.raw`(?:ProgramData|%ProgramData%|\$env:ProgramData|\$\{env:ProgramData\})`;
const TRUST_PLACE = new RegExp(String.raw`(?:^|[\\/])\.ssh[\\/]config$|(?:^|[\\/])${PROGRAM_DATA}[\\/]ssh[\\/].|^[\\/]etc[\\/]ssh[\\/].`, "i");
const TRUST_FOLDER = new RegExp(String.raw`(?:^|[\\/])${PROGRAM_DATA}[\\/]ssh[\\/]?$|^[\\/]etc[\\/]ssh[\\/]?$`, "i");
const unquoted = (value) => String(value ?? "").trim().replace(/^(["'])([\s\S]*)\1$/, "$2");
/** Whether a path names one of the SSH trust files (never a folder on its own, so a working folder is no match). */
function sshTrustFile(file) {
  const text = unquoted(file);
  return TRUST_NAME.test(text) || TRUST_PLACE.test(text);
}
/** A command's argument that names a trust file, or the folder one lives in (a copy's destination). */
const trustTarget = (value) => {
  const text = unquoted(String(value ?? "").replace(/^-{1,2}[\w-]+[:=](?=.)/, "").replace(/^of=/i, ""));
  return sshTrustFile(text) || TRUST_FOLDER.test(text);
};
// Programs that change the files they are given.
const FILE_WRITERS = names("tee tee-object set-content sc add-content ac out-file clear-content clc move-item mi move mv rename-item rni ren "
  + "rename new-item ni remove-item ri rm del erase rmdir rd unlink touch truncate shred chmod chown chgrp icacls cacls takeown attrib set-acl "
  + "notepad nano vi vim nvim emacs code dd");
// Programs that write only their last argument (or the one after -Destination or -t).
const FILE_COPIERS = names("cp copy copy-item cpi xcopy robocopy install ln mklink");
// Programs that save what is piped into them.
const PIPE_SINKS = names("tee tee-object set-content sc add-content ac out-file");
// icacls and cacls change a file's permissions only with one of these switches; with none they list
// them (a common check of Windows OpenSSH's file permissions).
const ACL_CHANGES = /^\/(?:grant|deny|remove|setowner|reset|inheritance|setintegritylevel|restore|substitute|save|e|g|r|p|d|s)(?::|$)/i;
// A copier's options whose value is a name to leave out or match (or the source), not where it writes.
const COPY_VALUE_OPTIONS = /^(?:-Exclude|-Include|-Filter|-Path|-LiteralPath)$/i;
/** Where a copier writes: -Destination or -t, robocopy's second argument and the files it names, else the last argument. */
function copyTarget(name, args) {
  const positional = [];
  let destination = null;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    if (/^(?:-Destination|-t|--target-directory)$/i.test(word)) { destination = args[at += 1] ?? null; continue; }
    const glued = /^(?:-Destination|--target-directory)[:=]([\s\S]+)$/i.exec(word);
    if (glued) { [, destination] = glued; continue; }
    if (COPY_VALUE_OPTIONS.test(word)) { at += 1; continue; }
    // robocopy's /XF and /XD take the names they leave out, up to the next switch.
    if (name === "robocopy" && /^\/X[FD]$/i.test(word)) { while (args[at + 1] !== undefined && !/^\//.test(args[at + 1])) at += 1; continue; }
    if (/^-/.test(word) || (/^(?:robocopy|xcopy|copy)$/.test(name) && /^\/[A-Za-z]/.test(word) && !/^\/[A-Za-z]:?[\\/]/.test(word) && !word.includes("/", 1))) continue;
    positional.push(word);
  }
  if (name === "robocopy") {
    // robocopy <source> <destination> [<file>...]: the files are written into the destination.
    const [, folder, ...files] = positional;
    return [folder, ...files].find((word) => word !== undefined && trustTarget(word)) ?? null;
  }
  destination ??= positional.at(-1) ?? null;
  return destination && trustTarget(destination) ? destination : null;
}
/** The SSH trust file a segment writes, or null: through a redirect, or a program that changes files. */
function trustWrite(program, args, outs) {
  const redirected = outs.find(trustTarget);
  if (redirected) return redirected;
  if (!program) return null;
  const { name } = program;
  // Reading a file's permissions or attributes changes nothing (review 2026-11-27).
  if ((name === "icacls" || name === "cacls") && !args.some((word) => ACL_CHANGES.test(word))) return null;
  if (name === "attrib" && !args.some((word) => /^[+-][A-Za-z]$/.test(word))) return null;
  const plain = args.filter((word) => !/^-/.test(word) || /[:=]/.test(word));
  if (FILE_WRITERS.has(name) || (/^(?:sed|perl)$/.test(name) && args.some((word) => /^-[A-Za-z]*i/.test(word)))) {
    return plain.find(trustTarget) ?? null;
  }
  return FILE_COPIERS.has(name) ? copyTarget(name, args) : null;
}

// Variables that choose the program Git, SSH or rsync runs, or a library SSH loads (SSH_SK_PROVIDER).
const SSH_ENV = /^(?:GIT_SSH_COMMAND|GIT_SSH|SSH_ASKPASS|SSH_ASKPASS_REQUIRE|SSH_SK_PROVIDER|RSYNC_RSH)$/i;
// Git also takes settings from the environment: GIT_CONFIG_KEY_0=core.sshCommand, GIT_CONFIG_PARAMETERS.
const GIT_CONFIG_ENV = /^GIT_CONFIG_(?:KEY_\d+|PARAMETERS)$/i;
// Programs whose arguments set a variable: export NAME=x, set NAME=x, setx NAME x, Set-Item env:NAME x.
const ENV_SETTERS = names("export set setx declare typeset local readonly set-item si new-item ni set-content sc");
// PowerShell's: a bare argument sets a variable only as an env: drive path (env:NAME, Env:\NAME),
// and a NAME=x argument is the text it writes to a file.
const PS_ENV_SETTERS = names("set-item si new-item ni set-content sc");
/** A value that clears a variable rather than sets it: `$env:GIT_SSH_COMMAND = $null` puts the default back. */
const cleared = (value) => /^\s*(?:\$null|''|"")?\s*$/i.test(value ?? "");
/**
 * The variable a segment sets that chooses the program Git or SSH runs, or null. A variable is set
 * only before the program (`NAME=x cmd`, also behind env, sudo and the like), by a program that
 * sets one, or by PowerShell's `$env:NAME = ...` (or `+=`). Reading, printing or clearing one is
 * no match, and anywhere else `NAME=x` is data: a search pattern, a commit message, a file's text.
 */
function envSetting(words) {
  const gitConfig = (name, value) => GIT_CONFIG_ENV.test(name) && /core\.sshcommand/i.test(value);
  /** What words[at] sets, or null. `setter` is the program it is an argument of; `bare`: a bare NAME counts there. */
  const sets = (at, setter = null, bare = true) => {
    const word = words[at];
    const ps = PS_ENV_SETTERS.has(setter);
    const assigned = /^(?:\$(?:env|global|script):|\$\{env:)?([A-Za-z_][A-Za-z0-9_]*)\}?\s*[-+]?=([\s\S]*)$/i.exec(word);
    if (assigned && !ps) {
      if (SSH_ENV.test(assigned[1])) return cleared(assigned[2]) ? null : assigned[1];
      if (gitConfig(assigned[1], word)) return "core.sshCommand";
    }
    const named = /^(?:\$env:|\$\{env:|env:[\\/]?)?([A-Za-z_][A-Za-z0-9_]*)\}?$/i.exec(word);
    if (!named) return null;
    // PowerShell's `$env:NAME = "value"` and `$env:NAME += "value"`.
    if (/^\$/.test(word) && /^[-+]?=/.test(words[at + 1] ?? "")) {
      const value = words[at + 1].replace(/^[-+]?=/, "") || (words[at + 2] ?? "");
      if (gitConfig(named[1], value)) return "core.sshCommand";
      return SSH_ENV.test(named[1]) && !cleared(value) ? named[1] : null;
    }
    if (!setter || !bare || !SSH_ENV.test(named[1])) return null;
    return ps ? (/^(?:\$env:|\$\{env:|env:)/i.test(word) ? named[1] : null) : named[1];
  };
  let wrapper = null;
  for (let at = 0; at < words.length; at += 1) {
    const word = words[at];
    const found = sets(at);
    if (found) return found;
    // A wrapper's own option and its value: `env -u HOME`, `env -C .`, `sudo -u deploy`.
    const values = wrapper ? WRAPPERS.get(wrapper) : null;
    if (values && (values.has(word) || values.has(word.toLowerCase()))) { at += 1; continue; }
    // Still before the program: another assignment, a wrapper's own option, a shell keyword.
    if (/^[A-Za-z_][A-Za-z0-9_]*\+?=/.test(word) || /^-/.test(word) || /^\d+(?:\.\d+)?[smhd]?$/.test(word) || /^[{}]+$/.test(word)
      || KEYWORDS.has(word.toLowerCase())) continue;
    const name = programName(word);
    if (ENV_SETTERS.has(name)) {
      const rest = words.slice(at + 1);
      // `declare -p NAME` and `export -p` print; cmd's `set NAME` prints; `export -n NAME` un-exports.
      if (/^(?:declare|typeset|export|readonly|local)$/.test(name) && rest.some((option) => /^-[A-Za-z]*p/.test(option))) return null;
      const bare = name !== "set" && !(name === "export" && rest.some((option) => /^-[A-Za-z]*n/.test(option)));
      for (let next = at + 1; next < words.length; next += 1) {
        const set = sets(next, name, bare);
        if (set) return set;
      }
      return null;
    }
    if (!WRAPPERS.has(name)) return null;
    wrapper = name;
  }
  return null;
}

const GIT_VALUE_OPTIONS = ["-C", "--git-dir", "--work-tree", "--namespace", "--exec-path", "--attr-source", "--super-prefix", "--list-cmds"];
// Git's own options that take no value. Any other long option before the command may take the next
// word as its value: `git --attr-source HEAD -c core.sshCommand=x` (review 2026-11-27).
const GIT_FLAGS = names("--no-pager --paginate --bare --no-replace-objects --no-lazy-fetch --no-optional-locks --no-advice --literal-pathspecs "
  + "--glob-pathspecs --noglob-pathspecs --icase-pathspecs --version --help --html-path --man-path --info-path");
/**
 * Git told which ssh program to run, as { setting } (`-c core.sshCommand=...`, `git clone -c ...`,
 * `git config core.sshCommand ...`), { script } for a shell command git runs (`git submodule
 * foreach`, an alias `-c alias.x=!...`, an ext:: transport), { person } for what it cannot read,
 * or null.
 */
function gitSetting(args) {
  const sets = (option, value) => (/^(?:-c|--config|--config-env)$/.test(option) && /^core\.sshcommand(?:=|$)/i.test(value ?? ""))
    || /^(?:-c|--config(?:-env)?=)core\.sshcommand=/i.test(option);
  // A setting's text: `-c key=value`, `--config key=value`, `--config=key=value`.
  const setting = (option, value) => option === "-c" || option === "--config" ? value ?? ""
    : /^--config=/.test(option) ? option.slice("--config=".length) : /^-c./.test(option) ? option.slice(2) : null;
  const scripts = [];
  // ext:: runs a command as Git's transport: `ext::ssh -oProxyCommand=x host %S repo`.
  let transport = false;
  for (const word of args) {
    const ext = /^ext::([\s\S]*)$/i.exec(word);
    if (ext) { transport = true; scripts.push(ext[1].replace(/%[sSG]/g, "x").replace(/% /g, " ")); }
  }
  const note = (value) => {
    if (value === null) return;
    // An alias that starts with "!" is a shell command git hands to sh.
    const alias = /^alias\.[^=]+=\s*!([\s\S]*)$/i.exec(value);
    if (alias) scripts.push(alias[1]);
    if (/^protocol\.(?:ext\.)?allow=(?:always|user)$/i.test(value)) transport = true;
  };
  let at = 0, loose = false;
  while (at < args.length) {
    const word = args[at];
    if (!word.startsWith("-")) {
      if (loose && args[at + 1]?.startsWith("-")) { loose = false; at += 1; continue; }
      break;
    }
    if (sets(word, args[at + 1])) return { setting: "core.sshCommand" };
    note(setting(word, args[at + 1]));
    const valued = word === "-c" || word === "--config-env" || GIT_VALUE_OPTIONS.includes(word);
    loose = !valued && /^--[\w-]+$/.test(word) && !GIT_FLAGS.has(word);
    at += valued ? 2 : 1;
  }
  const rest = args.slice(at + 1);
  // `git clone -c key=value` sets it in the new repository, and for the clone itself.
  if (args[at] === "clone") {
    if (rest.some((word, index) => sets(word, rest[index + 1]))) return { setting: "core.sshCommand" };
    rest.forEach((word, index) => note(setting(word, rest[index + 1])));
  }
  const found = transport ? { person: "Git is told to run a command as its transport (ext::), which the app cannot check, so only you can approve it." } : {};
  if (scripts.length) return { ...found, script: scripts.join("\n") };
  if (transport) return found;
  if (args[at] === "submodule" && rest[0] === "foreach") {
    const script = rest.slice(1).filter((word) => !word.startsWith("-")).join(" ");
    return script ? { script } : null;
  }
  if (args[at] !== "config") return null;
  // Reading or removing a setting changes nothing an agent could use.
  if (rest.some((word) => /^(?:--get|--get-all|--get-regexp|--unset|--unset-all|-l|--list|get|unset|list)$/.test(word))) return null;
  const alias = rest.findIndex((word) => /^alias\./i.test(word));
  if (alias >= 0 && /^\s*!/.test(rest[alias + 1] ?? "")) return { script: rest[alias + 1].replace(/^\s*!/, "") };
  const key = rest.findIndex((word) => /^core\.sshcommand$/i.test(word));
  if (key < 0) return null;
  return rest.slice(key + 1).some((word) => !word.startsWith("-")) ? { setting: "core.sshCommand" } : null;
}

/**
 * Short options read getopt's way from words[at] on; returns the index of the first word that is no
 * option. `info.ended` says the options stopped at "--".
 */
function readOptions(words, at, valueFlags, onFlag, onLong, info = {}) {
  while (at < words.length) {
    const word = words[at];
    if (word === "--") { info.ended = true; return at + 1; }
    if (word.length < 2 || word[0] !== "-") return at;
    at += 1;
    if (word.startsWith("--")) { onLong(word); continue; }
    // Glued flags: -NL 8080:localhost:80 is -N and -L with its value; -p2222 carries its value.
    for (let inside = 1; inside < word.length; inside += 1) {
      const letter = word[inside];
      if (!valueFlags.includes(letter)) { onFlag(letter); continue; }
      let value = word.slice(inside + 1);
      if (!value) { value = words[at]; at += 1; }
      onFlag(letter, value ?? null);
      break;
    }
  }
  return at;
}

// -o options an agent may never give, by what they do. Their names are matched in any letter case.
const OPTION_RULE = new Map(Object.entries({
  proxycommand: "program", localcommand: "program", permitlocalcommand: "program", knownhostscommand: "program",
  pkcs11provider: "program", securitykeyprovider: "program", xauthlocation: "program",
  proxyjump: "forwarding", controlmaster: "forwarding", controlpath: "forwarding", controlpersist: "forwarding",
  localforward: "forwarding", remoteforward: "forwarding", dynamicforward: "forwarding", forwardagent: "forwarding",
  forwardx11: "forwarding", forwardx11trusted: "forwarding", tunnel: "forwarding", tunneldevice: "forwarding",
  // The -o spellings of -N and -f, and what opens a forwarded port to other machines.
  sessiontype: "forwarding", forkafterauthentication: "forwarding", gatewayports: "forwarding", permitremoteopen: "forwarding",
  userknownhostsfile: "hostkey", globalknownhostsfile: "hostkey",
}));
/**
 * One -o option ("Name=value", "Name value"): { block, match } for a hard rule, { hold, match }
 * for one outside the allow-list (ConnectTimeout, ServerAliveInterval, ServerAliveCountMax,
 * BatchMode=yes), or {} for one on it.
 */
function readOption(text) {
  // cmd's caret, a POSIX backslash and PowerShell's backtick each vanish before ssh reads the
  // name: Proxy^Command is ProxyCommand there. ssh also takes the quotes out of the keyword and
  // the value: on the target machine `-o '"ProxyCommand"=calc.exe'`, `Proxy"Command" calc.exe` and
  // `StrictHostKeyChecking=n"o"` each set what they spell (ssh -G, review 2026-11-27).
  const found = /^\s*([A-Za-z][A-Za-z0-9]*)\s*(?:=\s*|\s+|$)([\s\S]*)$/.exec(String(text ?? "").replace(/[\^\\\x60](?=[A-Za-z=\s"']|$)/g, "").replace(/["']/g, ""));
  if (!found) return { hold: "unreadable", match: "an -o option" };
  const name = found[1].toLowerCase();
  const value = found[2].trim().toLowerCase();
  if (OPTION_RULE.has(name)) return { block: OPTION_RULE.get(name), match: found[1] };
  if (name === "stricthostkeychecking" && /^(?:no|off|false|accept-new)$/.test(value)) return { block: "hostkey", match: `${found[1]}=${value}` };
  if (name === "verifyhostkeydns" && /^(?:yes|true|ask)$/.test(value)) return { block: "hostkey", match: `${found[1]}=${value}` };
  if (/^(?:connecttimeout|serveraliveinterval|serveralivecountmax)$/.test(name) && /^\d{1,5}$/.test(value)) return {};
  if (name === "batchmode" && /^(?:yes|true)$/.test(value)) return {};
  if (/^(?:identityfile|certificatefile)$/.test(name)) return { hold: "identity", match: found[1] };
  return { hold: "option", match: found[1] };
}

// A whole word that is one variable: its value is not on the command line.
const VARIABLE = /^(?:\$[A-Za-z_]\w*|\$\{[A-Za-z_]\w*\}|\$env:[A-Za-z_]\w*|\$\{env:[A-Za-z_]\w*\}|%[A-Za-z_]\w*%)$/;
// PowerShell hands a whole array of arguments over as @name.
const SPLAT = /^@[A-Za-z_]\w*$/;
// A word that starts with a variable: the shell may split its value into several words, options among them.
const LEADS_WITH_VARIABLE = /^(?:\$[A-Za-z_{]|%[A-Za-z_]\w*%|@[A-Za-z_]\w*$)/;
// The app's own host and user rules (ssh-connections.cjs): letters, digits, dot and hyphen, or an IP address.
const HOST_NAME = /^(?=.{1,253}$)[A-Za-z0-9](?:[A-Za-z0-9.-]*[A-Za-z0-9])?$/;
const IPV6 = /^(?=[0-9A-Fa-f:]{2,45}$)[0-9A-Fa-f]*(?::[0-9A-Fa-f]*){2,}$/;
const USER_NAME = /^[A-Za-z0-9_][A-Za-z0-9._-]{0,31}$/;

/** What one program's options said: the first hard rule and the first thing only the person may approve. */
function optionState() {
  const state = {
    blocked: null, held: null, port: null, user: null,
    block(rule, match) { state.blocked ??= { rule, match }; },
    hold(rule, match) { state.held ??= { rule, match }; },
    option(text) {
      const read = readOption(text);
      if (read.block) state.block(read.block, read.match);
      else if (read.hold) state.hold(read.hold, read.match);
    },
    setPort(text) {
      // ssh keeps the first -p it is given; a command line with two is not worth guessing at.
      if (state.port !== null || !/^\d{1,5}$/.test(text) || Number(text) < 1 || Number(text) > 65535) state.hold("unreadable", "the port");
      else state.port = Number(text);
    },
    setUser(text) {
      if (VARIABLE.test(text)) state.hold("unreadable", "the user name is a variable");
      else if (!USER_NAME.test(text)) state.block("destination", text);
      else if (state.user !== null && state.user !== text) state.hold("unreadable", "two user names");
      else state.user = text;
    },
  };
  return state;
}

/** A host and a user as { host, user }, { variable } when one is a variable, or { bad } when malformed. */
function readTarget(host, user) {
  if (VARIABLE.test(host) || (user !== null && VARIABLE.test(user))) return { variable: true };
  if (!HOST_NAME.test(host) && !IPV6.test(host)) return { bad: host };
  if (user !== null && !USER_NAME.test(user)) return { bad: user };
  return { host: host.toLowerCase(), user };
}
/** ssh's destination word: [user@]host. A URL, a leading "-" and shell characters are malformed. */
function readDestination(token) {
  if (SPLAT.test(token)) return { variable: true };
  if (/^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(token) || token.startsWith("-")) return { bad: token };
  const split = token.lastIndexOf("@");
  return readTarget(split < 0 ? token : token.slice(split + 1), split < 0 ? null : token.slice(0, split));
}
/**
 * scp's and rsync's remote argument, [user@]host:path, or null for a local path. It follows scp's
 * own colon(): a word is remote when a ":" comes before any "/" (here "\" too, a Windows path), and
 * "[v6]:" or "user@[v6]:" starts a bracketed host. So host::path, .x@host:path and fd00::5:/tmp are
 * remote, as they are to scp (review 2026-11-27); ./a:b and ~/a:b are local, and so is a word that
 * starts with a drive letter (C:\x, and C:x as Git Bash leaves C:\x), which Windows' scp keeps local.
 */
function remoteSpec(word) {
  if (word.startsWith(":") || /^[A-Za-z]:/.test(word)) return null;
  let bracket = word.startsWith("[");
  for (let at = 0; at < word.length; at += 1) {
    const char = word[at];
    if (char === "@" && word[at + 1] === "[") bracket = true;
    const colon = char === "]" && word[at + 1] === ":" && bracket ? at + 1 : char === ":" && !bracket ? at : -1;
    if (colon >= 0) {
      const head = word.slice(0, colon), split = head.lastIndexOf("@");
      return { user: split < 0 ? null : head.slice(0, split), host: (split < 0 ? head : head.slice(split + 1)).replace(/^\[|\]$/g, ""),
        path: word.slice(colon + 1) };
    }
    if (char === "/" || char === "\\") return null;
  }
  return null;
}
const isUrl = (word) => /^[A-Za-z][A-Za-z0-9+.-]*:\/\//.test(word);

/** The caller's approved hosts as plain records; anything malformed is left out. */
function approvedList(hosts) {
  return (Array.isArray(hosts) ? hosts : [])
    .filter((entry) => entry && typeof entry === "object" && typeof entry.host === "string" && entry.host
      && Number.isInteger(Number(entry.port)) && typeof entry.user === "string" && entry.user)
    .map((entry) => ({ id: String(entry.id ?? ""), label: String(entry.label ?? entry.host), host: entry.host.toLowerCase(),
      port: Number(entry.port), user: entry.user, production: Boolean(entry.production) }));
}
/**
 * The approved record for a destination: host and port must match, and a user given on the command
 * line must be the record's. `problem` says why there is none.
 */
function approvedFor(hosts, host, port, user) {
  const same = hosts.filter((entry) => entry.host === host && entry.port === port);
  if (!same.length) return { record: null, problem: "unapproved" };
  if (user !== null) {
    const exact = same.find((entry) => entry.user === user);
    return exact ? { record: exact } : { record: null, problem: "user", approvedUser: same[0].user };
  }
  // Two records for one address: the stricter one decides.
  return { record: same.find((entry) => entry.production) ?? same[0] };
}

// --- what a remote command does -----------------------------------------------------------------
// Read as a script on the approved host. Each list is what only the person may approve there.
const EVALS = names("eval iex invoke-expression");
const DECODERS = names("base64 xxd certutil openssl");
const INLINE_CODE = names("python python2 python3 py perl ruby node nodejs php deno bun lua");
const PRIVILEGE = names("sudo doas runas pkexec gsudo");
const TRUST_PROGRAMS = names("useradd userdel usermod adduser deluser passwd chpasswd groupadd groupdel groupmod gpasswd visudo chage newusers vipw "
  + "ssh-keygen ssh-copy-id ssh-add ssh-import-id new-localuser set-localuser remove-localuser add-localgroupmember remove-localgroupmember");
const TRUST_PATH = /authorized_keys|sshd?_config|sudoers|known_hosts|(?:^|[\\/])\.ssh(?:[\\/]|$)|[\\/]etc[\\/](?:passwd|shadow|gshadow|group|security|pam\.d|ssh)(?:[\\/]|$)/i;
const DELETERS = names("rm rmdir del erase rd remove-item ri");
// rm -rf, rm -r, Remove-Item -Recurse, rd /s: never PowerShell's -Force.
const RECURSIVE = (word) => /^--recursive$|^\/s$|^-r(?:ec(?:u(?:r(?:se?)?)?)?)?$/.test(word)
  || (/^-[a-z]{1,3}$/.test(word) && word.includes("r") && !/^-for?$/.test(word));
const DESTROYERS = names("shred wipefs truncate dropdb dropuser reboot halt poweroff shutdown restart-computer stop-computer "
  + "kill killall pkill taskkill stop-process spps stop-service iptables ip6tables iptables-restore nft ufw firewall-cmd pfctl ipfw");
const CONTROLLERS = names("systemctl service sc net docker podman kubectl pm2 supervisorctl launchctl netsh");
const CONTROL_WORD = /^(?:stop|disable|mask|kill|reboot|poweroff|halt|kexec|suspend|hibernate|isolate|down|rm|rmi|prune|delete|drain|unload|bootout|advfirewall|firewall)$/;
const SYSTEM_PACKAGES = names("apt apt-get aptitude yum dnf zypper pacman apk snap flatpak brew dpkg rpm choco winget scoop emerge nix-env");
const LANGUAGE_PACKAGES = names("pip pip3 pipx npm pnpm yarn gem cargo go composer poetry uv bun conda mamba");
const INSTALL_WORD = /^(?:install|add|i|ci|get|remove|purge|erase|uninstall|upgrade|update|dist-upgrade|full-upgrade|autoremove|reinstall|downgrade|global|require|sync|--install|-i|-[SRU][a-z]*)$/;
const ONWARD = names("ssh scp sftp rsync nc ncat netcat socat telnet ftp lftp tftp mosh autossh sshpass plink");
const WEB_CLIENTS = names("curl wget iwr irm invoke-webrequest invoke-restmethod http https aria2c");
// A web client's options whose value is no address.
const WEB_VALUE_OPTIONS = names("-o --output -w --write-out -h --header -x --request -m --max-time --connect-timeout --retry -d --data --data-raw "
  + "--data-binary -u --user -a --user-agent -e --referer -b --cookie -c --cookie-jar -f --form -t --upload-file --tries --timeout -method "
  + "-outfile -headers -body -timeoutsec -contenttype -useragent");
const LOOPBACK = /^(?:[a-z][a-z0-9+.-]*:\/\/)?(?:localhost|127\.0\.0\.1|\[::1\])(?::\d{1,5})?(?:[/?#]|$)/i;
const SECRET_PROGRAMS = names("printenv vault pass gopass secret-tool keyctl");
const SECRET_PATH = /(?:^|[\\/=:])(?:\.env(?:\.[\w.-]+)?|\.netrc|\.pgpass|\.npmrc|\.pypirc|id_(?:rsa|dsa|ecdsa|ed25519)|credentials(?:\.\w+)?|secrets?(?:\.\w+)?|shadow)$|\.(?:pem|key|p12|pfx|jks|keystore|kdbx)$|[\\/]\.(?:aws|gnupg|kube|docker)(?:[\\/]|$)|[\\/]proc[\\/][^\\/]+[\\/]environ$|[\\/]etc[\\/]ssl[\\/]private/i;
const SECRET_TEXT = /\b(?:get-secret-value|print-access-token|print-identity-token)\b|\bkubectl\b.*\bsecrets?\b|\baws\s+configure\b|\bexport\s+-p\b/i;
// A variable named like a secret, read on the host: `echo $DB_PASSWORD`.
const SECRET_VARIABLE = /\$\{?(?:env:)?\w*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY|PRIVATE_?KEY|CREDENTIALS?)\w*\}?/i;
const DATABASE_DROP = /\b(?:drop\s+(?:database|table|schema|user|role|index|view)|truncate\s+table|dropDatabase|flushall|flushdb)\b/i;
// Shells, interpreters and database prompts: run with no script, they wait for what is typed next.
const INTERPRETERS = names("bash sh zsh ksh dash ash fish csh tcsh pwsh powershell cmd python python2 python3 py ipython node nodejs perl ruby irb php lua "
  + "julia ghci psql mysql mariadb sqlite3 redis-cli mongo mongosh bc");
const REMOTE_WHAT = {
  unreadable: "is one the app cannot read",
  privilege: "raises its privileges",
  trust: "changes who may log in or what the host trusts",
  destructive: "deletes recursively, drops data, stops or restarts something, or changes the firewall",
  install: "installs software",
  onward: "connects on from that host to another machine",
  secrets: "reads stored secrets",
};
/**
 * What a remote command does that only the person may approve on an approved host, as
 * { rule, match }, or null. Read with the same shell reader as a local command line: each segment's
 * words, so `cd /srv && sudo systemctl stop app` is found too.
 */
function remoteHold(remote, shell) {
  if (/\$\(|\x60/.test(remote)) return { rule: "unreadable", match: "a command substitution" };
  if (/<<|@["']/.test(remote)) return { rule: "unreadable", match: "a here-document" };
  if (/^(?:\s*(?:\$\{?\w+\}?|\$env:\w+|%\w+%))+\s*$/.test(remote)) return { rule: "unreadable", match: "only a variable" };
  if (/FromBase64String|\s-enc(?:odedcommand)?\b/i.test(remote)) return { rule: "unreadable", match: "an encoded payload" };
  for (const line of shell.commandLines(remote)) {
    for (const words of shell.shellSegments(line)) {
      const programs = words.map(programName);
      const has = (set) => programs.find((name) => set.has(name));
      const lower = words.map((word) => word.toLowerCase());
      const text = words.join(" ");
      // The program the segment runs, past sudo, env, timeout and the like.
      const program = locate(splitRedirects(words).words);
      const first = program && !program.script ? program.name : programs[0];
      // A wildcard where the program is: the host's shell picks the program (`/usr/bin/sud? ...`).
      const named = program && !program.script ? programName(program.word) : "";
      if (named !== "[" && named !== "[[" && /[*?[]/.test(named)) return { rule: "unreadable", match: "a wildcard in the program name" };
      if (has(EVALS)) return { rule: "unreadable", match: has(EVALS) };
      if (has(DECODERS) && words.some((word) => /^(?:-d|-D|--decode|-r|-decode|enc)$/.test(word))) return { rule: "unreadable", match: "an encoded payload" };
      if (has(INLINE_CODE) && lower.some((word) => /^(?:-[a-z]*[ce]|-r|--eval|-p|--print)$/.test(word))) return { rule: "unreadable", match: `${has(INLINE_CODE)} with inline code` };
      if (has(PRIVILEGE) || programs[0] === "su") return { rule: "privilege", match: has(PRIVILEGE) ?? "su" };
      const trusted = has(TRUST_PROGRAMS) ?? words.find((word) => TRUST_PATH.test(word))
        ?? (first === "net" && /^(?:user|localgroup|accounts|group)$/.test(lower[1] ?? "") ? `net ${lower[1]}` : undefined);
      if (trusted) return { rule: "trust", match: trusted };
      const deleter = programs.findIndex((name) => DELETERS.has(name));
      if (deleter >= 0 && lower.slice(deleter + 1).some(RECURSIVE)) return { rule: "destructive", match: `${words[deleter]} (recursive)` };
      if (programs.includes("find") && lower.some((word) => /^-(?:delete|exec|execdir|ok)$/.test(word))) return { rule: "destructive", match: "find with -delete or -exec" };
      if (has(DESTROYERS)) return { rule: "destructive", match: has(DESTROYERS) };
      if (/^(?:init|telinit)$/.test(first) && lower.some((word) => /^[06]$/.test(word))) return { rule: "destructive", match: first };
      if (DATABASE_DROP.test(text)) return { rule: "destructive", match: "a database drop" };
      const control = programs.findIndex((name) => CONTROLLERS.has(name));
      const action = control < 0 ? undefined : lower.slice(control + 1).find((word) => CONTROL_WORD.test(word));
      if (action) return { rule: "destructive", match: `${words[control]} ${action}` };
      if (lower.some((word) => /^(?:new|set|remove|enable|disable)-netfirewall/.test(word))) return { rule: "destructive", match: "a firewall change" };
      if ((has(SYSTEM_PACKAGES) || has(LANGUAGE_PACKAGES)) && words.some((word) => INSTALL_WORD.test(word))) return { rule: "install", match: has(SYSTEM_PACKAGES) ?? has(LANGUAGE_PACKAGES) };
      if (ONWARD.has(first)) return { rule: "onward", match: first };
      if (WEB_CLIENTS.has(first)) {
        // Only a service on that host itself: every address is loopback, and none is a variable.
        const addresses = [];
        for (let at = programs.indexOf(first) + 1; at < words.length; at += 1) {
          if (/^-uri$/i.test(words[at])) addresses.push(words[at += 1] ?? "");
          else if (WEB_VALUE_OPTIONS.has(lower[at])) at += 1;
          else if (!words[at].startsWith("-")) addresses.push(words[at]);
        }
        if (addresses.some((address) => !LOOPBACK.test(address))) return { rule: "onward", match: first };
      }
      const secret = has(SECRET_PROGRAMS) ?? words.find((word) => SECRET_PATH.test(word))
        ?? (words.length === 1 && /^(?:env|set)$/.test(programs[0]) ? programs[0] : undefined)
        ?? (/^(?:get-childitem|gci|dir|ls)$/.test(first) && lower.some((word) => /^env:/.test(word)) ? "the environment" : undefined)
        ?? (SECRET_TEXT.test(text) ? "a secret store" : undefined)
        ?? SECRET_VARIABLE.exec(text)?.[0];
      if (secret) return { rule: "secrets", match: secret };
    }
  }
  return null;
}
/**
 * The interactive program a remote command opens, or null: a shell, an interpreter or a database
 * prompt with no script (or with -i, -s, -l), as `ssh -tt host bash -i` or `ssh host python3`. What
 * is typed into it next is never seen by these rules (review 2026-11-27).
 */
function remoteShell(remote, shell) {
  const segments = shell.commandLines(remote).flatMap((line) => shell.shellSegments(line));
  if (segments.length !== 1) return null;
  const words = splitRedirects(segments[0]).words;
  const located = locate(words);
  // A shell with no command after it (`bash`, `bash -i`) is a wrapper that runs nothing: locate finds none.
  const program = located && !located.script ? located : INTERPRETERS.has(programName(words[0] ?? "")) ? { at: 0, name: programName(words[0]) } : null;
  if (!program || !INTERPRETERS.has(program.name)) return null;
  const args = words.slice(program.at + 1);
  const options = args.filter((word) => word.startsWith("-"));
  if (options.some((word) => /^-[A-Za-z]*c[A-Za-z]*$|^--command$|^-(?:e|E|r)$|^--eval$/i.test(word))) return null;
  return args.length === options.length || options.some((word) => /^-[A-Za-z]*[isl][A-Za-z]*$|^--login$|^--interactive$|^-noexit$/i.test(word))
    ? program.name : null;
}
/** A remote command with the escaped quotes resolved that a POSIX shell and PowerShell each resolve: \" and `" read ". */
const resolvedQuotes = (remote) => remote.replace(/\\(["'\\$\x60])/g, "$1").replace(/\x60(["'$\x60])/g, "$1");
/**
 * The ways a remote command may reach the host. The words arrive with their outer quotes off, and
 * which shell ran the line is not known: a POSIX shell and PowerShell turn \" and `" into ", and
 * PowerShell turns '' into '. The host's own POSIX shell then drops a backslash before any character
 * outside single quotes: 'r\m -rf /*' is rm there (review 2026-11-27). Each reading is judged; the
 * strictest verdict stands.
 */
function remoteReadings(remote) {
  const posix = remote.replace(/'[^']*'|\\([\s\S])/g, (whole, escaped) => escaped ?? whole);
  return [...new Set([remote, resolvedQuotes(remote), remote.replace(/''/g, "'").replace(/""/g, "\""), posix])];
}

// --- one ssh-family segment --------------------------------------------------------------------
const HOLD_WHY = {
  option: (match) => `The option ${match} is outside the short list an agent may use with SSH, so only you can approve this.`,
  identity: () => "It chooses an SSH key or certificate file (-i, IdentityFile, CertificateFile), so only you can approve this.",
  unreadable: (match) => `The app cannot read this SSH command fully (${match}), so only you can approve it.`,
  "remote-trust": () => "It reads or changes the host's login or trust files, so only you can approve it.",
  "remote-secrets": () => "It reads a secret file on the host, so only you can approve it.",
};
const heldFinding = (held, extra = {}) => finding("person", held.rule, HOLD_WHY[held.rule](held.match), { ...extra, match: clip(held.match, 40) });
// Why a command is not one plain command the reviewer could be shown with the app's facts.
const NOT_PLAIN = {
  nested: "It runs inside another shell command, so the app cannot check it on its own. Only you can approve it.",
  compound: "It is combined with other shell commands, so the app cannot check it on its own. Only you can approve it.",
  background: "It is left running in the background, so the app cannot check it on its own. Only you can approve it.",
  wrapped: "It runs through another program (sudo, timeout, env and the like), so only you can approve it.",
  environment: "It sets environment variables for the SSH program, so only you can approve it.",
  redirect: "It sends the SSH program's input or output through a file, so only you can approve it.",
  program: "The app cannot tell which SSH program this path runs, so only you can approve it.",
};

/** Whether a local path stays inside the workspace folder, read from its text alone (no link is followed). */
function withinFolder(value, folder, cwd) {
  if (/(?:^|[\\/])\.\.(?:[\\/]|$)/.test(value) || /^~/.test(value)) return false;
  const base = path.resolve(folder).toLowerCase(), target = path.resolve(cwd || folder, value).toLowerCase();
  return target === base || target.startsWith(base.endsWith(path.sep) ? base : base + path.sep);
}
/** Why a local path of a transfer cannot be reviewed, or null: it must be a plain path inside the workspace folder. */
function localPathProblem(value, context) {
  if (!context.folder) return "the app does not know this chat's workspace folder";
  if (!value || /[$\x60%*?]/.test(value)) return "a local path is not written out in full";
  if (context.cwd && !withinFolder(context.cwd, context.folder, null)) return "it runs outside the workspace folder";
  if (!withinFolder(value, context.folder, context.cwd)) return "a local path is outside the workspace folder";
  return context.shell.secretPath?.(value) ? "a local path is a secret file" : null;
}

/**
 * The verdict for a command that reaches a host: the hard rules first, then what only the person
 * may approve (the destination before the command, so the card names the host), else "review".
 */
function settle(context, { kind, state, target, port, remote = "", interactive = false, tty = false, pathProblem = null, notes = [] }) {
  const base = { kind, remote };
  if (state.blocked) return blockedFinding(state.blocked.rule, state.blocked.match, base);
  if (target && target.bad !== undefined) return blockedFinding("destination", target.bad || "an empty host", base);
  const readings = remote ? remoteReadings(remote) : [];
  for (const reading of readings) {
    // The remote command is a script: quoted or not, the hard rules read it as they read a local one.
    const denial = context.shell.hardDenial?.(reading);
    if (denial) return finding("blocked", "remote", `The command it sends over SSH is blocked: ${denial.why}.`, { ...base, match: clip(denial.match) });
  }
  const person = (rule, why, extra = {}) => finding("person", rule, why, { ...base, ...extra });
  if (state.held) return heldFinding(state.held, base);
  if (!target || target.variable) return person("unreadable", HOLD_WHY.unreadable("the destination is a variable"));
  if (target.user !== null && state.user !== null && target.user !== state.user) return person("unreadable", HOLD_WHY.unreadable("two user names"));
  const user = target.user ?? state.user;
  const where = { host: target.host, port, user, match: target.host };
  const address = `${target.host}${port === 22 ? "" : ` port ${port}`}`;
  const found = approvedFor(context.hosts, target.host, port, user);
  if (!found.record) {
    return person(found.problem, found.problem === "user"
      ? `Your SSH hosts list approves ${address} for the user ${found.approvedUser}, not ${user}. Only you can approve this.`
      : `${address} is not in your SSH hosts list. Only you can approve this, or add the host under SSH hosts.`, where);
  }
  const approved = { ...where, approved: found.record, production: found.record.production };
  if (found.record.production) {
    return person("production", `"${found.record.label}" is marked production in your SSH hosts list, so every command on it waits for you.`, approved);
  }
  if (interactive) return person("interactive", "An SSH session with no command is interactive, so only you can approve it.", approved);
  let risk = null;
  for (const reading of readings) risk ??= remoteHold(reading, context.shell);
  if (risk) {
    return person(`remote-${risk.rule}`, `On "${found.record.label}" this command ${REMOTE_WHAT[risk.rule]} (${clip(risk.match, 40)}), so only you can approve it.`,
      { ...approved, match: clip(risk.match, 40) });
  }
  if (pathProblem) return person("transfer", `The app cannot check this transfer (${pathProblem}), so only you can approve it.`, approved);
  if (context.notPlain) {
    return person(context.notPlain, NOT_PLAIN[context.notPlain] ?? HOLD_WHY.unreadable(context.unreadable), approved);
  }
  // A shell or prompt left open on the host, or a terminal asked for: what is typed next is unseen.
  const opened = readings.map((reading) => remoteShell(reading, context.shell)).find(Boolean);
  if (opened) return person("interactive", `On "${found.record.label}" it opens ${opened}, which waits for what is typed next, so only you can approve it.`, approved);
  if (tty) return person("interactive", "It asks the host for a terminal (-t), which stays open for typing, so only you can approve it.", approved);
  // What the reviewer cannot see in the command line itself.
  const told = [...notes];
  // ssh_exec's command reaches ssh as one argv element, read by no shell on this machine: what the
  // reviewer is shown is what the host's shell gets, so the notes on a local shell do not apply.
  if (kind === "ssh-exec") told.push(EXEC_NOTE);
  else {
    if (user === null && kind !== "ssh-keyscan") told.push(`No user name is on the command line, so ssh uses its own default; the approved user is ${found.record.user}.`);
    if (remote && resolvedQuotes(remote) !== remote) told.push(`With its escaped quotes resolved, the remote command reads: ${resolvedQuotes(remote)}`);
    if (/\$[A-Za-z_{]|%[A-Za-z_]\w*%/.test(remote)) {
      told.push("The remote command holds a variable. If this machine's shell fills it in before ssh runs, the app has not seen its value: allow it only if the command is safe whatever the variable holds.");
    }
  }
  return finding("review", "approved-host", `It goes to "${found.record.label}", a host in your SSH hosts list, so the reviewer checks it.`, { ...base, ...approved, notes: told });
}

const SSH_VALUE_FLAGS = "BbcDEeFIiJLlmOoPpQRSWw";
const SSH_BLOCKED_FLAGS = { A: "forwarding", X: "forwarding", Y: "forwarding", N: "forwarding", f: "forwarding", M: "forwarding",
  L: "forwarding", R: "forwarding", D: "forwarding", w: "forwarding", W: "forwarding", J: "forwarding", S: "forwarding", O: "forwarding",
  F: "config", I: "program" };
// Flags that change neither where ssh connects nor what it trusts (-t is read on its own).
const SSH_INERT_FLAGS = "46aCnqTtvx";
function readSsh(args, context) {
  const state = optionState();
  let version = false, tty = false;
  const onFlag = (letter, value) => {
    if (SSH_BLOCKED_FLAGS[letter]) state.block(SSH_BLOCKED_FLAGS[letter], `-${letter}`);
    else if (value === undefined) {
      if (letter === "V") version = true;
      else if (letter === "t") tty = true;
      else if (!SSH_INERT_FLAGS.includes(letter)) state.hold("option", `-${letter}`);
    } else if (value === null) state.hold("unreadable", `-${letter} has no value`);
    else if (letter === "o") state.option(value);
    else if (letter === "p") state.setPort(value);
    else if (letter === "l") state.setUser(value);
    else if (letter === "i") state.hold("identity", "-i");
    // -E appends ssh's debug log to a file: never to one of the trust files.
    else if (letter === "E" && trustTarget(value)) state.block("trust", value);
    else state.hold("option", `-${letter}`);
  };
  const onLong = (word) => state.hold("unreadable", clip(word, 20));
  // ssh reads options again after the destination (`ssh host -oProxyCommand=x`), unless "--"
  // ended them: then every word after the host is the remote command, as ssh.c reads it.
  const first = {};
  let at = readOptions(args, 0, SSH_VALUE_FLAGS, onFlag, onLong, first);
  const destination = args[at];
  if (destination !== undefined) at = first.ended ? at + 1 : readOptions(args, at + 1, SSH_VALUE_FLAGS, onFlag, onLong);
  const remote = args.slice(at).join(" ");
  // `ssh host $extra uptime`: a shell may split the variable's value into words, and ssh still reads options there.
  if (args[at] !== undefined && LEADS_WITH_VARIABLE.test(args[at])) state.hold("unreadable", "the command after the host starts with a variable");
  if (state.blocked) return blockedFinding(state.blocked.rule, state.blocked.match, { remote });
  if (version) {
    // `ssh -V` prints the client's version and connects nowhere: exactly that word, as one plain command.
    if (context.notPlain === "unreadable") return finding("person", "unreadable", HOLD_WHY.unreadable(context.unreadable), { match: "-V" });
    const alone = args.length === 1 && args[0] === "-V" && !context.notPlain;
    return finding(alone ? "allow" : "review", "version", alone ? "It only prints the SSH client's version; it connects nowhere."
      : "It asks for the SSH client's version, but not as one plain command, so the reviewer checks it.", { match: "-V" });
  }
  // Bare `ssh` prints its usage.
  if (destination === undefined) return state.held ? heldFinding(state.held) : null;
  return settle(context, { kind: "ssh", state, target: readDestination(destination), port: state.port ?? 22, remote, interactive: !remote, tty });
}

const SCP_VALUE_FLAGS = "cDFiJloPSX";
const SCP_BLOCKED_FLAGS = { O: "transfer", T: "transfer", 3: "transfer", R: "transfer", A: "forwarding", J: "forwarding", F: "config", S: "program", D: "program" };
const SFTP_VALUE_FLAGS = "BbcDFiJloPRSsX";
const SFTP_BLOCKED_FLAGS = { A: "forwarding", J: "forwarding", F: "config", S: "program", D: "program" };
/** scp's and sftp's options, which share most letters: { state, positional, recursive }. */
function readCopyOptions(args, valueFlags, blockedFlags, inert) {
  const state = optionState();
  let recursive = false;
  const at = readOptions(args, 0, valueFlags, (letter, value) => {
    if (blockedFlags[letter]) state.block(blockedFlags[letter], `-${letter}`);
    else if (value === undefined) {
      if (letter === "r") recursive = true;
      else if (!inert.includes(letter)) state.hold("option", `-${letter}`);
    } else if (value === null) state.hold("unreadable", `-${letter} has no value`);
    else if (letter === "o") state.option(value);
    else if (letter === "P") state.setPort(value);
    else if (letter === "i") state.hold("identity", "-i");
    else if (letter === "b") state.hold("unreadable", "a batch file of sftp commands");
    else if (!("lBR".includes(letter) && /^\d+$/.test(value))) state.hold("option", `-${letter}`);
  }, (word) => state.hold("unreadable", clip(word, 20)));
  return { state, positional: args.slice(at), recursive };
}
/**
 * A copy between this machine and one host: an upload when every local path is inside the workspace
 * folder, a download when it writes one named file there. Anything else only the person may approve.
 */
function settleCopy(context, kind, state, { spec, locals, upload, recursive, port }) {
  const notes = [];
  let pathProblem = null;
  if (upload) {
    pathProblem = locals.length ? locals.map((file) => localPathProblem(file, context)).find(Boolean) ?? null : "it names no local file";
    notes.push(`It uploads ${locals.length === 1 ? "one local path" : `${locals.length} local paths`} from the workspace folder to ${spec.path || "the user's home folder"} on the host.`);
    if (recursive) notes.push("It uploads a folder: the app checked the folder's path, not each file in it.");
  } else {
    const [destination] = locals;
    pathProblem = locals.length !== 1 ? "a download must name the one file it writes"
      : recursive || /[*?[\]]/.test(spec.path) ? "a download of a folder or a pattern writes names the host chooses"
        : /[\\/]$|(?:^|[\\/])\.{1,2}$/.test(destination) ? "a download must name the file it writes, not a folder"
          : localPathProblem(destination, context);
    notes.push(`It downloads ${spec.path} from the host to ${destination ?? "this machine"} in the workspace folder.`);
  }
  // What the transfer touches on the host is judged like a remote command's files.
  if (TRUST_PATH.test(spec.path)) state.hold("remote-trust", spec.path);
  else if (!upload && SECRET_PATH.test(spec.path)) state.hold("remote-secrets", spec.path);
  return settle(context, { kind, state, target: readTarget(spec.host, spec.user), port, pathProblem, notes });
}
function readScp(args, context) {
  const { state, positional, recursive } = readCopyOptions(args, SCP_VALUE_FLAGS, SCP_BLOCKED_FLAGS, "46BCpqsv");
  if (state.blocked) return blockedFinding(state.blocked.rule, state.blocked.match, { kind: "scp" });
  const url = positional.find(isUrl);
  if (url) return blockedFinding("destination", url, { kind: "scp" });
  const specs = positional.map(remoteSpec);
  const remotes = specs.filter(Boolean);
  // Two remote arguments make the hosts talk to each other (or pass through this machine with -3).
  if (remotes.length > 1) return blockedFinding("transfer", "two remote arguments", { kind: "scp" });
  // A copy between two local paths is no SSH connection.
  if (!remotes.length) return state.held ? heldFinding(state.held, { kind: "scp" }) : null;
  const upload = Boolean(specs.at(-1));
  if (!upload && !specs[0]) state.hold("unreadable", "the remote argument is neither first nor last");
  return settleCopy(context, "scp", state, { spec: remotes[0], locals: positional.filter((word, at) => !specs[at]), upload, recursive, port: state.port ?? 22 });
}
function readSftp(args, context) {
  const { state, positional, recursive } = readCopyOptions(args, SFTP_VALUE_FLAGS, SFTP_BLOCKED_FLAGS, "46aCfNpqv");
  if (state.blocked) return blockedFinding(state.blocked.rule, state.blocked.match, { kind: "sftp" });
  const [destination, ...locals] = positional;
  if (destination === undefined) return state.held ? heldFinding(state.held, { kind: "sftp" }) : null;
  if (isUrl(destination) || destination.startsWith("-")) return blockedFinding("destination", destination, { kind: "sftp" });
  const spec = remoteSpec(destination);
  // `sftp host` opens a prompt; only `sftp host:file local` fetches one file and ends.
  if (!spec || !spec.path) {
    return settle(context, { kind: "sftp", state, target: readDestination(destination.replace(/:$/, "")), port: state.port ?? 22, interactive: true });
  }
  return settleCopy(context, "sftp", state, { spec, locals, upload: false, recursive, port: state.port ?? 22 });
}

// rsync's long options that take a value as their next word.
const RSYNC_VALUE_OPTIONS = names("--rsh --rsync-path --exclude --include --filter --files-from --exclude-from --include-from --log-file --password-file "
  + "--port --temp-dir --partial-dir --backup-dir --suffix --compare-dest --copy-dest --link-dest --chmod --chown --bwlimit --timeout --contimeout "
  + "--max-size --min-size --out-format --info --debug --remote-option --block-size --modify-window --max-delete --usermap --groupmap --iconv "
  + "--address --sockopts --outbuf --read-batch --write-batch --only-write-batch --stop-after --stop-at --protocol --checksum-seed "
  + "--checksum-choice --compress-choice --compress-level --skip-compress --copy-as --early-input");
// Options that run a chosen program on the host, delete there, read other lists of files or follow links out of the folder.
const RSYNC_HELD = /^--(?:rsync-path|remote-option|delete(?:-\w+)*|remove-source-files|files-from|password-file|copy-links|copy-unsafe-links|copy-dirlinks|daemon|server|write-batch|read-batch|only-write-batch)$/;
/**
 * rsync's remote argument as { user, host, path }, { daemon } for an rsync daemon, or null for a
 * local path. host::module and rsync:// reach a daemon only when no remote shell was given: with
 * -e ssh (or --rsh=ssh) rsync runs daemon syntax over ssh to that host (rsync(1), "USING RSYNC-DAEMON
 * FEATURES VIA A REMOTE-SHELL CONNECTION"). The "::" inside [v6] is no daemon (review 2026-11-27).
 */
function rsyncSpec(word, viaShell) {
  const url = /^rsync:\/\/(?:([^@/]*)@)?(\[[^\]]*\]|[^/:]*)(?::\d*)?(\/[\s\S]*)?$/i.exec(word);
  if (url) return viaShell ? { user: url[1] ?? null, host: url[2].replace(/^\[|\]$/g, ""), path: url[3] ?? "" } : { daemon: true };
  const spec = remoteSpec(word);
  if (!spec || !spec.path.startsWith(":")) return spec;
  return viaShell ? { ...spec, path: spec.path.slice(1) } : { daemon: true };
}
function readRsync(args, context) {
  const state = optionState();
  const positional = [];
  let recursive = false, remoteShell = null;
  for (let at = 0; at < args.length; at += 1) {
    const word = args[at];
    if (word === "--") { positional.push(...args.slice(at + 1)); break; }
    if (word.startsWith("--")) {
      const split = word.indexOf("=");
      const name = split < 0 ? word : word.slice(0, split);
      const value = split >= 0 ? word.slice(split + 1) : RSYNC_VALUE_OPTIONS.has(name) ? args[at += 1] ?? "" : undefined;
      if (name === "--rsh") remoteShell = value ?? "";
      else if (RSYNC_HELD.test(name)) state.hold("option", name);
      else if (name === "--recursive" || name === "--archive") recursive = true;
    } else if (/^-[A-Za-z0-9]/.test(word)) {
      // A cluster of short flags; the first that takes a value takes the rest of the word, or the next one.
      for (let inside = 1; inside < word.length; inside += 1) {
        const letter = word[inside];
        if (letter === "r" || letter === "a") recursive = true;
        if (letter === "L" || letter === "k") state.hold("option", `-${letter}`);
        if (!"eBfMT".includes(letter)) continue;
        const value = word.slice(inside + 1) || args[at += 1] || "";
        if (letter === "e") remoteShell = value;
        else if (letter === "M") state.hold("option", "-M");
        break;
      }
    } else positional.push(word);
  }
  // -e and --rsh name the program rsync starts: only the plain ssh client.
  if (remoteShell !== null && remoteShell.trim() !== "ssh") return blockedFinding("program", "rsync -e", { kind: "rsync" });
  const specs = positional.map((word) => rsyncSpec(word, remoteShell !== null));
  if (specs.some((spec) => spec?.daemon)) return null; // an rsync daemon, not SSH
  const url = positional.find((word, at) => isUrl(word) && !specs[at]);
  if (url) return blockedFinding("destination", url, { kind: "rsync" });
  const remotes = specs.filter(Boolean);
  if (!remotes.length) return null; // a copy between local folders
  const upload = Boolean(specs.at(-1));
  if (remotes.length > 1 || (!upload && !specs[0])) state.hold("unreadable", "more than one remote argument");
  return settleCopy(context, "rsync", state, { spec: remotes[0], locals: positional.filter((word, at) => !specs[at]), upload, recursive, port: 22 });
}

// ssh-keygen's operations that only read the file -f names: -F and -l find and print, -y, -e and -i
// convert to the screen, -B prints a bubble-babble digest, -Q queries a revocation list.
const KEYGEN_READS = "FlyeiBQ";
function readKeygen(args) {
  const state = optionState();
  let keyFile = null;
  const used = new Set();
  const at = readOptions(args, 0, "abCDEFfIMmNnOPRrstVwYZz", (letter, value) => {
    used.add(letter);
    // -R and -H rewrite known_hosts, -A writes host keys beside the server's config.
    if (letter === "R" || letter === "H" || letter === "A") state.block("trust", `ssh-keygen -${letter}`);
    // -D loads a PKCS#11 library, -w a security-key provider.
    else if (letter === "D" || letter === "w") state.block("program", `ssh-keygen -${letter}`);
    else if (letter === "f" && value) keyFile = value;
    else if (letter === "s") keyFile ??= value || "a CA key";
  }, (word) => state.hold("unreadable", clip(word, 20)));
  if (state.blocked) return blockedFinding(state.blocked.rule, state.blocked.match, { kind: "ssh-keygen" });
  // Making a key (or -p, -c) writes the file -f names, and with `echo y |` replaces it: never a
  // trust file. Reading one with -F or -l is no write (review 2026-11-27).
  if (keyFile && sshTrustFile(keyFile) && ![...KEYGEN_READS].some((letter) => used.has(letter))) {
    return blockedFinding("trust", keyFile, { kind: "ssh-keygen" });
  }
  // A public key, or known_hosts read by -F and -l, is no key path; the secret-file rules cover .ssh.
  const files = [keyFile, ...args.slice(at)].filter((file) => typeof file === "string" && !/(?:\.pub|(?:^|[\\/])known_hosts)$/i.test(file));
  if (files.length) return finding("person", "key-file", "It names an SSH key file, so only you can approve it.", { kind: "ssh-keygen", match: clip(files[0], 40) });
  if (state.held) return heldFinding(state.held, { kind: "ssh-keygen" });
  return finding("review", "key-tool", "It runs the SSH key tool on this machine, so the reviewer checks it.", { kind: "ssh-keygen",
    notes: ["It runs ssh-keygen on this machine and names no private key file; it connects to no host."] });
}
function readAdd(args, context) {
  const state = optionState();
  // ssh-add's options that take a value ("vkKlLCcdDTxXE:e:h:H:M:m:qs:S:t:"): -T takes none, so
  // `-T -s lib` is -s with its library (review 2026-11-27).
  readOptions(args, 0, "EeHhMmSst", (letter) => {
    // -s and -e load a PKCS#11 library, -S a security-key provider.
    if ("seS".includes(letter)) state.block("program", `ssh-add -${letter}`);
  }, (word) => state.hold("unreadable", clip(word, 20)));
  if (state.blocked) return blockedFinding(state.blocked.rule, state.blocked.match, { kind: "ssh-add" });
  // `ssh-add -l` lists the fingerprints the agent holds and changes nothing.
  if (args.length === 1 && args[0] === "-l" && !context.notPlain) {
    return finding("allow", "agent-list", "It only lists the fingerprints of the keys the SSH agent holds.", { kind: "ssh-add", match: "-l" });
  }
  return finding("review", "key-tool", "It changes or reads the keys the SSH agent holds, so the reviewer checks it.", { kind: "ssh-add",
    notes: ["It runs ssh-add on this machine: it adds, removes or lists keys in the SSH agent and connects to no host."] });
}
function readKeyscan(args, context, saved) {
  const state = optionState();
  const at = readOptions(args, 0, "fOpTt", (letter, value) => {
    if (letter === "p" && typeof value === "string") state.setPort(value);
    else if (letter === "f") state.hold("unreadable", "its hosts come from a file");
  }, (word) => state.hold("unreadable", clip(word, 20)));
  // Its output is host keys nobody compared: saved to a file they would become trust nobody gave.
  if (saved) return blockedFinding("keyscan", "ssh-keyscan", { kind: "ssh-keyscan" });
  const hosts = args.slice(at).flatMap((word) => word.split(",")).filter(Boolean);
  if (!hosts.length) return state.held ? heldFinding(state.held, { kind: "ssh-keyscan" }) : null;
  let verdict = null;
  for (const host of hosts) {
    const one = settle(context, { kind: "ssh-keyscan", state, target: readDestination(host), port: state.port ?? 22,
      notes: ["It only reads the host keys the server shows; they prove nothing until the user compares them."] });
    if (!verdict || RANK[one.status] > RANK[verdict.status]) verdict = one;
  }
  return verdict;
}

const worstOf = (verdicts) => verdicts.reduce((worst, verdict) => (verdict && (!worst || RANK[verdict.status] > RANK[worst.status]) ? verdict : worst), null);
/**
 * One segment's verdict, { script } for a quoted script a wrapper runs (with `hold`, a verdict that
 * stands beside it), or null when the segment is no ssh-family one. `line` holds what was read of
 * the whole line (see sshRequest).
 */
function inspect(words, context, line) {
  const variable = envSetting(words);
  if (variable) return blockedFinding("env", variable, { kind: "env" });
  const { words: kept, outs, ins, heredoc } = splitRedirects(words);
  const located = locate(kept);
  const program = located && !located.script ? located : null;
  const args = program ? kept.slice(program.at + 1) : [];
  const written = trustWrite(program, args, outs);
  if (written) return blockedFinding("trust", written, { kind: "file" });
  if (located?.script) return { script: located.script };
  if (!program) return null;
  // A variable set for the program behind a wrapper's own options: `env -u HOME GIT_SSH_COMMAND=x git fetch`.
  for (const assign of program.assigns) {
    const [, name, value] = /^([A-Za-z_][A-Za-z0-9_]*)\+?=([\s\S]*)$/.exec(assign) ?? [];
    if (name && SSH_ENV.test(name) && !cleared(value)) return blockedFinding("env", name, { kind: "env" });
    if (name && GIT_CONFIG_ENV.test(name) && /core\.sshcommand/i.test(value)) return blockedFinding("env", "core.sshCommand", { kind: "env" });
  }
  const { name } = program;
  if (name === "git") {
    const setting = gitSetting(args);
    if (setting?.setting) return blockedFinding("env", setting.setting, { kind: "git" });
    const hold = setting?.person ? finding("person", "unreadable", setting.person, { kind: "git", match: "ext::" }) : null;
    return setting?.script ? { script: setting.script, hold } : hold;
  }
  if (POWERSHELL_REMOTING.has(name) && args.some((word) => /^-(?:hostname|sshtransport|sshconnection)$/i.test(word))) {
    return finding("person", "other-client", "PowerShell remoting with -HostName connects over SSH, where the app does not check the host. Only you can approve it.",
      { kind: "other", match: program.word });
  }
  // An alias for an SSH program: what calls it later is not read as SSH.
  if (ALIAS_DEFINERS.has(name) && args.some((word) => isClient(programName(word.replace(/^[^=\s]*=/, "").trim().split(/\s+/)[0] ?? "")))) {
    return finding("person", "unreadable", HOLD_WHY.unreadable("an alias for an SSH program"), { kind: "other", match: name });
  }
  if (URL_CLIENTS.has(name) && args.some((word) => SSH_URL.test(word))) {
    return finding("person", "other-client", `${name} connects over SSH here (an sftp:// or scp:// address), where the app does not check the host. Only you can approve it.`,
      { kind: "other", match: name });
  }
  if (!isClient(name)) {
    // A program named by a variable or an expression and called with arguments, on a request that
    // names an SSH program: `$s = 'ssh'; & $s -NL ...` runs ssh (review 2026-11-27). It stands
    // only where nothing more particular was found (`late`), so `if ($?) { ssh ... }` still says
    // why it is not one plain command.
    const called = program.indirect || (INDIRECT.test(program.word) && args.length > 0 && !EXPRESSION_OPERATOR.test(args[0]));
    return context.client && called
      ? { late: finding("person", "unreadable", HOLD_WHY.unreadable("the program is a variable or an expression"), { kind: "other", match: clip(program.word, 40) }) }
      : null;
  }
  // `... | xargs ssh`: its arguments come from what is piped in, which the app cannot read.
  const fed = program.via.some((wrapper) => wrapper === "xargs" || wrapper === "parallel");
  const verdict = worstOf((program.globbed ?? [name]).map((client) => readClient(client, program, args, { outs, ins, heredoc }, context, line)));
  if (fed && RANK[verdict?.status ?? "allow"] < RANK.person) {
    return finding("person", "unreadable", HOLD_WHY.unreadable("its arguments come from what is piped into it"), { kind: name, match: program.via.join(" ") });
  }
  return verdict;
}
/** One ssh-family program's verdict for a segment. */
function readClient(name, program, args, { outs, ins, heredoc }, context, line) {
  // Asking a tool for its usage connects nowhere and changes nothing: left as it was before these rules.
  if (args.length && args.every((word) => /^(?:--help|-h|-\?|--usage|--version)$/.test(word))) return null;
  if (OTHER_CLIENTS.has(name) || program.opaque) {
    return finding("person", "other-client", program.opaque ? "It starts SSH through Start-Process, where the app cannot read its arguments. Only you can approve it."
      : `${name} is an SSH tool whose options the app does not check, so only you can approve it.`, { kind: "other", match: name });
  }
  const notPlain = line.unreadable || heredoc ? "unreadable" : line.nested ? "nested" : !line.alone || program.kept ? "compound"
    : line.background ? "background" : program.wrapped ? "wrapped" : program.assigns.length ? "environment" : outs.length || ins.length ? "redirect"
      : program.odd || !KNOWN_PROGRAM.test(program.word) ? "program" : "";
  const local = { ...context, notPlain, unreadable: line.unreadable || "a here-document" };
  if (name === "ssh") return readSsh(args, local);
  if (name === "scp") return readScp(args, local);
  if (name === "sftp") return readSftp(args, local);
  if (name === "rsync") return readRsync(args, local);
  if (name === "ssh-keygen") return readKeygen(args);
  if (name === "ssh-add") return readAdd(args, local);
  return readKeyscan(args, local, outs.length > 0 || line.saves);
}

/**
 * A command line with its stream copies blanked, what makes it unreadable ("" when nothing does),
 * and whether a trailing "&" leaves it running in the background.
 */
function readLine(text, shell) {
  let open = false;
  const line = outsideQuotes(text, shell.QUOTED, (plain) => {
    if (/["']/.test(plain)) open = true;
    // `2>&1` copies a stream and writes no file; left in, its "&" would read as a new segment.
    return plain.replace(/[0-9*]?>&[0-9-]|[0-9]?<&[0-9-]/g, (copy) => " ".repeat(copy.length)).replace(/&>/g, " >");
  });
  const unreadable = /\$\(|\x60/.test(text) ? "a command substitution" : /@["']\s*(?:\r?\n|$)/.test(text) ? "a here-string" : open ? "an unclosed quote" : "";
  // A lone "&" that ends a line (never PowerShell's `& program`, which stands before one).
  const background = /(?:^|[^&|])&[^\S\r\n]*(?:\r?\n|$)/.test(line.replace(new RegExp(shell.QUOTED.source, "g"), "\"\""));
  return { line, unreadable, background };
}

// --- the line as Git Bash and as PowerShell read it ------------------------------------------
// Each reading is written back in the reader's dialect: a literal stretch goes in '...' (a ' in it
// as "'"), so the reader's words are that shell's words.
/** Literal text as the reader reads it. `live`: from "...", where the shell runs a $(...) it holds. */
function literal(text, live = false) {
  if (text && !/[\s;&|()\x60"'<>{}#]/.test(text)) return text;
  if (live && /\$\(/.test(text) && !/["\\\x60]/.test(text)) return `"${text}"`;
  return `'${text.replace(/'/g, "'\"'\"'")}'`;
}
/** One word of a reading, from its characters ({ ch, q: quoted or escaped, live }). */
function emitWord(chars) {
  if (!chars.length) return "''";
  let text = "";
  for (let at = 0; at < chars.length;) {
    const { q, live } = chars[at];
    let run = "";
    while (at < chars.length && chars[at].q === q && chars[at].live === live) run += chars[at++].ch;
    text += q ? literal(run, live) : run;
  }
  return text;
}
/** A word's bash brace expansions ({a,b} and x{a,b}y), as words; null for a sequence ({1..9}) or too many. */
function expandBraces(chars, budget = { words: 0 }) {
  for (let open = 0; open < chars.length; open += 1) {
    if (chars[open].q || chars[open].ch !== "{" || (open > 0 && !chars[open - 1].q && chars[open - 1].ch === "$")) continue;
    let level = 0, close = -1;
    const commas = [];
    for (let at = open + 1; at < chars.length; at += 1) {
      if (chars[at].q) continue;
      if (chars[at].ch === "{") level += 1;
      else if (chars[at].ch === "}") { if (!level) { close = at; break; } level -= 1; }
      else if (chars[at].ch === "," && !level) commas.push(at);
    }
    if (close < 0) continue;
    if (!commas.length) {
      const inner = chars.slice(open + 1, close);
      if (inner.every((char) => !char.q) && /^(?:-?\d+|[A-Za-z])\.\.(?:-?\d+|[A-Za-z])(?:\.\.-?\d+)?$/.test(inner.map((char) => char.ch).join(""))) return null;
      continue;
    }
    const words = [];
    let from = open + 1;
    for (const stop of [...commas, close]) {
      const more = expandBraces([...chars.slice(0, open), ...chars.slice(from, stop), ...chars.slice(close + 1)], budget);
      if (!more || (budget.words += more.length) > 64) return null;
      words.push(...more);
      from = stop + 1;
    }
    return words;
  }
  return [chars];
}
/** The index of the backtick that closes one opened before `from`, or -1. */
function closingBacktick(text, from) {
  for (let at = from; at < text.length; at += 1) {
    if (text[at] === "\\") at += 1;
    else if (text[at] === "\x60") return at;
  }
  return -1;
}
/** The index of the ")" that closes a "(" opened before `from` (quotes inside skipped), or -1. */
function closingParen(text, from) {
  let depth = 1;
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\\" || char === "\x60") at += 1;
    else if (char === "'" || char === "\"") {
      const close = text.indexOf(char, at + 1);
      if (close < 0) return -1;
      at = close;
    } else if (char === "(") depth += 1;
    else if (char === ")" && --depth === 0) return at;
  }
  return -1;
}
const ANSI_ESCAPES = { n: "\n", t: "\t", r: "\r", a: "\x07", b: "\b", e: "\x1b", E: "\x1b", f: "\f", v: "\v", "\\": "\\", "'": "'", "\"": "\"", "?": "?" };
/** bash's $'...' from `from` (just past the quote): { text, end }, or null when it never closes. */
function ansiQuoted(text, from) {
  let out = "";
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "'") return { text: out, end: at + 1 };
    if (char !== "\\") { out += char; continue; }
    const rest = text.slice(at + 1);
    let found;
    if (Object.hasOwn(ANSI_ESCAPES, rest[0] ?? "")) { out += ANSI_ESCAPES[rest[0]]; at += 1; }
    else if ((found = /^[0-7]{1,3}/.exec(rest))) { out += String.fromCharCode(parseInt(found[0], 8) & 0xff); at += found[0].length; }
    else if ((found = /^x([0-9A-Fa-f]{1,2})/.exec(rest))) { out += String.fromCharCode(parseInt(found[1], 16)); at += found[0].length; }
    else if ((found = /^u([0-9A-Fa-f]{1,4})|^U([0-9A-Fa-f]{1,8})/.exec(rest))) {
      const code = parseInt(found[1] ?? found[2], 16);
      out += code <= 0x10ffff ? String.fromCodePoint(code) : "";
      at += found[0].length;
    } else if (rest[0] === "c" && rest[1]) { out += String.fromCharCode(rest.charCodeAt(1) & 31); at += 2; }
    else { out += `\\${rest[0] ?? ""}`; at += 1; }
  }
  return null;
}
/** A POSIX "..." from `from` (just past the quote): { text, end }, or null when it never closes. */
function posixDouble(text, from) {
  let out = "";
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\"") return { text: out, end: at + 1 };
    if (char === "\\") {
      const next = text[at + 1];
      if (next === "\n") { at += 1; continue; }
      if (next === "\r" && text[at + 2] === "\n") { at += 2; continue; }
      if (next !== undefined && "$`\"\\".includes(next)) { out += next; at += 1; continue; }
      out += char;
      continue;
    }
    const close = char === "\x60" ? closingBacktick(text, at + 1) : char === "$" && text[at + 1] === "(" ? closingParen(text, at + 2) : at;
    if (close < 0) return null;
    out += text.slice(at, close + 1);
    at = close;
  }
  return null;
}
// A here-string: PowerShell's, copied whole wherever it appears, so the reader blanks it as before.
const HERE_STRING = /^@(["'])[ \t]*\r?\n[\s\S]*?\r?\n\1@/;

/**
 * The command as Git Bash reads it, in the reader's dialect: { text, odd, why }, or null when bash
 * could not parse it (an unclosed quote). `odd`: it expanded braces, $'...', $"..." or ${IFS}.
 */
function posixReading(text) {
  let out = "", odd = false, word = null;
  const pending = [];
  const add = (chars, q, live = false) => { word ??= []; for (const ch of chars) word.push({ ch, q, live }); };
  const end = () => {
    if (word === null) return;
    const expanded = expandBraces(word);
    if (!expanded || expanded.length !== 1 || expanded[0] !== word) odd = true;
    out += (expanded ?? [word]).map(emitWord).join(" ");
    word = null;
  };
  // A heredoc's body is copied whole after its line, as the reader expects it.
  const bodies = (from) => {
    const docs = pending.splice(0);
    for (const [index, { name, dash }] of docs.entries()) {
      let cursor = from;
      for (;;) {
        const newline = text.indexOf("\n", cursor);
        const stop = newline < 0 ? text.length : newline;
        const line = text.slice(cursor, stop).replace(/\r$/, "");
        if ((dash ? line.replace(/^\t+/, "") : line) === name || newline < 0) { cursor = stop; break; }
        cursor = newline + 1;
      }
      out += text.slice(from, cursor);
      from = cursor;
      if (index < docs.length - 1 && text[from] === "\n") { out += "\n"; from += 1; }
    }
    return from;
  };
  for (let at = 0; at < text.length;) {
    const char = text[at];
    if (char === "\\") {
      const next = text[at + 1];
      if (next === "\n") { at += 2; continue; }
      if (next === "\r" && text[at + 2] === "\n") { at += 3; continue; }
      add(next ?? "\\", true);
      at += next === undefined ? 1 : 2;
      continue;
    }
    if (char === "'") {
      const close = text.indexOf("'", at + 1);
      if (close < 0) return null;
      add(text.slice(at + 1, close), true);
      at = close + 1;
      continue;
    }
    if (char === "$" && text[at + 1] === "'") {
      const quoted = ansiQuoted(text, at + 2);
      if (!quoted) return null;
      add(quoted.text, true);
      odd = true;
      at = quoted.end;
      continue;
    }
    if (char === "\"" || (char === "$" && text[at + 1] === "\"")) {
      if (char === "$") odd = true;
      const quoted = posixDouble(text, char === "$" ? at + 2 : at + 1);
      if (!quoted) return null;
      add(quoted.text, true, true);
      at = quoted.end;
      continue;
    }
    if (char === "\x60") {
      const close = closingBacktick(text, at + 1);
      if (close < 0) return null;
      add(text.slice(at, close + 1), false);
      at = close + 1;
      continue;
    }
    // ${IFS} unquoted splits the word where it stands: ssh${IFS}-NL is `ssh -NL`.
    const ifs = /^\$(?:\{IFS\}|IFS(?![A-Za-z0-9_]))/.exec(text.slice(at, at + 6));
    if (ifs) { end(); out += " "; odd = true; at += ifs[0].length; continue; }
    if (char === "#" && word === null) {
      const stop = text.slice(at).search(/\r?\n/);
      at = stop < 0 ? text.length : at + stop;
      continue;
    }
    const here = word === null && char === "@" ? HERE_STRING.exec(text.slice(at)) : null;
    if (here) { out += here[0]; at += here[0].length; continue; }
    if (char === "<" && text[at + 1] === "<" && text[at + 2] !== "<") {
      end();
      let cursor = at + 2;
      const dash = text[cursor] === "-";
      if (dash) cursor += 1;
      while (text[cursor] === " " || text[cursor] === "\t") cursor += 1;
      const delimiter = /^(?:'([^'\n]*)'|"([^"\n]*)"|\\?([^\s;&|()<>'"]+))/.exec(text.slice(cursor));
      if (!delimiter) return null;
      const name = delimiter[1] ?? delimiter[2] ?? delimiter[3];
      pending.push({ name, dash });
      out += `<<${dash ? "-" : ""}'${name}'`;
      at = cursor + delimiter[0].length;
      continue;
    }
    if (char === "\n") { end(); out += "\n"; at += 1; if (pending.length) at = bodies(at); continue; }
    if (char === " " || char === "\t" || char === "\r") { end(); out += char; at += 1; continue; }
    if (";&|()".includes(char)) { end(); out += char; at += 1; continue; }
    add(char, false);
    at += 1;
  }
  end();
  return { text: out, odd, why: "Git Bash reads its quotes, backslashes or braces differently" };
}

const PS_SINGLE = "'\u2018\u2019\u201a\u201b", PS_DOUBLE = "\"\u201c\u201d\u201e";
const PS_ESCAPES = { n: "\n", t: "\t", r: "\r", 0: "\0", a: "\x07", b: "\b", f: "\f", v: "\v", e: "\x1b" };
/** PowerShell's '...' from `from` (just past the quote): { text, end }, or null. '' is one quote. */
function psSingle(text, from) {
  let out = "";
  for (let at = from; at < text.length; at += 1) {
    if (PS_SINGLE.includes(text[at])) {
      if (PS_SINGLE.includes(text[at + 1] ?? "\n")) { out += "'"; at += 1; continue; }
      return { text: out, end: at + 1 };
    }
    out += text[at];
  }
  return null;
}
/** PowerShell's "..." from `from`: { text, end }, or null. A backtick escapes, "" is one quote, and \ is a plain character. */
function psDouble(text, from) {
  let out = "";
  for (let at = from; at < text.length; at += 1) {
    const char = text[at];
    if (char === "\x60") {
      const next = text[at + 1];
      if (next === undefined) return null;
      out += PS_ESCAPES[next] ?? next;
      at += 1;
      continue;
    }
    if (PS_DOUBLE.includes(char)) {
      if (PS_DOUBLE.includes(text[at + 1] ?? "\n")) { out += "\""; at += 1; continue; }
      return { text: out, end: at + 1 };
    }
    if (char === "$" && text[at + 1] === "(") {
      const close = closingParen(text, at + 2);
      if (close < 0) return null;
      out += text.slice(at, close + 1);
      at = close;
      continue;
    }
    out += char;
  }
  return null;
}
/**
 * The command as Windows PowerShell 5.1 reads it, in the reader's dialect: { text, odd, why }, or
 * null when PowerShell could not parse it. On the target machine (2026-11-27) a word that starts
 * with a quote ends with it ("abc"def is two arguments), "-V\"x; 'HIDDEN' #" ran HIDDEN, # after a
 * closing quote starts a comment, and U+0085 splits words. `odd`: a backtick escape or an unusual space.
 */
function powershellReading(text) {
  let out = "", odd = false, word = null;
  const add = (chars, q, live = false) => { word ??= []; for (const ch of chars) word.push({ ch, q, live }); };
  const end = (space = "") => { if (word !== null) { out += emitWord(word) + space; word = null; } };
  for (let at = 0; at < text.length;) {
    const char = text[at];
    if (char === "\x60") {
      const next = text[at + 1];
      if (next === "\n") { at += 2; continue; }
      if (next === "\r" && text[at + 2] === "\n") { at += 3; continue; }
      add(next ?? "\x60", true);
      odd = true;
      at += next === undefined ? 1 : 2;
      continue;
    }
    const here = word === null && char === "@" ? HERE_STRING.exec(text.slice(at)) : null;
    if (here) { out += here[0]; at += here[0].length; continue; }
    if (PS_SINGLE.includes(char) || PS_DOUBLE.includes(char)) {
      const starts = word === null;
      const single = PS_SINGLE.includes(char);
      const quoted = single ? psSingle(text, at + 1) : psDouble(text, at + 1);
      if (!quoted) return null;
      if (!single && /\x60/.test(text.slice(at, quoted.end))) odd = true;
      add(quoted.text, true, !single);
      at = quoted.end;
      if (starts) end(" ");
      continue;
    }
    if (char === "<" && text[at + 1] === "#") {
      const close = text.indexOf("#>", at + 2);
      if (close < 0) return null;
      end();
      out += text.slice(at, close + 2).replace(/[^\r\n]/g, " ");
      at = close + 2;
      continue;
    }
    // PowerShell reserves "<": a POSIX heredoc or input redirect is no PowerShell line.
    if (char === "<") return null;
    if (char === "#" && word === null) {
      const stop = text.slice(at).search(/\r?\n/);
      at = stop < 0 ? text.length : at + stop;
      continue;
    }
    if (char === "\n" || char === "\r") { end(); out += char; at += 1; continue; }
    if (/\s/.test(char) || char === "\u0085") {
      end();
      out += " ";
      if (char !== " " && char !== "\t") odd = true;
      at += 1;
      continue;
    }
    if (";|&()".includes(char)) { end(); out += char; at += 1; continue; }
    // `{}` (find -exec's, an empty block) stays one word, as the reader keeps it.
    if (char === "{" && text[at + 1] === "}") { add("{}", false); at += 2; continue; }
    if ((char === "{" && word === null) || (char === "}" && !(word && /\$\{[^}]*$/.test(word.map((one) => one.ch).join(""))))) {
      end();
      out += ` ${char} `;
      at += 1;
      continue;
    }
    add(char, false);
    at += 1;
  }
  end();
  return { text: out, odd, why: "PowerShell reads its quotes or spaces differently" };
}

// A .NET call that writes, copies, moves or deletes a file: [IO.File]::WriteAllText("...known_hosts", ...).
const NET_FILE_CHANGE = /\[(?:System\.)?IO\.File(?:Info)?\]::(?!Read|Exists|Get|OpenRead|OpenText)\w+/i;
// Git or SSH told which program to run through .NET, where no word is an assignment.
const NET_ENV_SET = /SetEnvironmentVariable\s*\(\s*["'](?:GIT_SSH_COMMAND|GIT_SSH|SSH_ASKPASS|SSH_SK_PROVIDER|RSYNC_RSH)/gi;
// `& (Get-Command ssh) ...` and `. (gcm ssh) ...`: the program is what an expression returns.
const CALLED_EXPRESSION = /(?:^|[^&\w$])&[ \t]*\(|(?:^|[\s;|{(])\.[ \t]*\(/;
// A shell or Invoke-Expression that runs what it is fed: `echo '...' | bash`, `'...' | iex`,
// `bash -s <<< '...'`, `iex @'...'@`, [scriptblock]::Create('...'), $ExecutionContext's
// InvokeScript('...'), Process.Start('ssh', '...'). None of these was read (review 2026-11-27).
const FED_SHELL = String.raw`(?:(?:ba|z|da|k|c|tc|fi|a)?sh|pwsh|powershell|cmd|iex|invoke-expression)(?:\.exe)?`;
const FEEDS = new RegExp([
  String.raw`\|[ \t]*(?:sudo[ \t]+)?(?:[^\s|;&()]*[\\/])?${FED_SHELL}(?:[ \t]+(?:-{1,2}[A-Za-z][\w-]*|-))*(?:[ \t]+--(?:[ \t]+[^\s;&|()]+)*)?[ \t]*(?=$|[;&|)\r\n])`,
  String.raw`(?:^|[\s;&|(])${FED_SHELL}(?:[ \t]+-{1,2}[A-Za-z][\w-]*)*[ \t]*<<<`,
  String.raw`(?:^|[\s;&|(])(?:iex|invoke-expression)[ \t]+@["']`,
  String.raw`\[scriptblock\]::create\(|\.(?:invokescript|newscriptblock|addscript)\(|\]::start\(|processstartinfo\b`,
].join("|"), "i");
const HEREDOC_BODY = /<<-?[ \t]*(["']?)([\w.-]+)\1[^\n]*\n([\s\S]*?)\r?\n[ \t]*\2[ \t]*(?=\r?\n|$)/g;
const HERE_STRING_BODY = /@(["'])[ \t]*\r?\n([\s\S]*?)\r?\n\1@/g;
/** What a request may feed to a shell or Invoke-Expression: its quoted strings, here-strings, heredocs and <<< words. */
function fedScripts(command, QUOTED) {
  const quoted = new RegExp(QUOTED.source, "g");
  const inner = (text) => text.slice(1, -1);
  const scripts = [...command.matchAll(quoted)].map(([text]) => inner(text));
  for (const [, , body] of command.matchAll(HERE_STRING_BODY)) scripts.push(body);
  for (const [, , , body] of command.matchAll(HEREDOC_BODY)) scripts.push(body);
  for (const [, word] of command.matchAll(/<<<[ \t]*([^\s"';|&()]+)/g)) scripts.push(word);
  // Process.Start('ssh', '-NL ...') and ProcessStartInfo('ssh', '...'): the program and its arguments.
  const pair = new RegExp(String.raw`(?:\]::Start\(|ProcessStartInfo\b[^'"]*?)\s*(${QUOTED.source})\s*,\s*(${QUOTED.source})`, "gi");
  for (const [, program, list] of command.matchAll(pair)) scripts.push(`${inner(program)} ${inner(list)}`);
  return scripts.filter((script) => script.trim());
}

// --- the app's own ssh_exec tool -----------------------------------------------------------------
// Milestone 3 (2026-11-28): agents run a command on an approved host through the app's ssh_exec
// tool (chat-agent-tools.cjs), which names the host by its id in the SSH hosts list and gives the
// remote command. The app builds ssh's command line itself (ssh-connections.cjs execArgv), so no
// option, key, config or destination of the agent's reaches ssh: only the host and the command are
// judged, by the same rules as `ssh -l <user> -p <port> -- <host> <command>`.
const EXEC_HOST_ID = /^[0-9a-f]{12}$/;
const EXEC_NOTE = "It runs through the app's ssh_exec tool: the app builds the ssh command line itself (the host key the user "
  + "confirmed, key sign-in only, no prompt, terminal, input or forwarding), and the remote command reaches the host's shell "
  + "exactly as shown, in one connection that ends with it.";
/**
 * The verdict for one ssh_exec call, as sshRequest's ({ status, why, ... }, kind "ssh-exec"). An id
 * that names no approved host, and a command ssh_exec does not take (not one line of visible text,
 * or too long), are blocked: the tool would refuse to run them, so nobody is asked about them.
 */
function sshExecRequest(hostId, command, { approvedHosts = [], shell } = {}) {
  if (typeof shell?.commandLines !== "function" || typeof shell?.shellSegments !== "function" || !(shell.QUOTED instanceof RegExp)) {
    throw new TypeError("sshExecRequest needs the command approver's shell reader");
  }
  const remote = typeof command === "string" ? command : "";
  const base = { kind: "ssh-exec", remote };
  try {
    const hosts = approvedList(approvedHosts);
    const record = typeof hostId === "string" && EXEC_HOST_ID.test(hostId) ? hosts.find((entry) => entry.id === hostId) : null;
    if (!record) {
      return finding("blocked", "exec-host", "ssh_exec runs only on a host in your SSH hosts list whose key you confirmed, and this host id is not one of them.",
        { ...base, match: clip(hostId, 40) });
    }
    const problem = execCommandProblem(command);
    if (problem) return finding("blocked", "exec-command", `ssh_exec does not take this command: ${problem}`, { ...base, match: clip(remote, 40) });
    const context = { hosts, folder: null, cwd: null, shell, client: true };
    return settle(context, { kind: "ssh-exec", state: optionState(), target: { host: record.host, user: record.user }, port: record.port, remote });
  } catch {
    return finding("person", "unreadable", "The app could not read this ssh_exec call, so only you can approve it.", base);
  }
}

// A command longer than this is read only the reader's way (see sshRequest).
const LONG_COMMAND = 64 * 1024;
/** `ssh -V` or `ssh-add -l` as the whole request, as typed (optionally after `& `, with 2>&1): the two local checks. */
const PLAIN_CHECK = /^[ \t]*(?:&[ \t]*)?(?:"([A-Za-z0-9 :\\/._-]+)"|'([A-Za-z0-9 :\\/._-]+)'|([A-Za-z0-9:\\/._-]+))[ \t]+(-V|-l)(?:[ \t]+2>&1)?[ \t]*$/;
function plainCheck(command) {
  const found = PLAIN_CHECK.exec(command);
  if (!found) return false;
  const word = found[1] ?? found[2] ?? found[3];
  const name = programName(word);
  return KNOWN_PROGRAM.test(word) && ((name === "ssh" && found[4] === "-V") || (name === "ssh-add" && found[4] === "-l"));
}

/**
 * The verdict for one command an agent wants to run, or null when it has no ssh-family segment:
 * { status: "blocked" | "person" | "review" | "allow", why, match, host, port, user, approved,
 * production, remote, kind, rule, notes }. The worst status across its segments wins.
 * `approvedHosts` is the app's approved SSH hosts ([{ id, label, host, port, user, production }]),
 * `folder` the chat's workspace folder and `cwd` where the command runs (both for transfers).
 * `shell` is the command approver's shell reader: { commandLines, shellSegments, QUOTED } and, to
 * judge a remote command and a local path, { hardDenial, secretPath }. Its hardDenial is the rules
 * that were there before SSH's: a remote command's own ssh is an onward connection, the person's.
 */
function sshRequest(command, { approvedHosts = [], folder = null, cwd = null, shell } = {}) {
  if (!mentionsSsh(command)) return null;
  if (typeof shell?.commandLines !== "function" || typeof shell?.shellSegments !== "function" || !(shell.QUOTED instanceof RegExp)) {
    throw new TypeError("sshRequest needs the command approver's shell reader");
  }
  try {
    const context = { hosts: approvedList(approvedHosts), folder: typeof folder === "string" && folder ? folder : null,
      cwd: typeof cwd === "string" && cwd ? cwd : null, shell,
      // Whether the request names an SSH program anywhere: then a program it names indirectly may be one.
      client: CLIENT_TOKEN.test(command) || CLIENT_TOKEN.test(squeezed(command)) || globbedClient(command) };
    let worst = null;
    const keep = (verdict) => { if (verdict && (!worst || RANK[verdict.status] > RANK[worst.status])) worst = verdict; };
    const late = [];
    const programOf = (words) => {
      const located = locate(splitRedirects(words).words);
      return located && !located.script ? located : null;
    };
    const quotedAll = new RegExp(shell.QUOTED.source, "g");
    const seen = new Set();
    /**
     * One reading of the whole request, in the reader's dialect. `flag` makes each SSH segment in it
     * unreadable (a shell reads it differently from the reader); `nested`: a script another runs.
     */
    const readAll = (text, { flag = "", nested = false, original = false } = {}) => {
      const lines = shell.commandLines(text);
      // `& "C:\Tools\ssh.exe" host` also arrives as the quoted program alone: that is no second command.
      const mainPrograms = new Set(shell.shellSegments(readLine(lines[0] ?? "", shell).line).map((words) => programOf(words)?.word).filter(Boolean));
      const read = (lineText, inner, level, escaped = "") => {
        const key = `${inner ? 1 : 0}\u0000${escaped}\u0000${lineText}`;
        if (seen.has(key)) return;
        seen.add(key);
        const { line, unreadable, background } = readLine(lineText, shell);
        const braces = { depth: 0, braced: false };
        const segments = shell.shellSegments(line).flatMap((words) => blocks(words, braces));
        if (inner && segments.length === 1 && segments[0].length === 1 && mainPrograms.has(segments[0][0])) return;
        // ssh-keyscan's output is saved by what follows it on the line: `| cat >> keys`, `(...) > keys`.
        const writes = segments.map((words) => {
          const program = programOf(words);
          return splitRedirects(words).outs.length > 0 || PIPE_SINKS.has(program?.name) || /^(?:dd|sponge)$/.test(program?.name ?? "");
        });
        const about = { unreadable: unreadable || escaped, nested: inner, background, alone: !inner && segments.length === 1 && !braces.braced,
          saves: segments.some((words) => PIPE_SINKS.has(programOf(words)?.name)) };
        for (const [index, words] of segments.entries()) {
          const verdict = inspect(words, context, { ...about, saves: about.saves || writes.slice(index + 1).some(Boolean) });
          if (verdict?.script) {
            if (level < 4) read(verdict.script, true, level + 1, escaped);
            keep(verdict.hold);
          } else if (verdict?.late) late.push(verdict.late);
          else keep(verdict);
        }
        const changed = NET_FILE_CHANGE.test(line) ? segments.flat().find((word) => trustTarget(word.replace(/[,;)\]]+$/, ""))) : null;
        if (changed) keep(blockedFinding("trust", changed, { kind: "file" }));
        // Only outside quoted strings: a search for the text sets nothing.
        const spans = [...lineText.matchAll(quotedAll)].map((found) => [found.index, found.index + found[0].length]);
        for (const found of lineText.matchAll(NET_ENV_SET)) {
          if (!spans.some(([from, to]) => found.index > from && found.index < to)) keep(blockedFinding("env", "SetEnvironmentVariable", { kind: "env" }));
        }
        if (context.client && CALLED_EXPRESSION.test(line.replace(quotedAll, "\"\""))) {
          keep(finding("person", "unreadable", HOLD_WHY.unreadable("the program is what an expression returns"), { kind: "other" }));
        }
      };
      for (const [index, lineText] of lines.entries()) {
        read(lineText, nested || index > 0, 0, flag);
        if (!original) continue;
        // PowerShell's backtick escapes the character after it: there, ssh `-L 8080:... is ssh -L.
        const unescaped = outsideQuotes(lineText, shell.QUOTED, (plain) => plain.replace(/\x60(?=\S)/g, ""));
        if (unescaped !== lineText) read(unescaped, index > 0, 0, "a backtick escape");
      }
    };
    // The reader's own reading, without the comments neither shell runs.
    const plain = withoutComments(command, shell.QUOTED);
    readAll(plain, { original: true });
    // Past this length each shell's reading is not worked out (it would hold the approver up): the
    // hard rules found so far stand, and the rest waits for the person.
    if (command.length > LONG_COMMAND) {
      if (context.client) keep(finding("person", "unreadable", HOLD_WHY.unreadable("it is too long to read the way each shell would"), { kind: "other" }));
      for (const verdict of late) keep(verdict);
      return worst;
    }
    // Then as Git Bash and as PowerShell read it. Where a shell splits the line into other commands
    // than the reader saw, or expands what the reader kept whole, its SSH segments wait for the person.
    const shape = (text) => shell.shellSegments(readLine(shell.commandLines(text)[0] ?? "", shell).line).length;
    const base = shape(plain);
    for (const variant of [posixReading(command), powershellReading(command)]) {
      if (!variant || variant.text === plain || variant.text === command) continue;
      readAll(variant.text, { flag: variant.odd || shape(variant.text) !== base ? variant.why : "" });
    }
    // What is fed to a shell or Invoke-Expression is a script of its own.
    if (FEEDS.test(command.replace(quotedAll, (quoted) => quoted[0] + " ".repeat(Math.max(0, quoted.length - 2)) + quoted.at(-1)))) {
      for (const script of fedScripts(command, shell.QUOTED)) readAll(script, { nested: true });
      if (context.client) keep(finding("person", "unreadable", HOLD_WHY.unreadable("a script fed to a shell or Invoke-Expression"), { kind: "other" }));
    }
    for (const verdict of late) keep(verdict);
    // The two local checks are allowed only as typed: exactly `ssh -V` or `ssh-add -l`, nothing beside them.
    if (worst?.status === "allow" && !plainCheck(command)) {
      worst = finding("review", worst.rule, "It asks for the SSH client's version or the agent's keys, but not as one plain command, so the reviewer checks it.",
        { kind: worst.kind, match: worst.match });
    }
    return worst;
  } catch {
    // A command the reader fails on is not thereby safe: one that names anything of SSH's waits for the person.
    return finding("person", "unreadable", "The app could not read this SSH command, so only you can approve it.");
  }
}

module.exports = { sshRequest, sshExecRequest, sshTrustFile, mentionsSsh, SSH_TRUST_WHY, SSH_RANK: RANK };
