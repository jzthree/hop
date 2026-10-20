import fs from "node:fs";
import os from "node:os";
import path from "node:path";

/**
 * Shell integration for hop terminals — today, one job: a `codex` typed at a
 * hop prompt runs standalone (`--no-daemon`), the way every codex hop
 * launches itself already does (lib/codex-identity.js).
 *
 * Why: an attached Codex TUI shares one app-server daemon, which keeps the
 * thread's writer lock after /quit. Codex allows one writer per thread, so
 * the Codex desktop app could show a conversation started in hop but never
 * continue it ("thread … already has an active writer"). Standalone, the
 * lock lives and dies with the TUI. It also keeps the session's identity
 * honest: the daemon runs every session's tools with the FIRST session's
 * environment.
 *
 * How: a `codex` wrapper in a hop-owned directory that must come FIRST on
 * PATH. The environment alone cannot promise that — login files (brew
 * shellenv, path_helper) prepend after it — so zsh starts with ZDOTDIR
 * pointed at wrappers that source the user's own files and re-assert the
 * PATH last (the technique VS Code and Ghostty use). bash gets the same
 * re-assertion from PROMPT_COMMAND. The wrapper composes with a user's own
 * `codex` alias or function: those end in `command codex`, which is a PATH
 * lookup, and land here.
 *
 * Opt out per terminal with HOP_CODEX_DAEMON=1, or entirely with
 * HOP_SHELL_INTEGRATION=0 in hop's environment.
 */

const VERSION = "1";

const CODEX_SHIM = `#!/bin/sh
# hop: inside a hop terminal an interactive Codex runs standalone
# (--no-daemon), so its thread's writer lock ends with it and the Codex app
# can pick the conversation up. Written by hop; regenerated on start.
self_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd -P)
real=""
old_ifs=$IFS
IFS=:
for d in $PATH; do
  [ -n "$d" ] || continue
  [ "$(CDPATH= cd -- "$d" 2>/dev/null && pwd -P)" = "$self_dir" ] && continue
  if [ -x "$d/codex" ] && [ ! -d "$d/codex" ]; then real="$d/codex"; break; fi
done
IFS=$old_ifs
if [ -z "$real" ]; then
  echo "codex: command not found" >&2
  exit 127
fi
if [ -z "$HOP_SESSION" ] || [ "$HOP_CODEX_DAEMON" = "1" ]; then
  exec "$real" "$@"
fi
# Only the interactive app: bare \`codex\`, \`codex "<prompt>"\`, resume, fork.
# Every other subcommand (login, mcp, exec, agents, app-server…) is left
# exactly as typed.
want=1
skip=0
for a in "$@"; do
  if [ "$skip" = 1 ]; then skip=0; continue; fi
  case "$a" in
    --no-daemon|--remote|--remote=*) want=0; break ;;
    -c|--config|--enable|--disable|--remote-auth-token-env|-i|--image|-m|--model|--local-provider|-p|--profile|-s|--sandbox|-C|--cd|--add-dir|-a|--ask-for-approval) skip=1 ;;
    -h|--help|-V|--version) want=0; break ;;
    --) break ;;
    -*) ;;
    resume|fork) break ;;
    agents|exec|e|review|login|logout|mcp|plugin|app-server|remote-control|app|completion|update|doctor|sandbox|debug|apply|queue|archive|delete|migrate-rollouts|unarchive|cloud|exec-server|features|help|mcp-server|proto|responses-api-proxy|stdio-to-uds|generate-ts|login-status)
      want=0; break ;;
    *) break ;;  # a prompt
  esac
done
if [ "$want" = 1 ]; then
  exec "$real" --no-daemon "$@"
fi
exec "$real" "$@"
`;

// PATH re-assertion, shared by the zsh wrappers.
const ZSH_PATH_FIRST = `
if [[ -n "\${HOP_SHIM_DIR:-}" && "\${path[1]:-}" != "\$HOP_SHIM_DIR" ]]; then
  path=("\$HOP_SHIM_DIR" \${path:#\$HOP_SHIM_DIR})
fi
`;

// Each wrapper sources the user's file of the same name with ZDOTDIR set to
// the user's own (so their files see what they expect — and a ZDOTDIR their
// .zshenv sets is honoured for the rest), then points it back here so zsh
// reads the next wrapper. The last file of the startup hands ZDOTDIR back.
const zshWrapper = (name: string, tail = "") => `# hop shell integration — sources your ${name}. Written by hop.
_hop_zdot="\${ZDOTDIR}"
ZDOTDIR="\${HOP_USER_ZDOTDIR:-\$HOME}"
${name === ".zshrc" ? `# macOS /etc/zshrc put the history beside these wrappers; it is yours.
[[ "\${HISTFILE:-}" == "\${_hop_zdot}/.zsh_history" ]] && HISTFILE="\${ZDOTDIR}/.zsh_history"
` : ""}[[ -r "\${ZDOTDIR}/${name}" ]] && source "\${ZDOTDIR}/${name}"
HOP_USER_ZDOTDIR="\${ZDOTDIR}"
ZDOTDIR="\${_hop_zdot}"
unset _hop_zdot
${tail}`;

const RESTORE_ZDOTDIR = `if [[ "\${HOP_USER_ZDOTDIR:-\$HOME}" == "\$HOME" ]]; then unset ZDOTDIR; else export ZDOTDIR="\${HOP_USER_ZDOTDIR}"; fi
unset HOP_USER_ZDOTDIR
`;

const FILES: Record<string, string> = {
  "bin/codex": CODEX_SHIM,
  "zsh/.zshenv": zshWrapper(".zshenv"),
  "zsh/.zprofile": zshWrapper(".zprofile"),
  // Interactive: PATH last. A non-login shell reads no .zlogin, so this is
  // also where it gets its own ZDOTDIR back.
  "zsh/.zshrc": zshWrapper(".zshrc", `${ZSH_PATH_FIRST}if [[ ! -o login ]]; then\n${RESTORE_ZDOTDIR}fi\n`),
  // The last file a login shell reads. Only the prompt you type at gets
  // ZDOTDIR back: hop runs a relaunch as \`zsh -lc "<cmd>; exec zsh -l"\`,
  // and the shell that exec starts must come through these wrappers too.
  "zsh/.zlogin": zshWrapper(".zlogin", `${ZSH_PATH_FIRST}if [[ -o interactive ]]; then\n${RESTORE_ZDOTDIR}fi\n`),
  "VERSION": VERSION + "\n",
};

let ensured: string | null | undefined;

const hopHome = () => process.env.HOP_HOME_DIR || path.join(os.homedir(), ".hop2");

/** Writes the integration files once per process; null if they can't be. */
export const ensureShellIntegration = (): string | null => {
  if (ensured !== undefined) return ensured;
  const dir = path.join(hopHome(), "shell-integration");
  try {
    for (const [rel, body] of Object.entries(FILES)) {
      const file = path.join(dir, rel);
      fs.mkdirSync(path.dirname(file), { recursive: true });
      let current: string | null = null;
      try { current = fs.readFileSync(file, "utf8"); } catch { /* missing */ }
      if (current !== body) {
        const tmp = `${file}.${process.pid}.tmp`;
        fs.writeFileSync(tmp, body, { mode: rel.startsWith("bin/") ? 0o755 : 0o644 });
        fs.renameSync(tmp, file);
      }
    }
    ensured = dir;
  } catch {
    ensured = null;
  }
  return ensured;
};

/** Adds the integration to a terminal's environment, in place. */
export const applyShellIntegration = (shellPath: string, env: Record<string, string>) => {
  if (process.env.HOP_SHELL_INTEGRATION === "0" || env.HOP_SHELL_INTEGRATION === "0") return;
  if (os.platform() === "win32") return;
  const dir = ensureShellIntegration();
  if (!dir) return;
  const shim = path.join(dir, "bin");
  env.HOP_SHIM_DIR = shim;
  const rest = (env.PATH || "").split(":").filter((p) => p && p !== shim);
  env.PATH = [shim, ...rest].join(":");
  const shell = path.basename(shellPath);
  if (shell === "zsh") {
    if (env.ZDOTDIR && env.ZDOTDIR !== path.join(dir, "zsh")) env.HOP_USER_ZDOTDIR = env.ZDOTDIR;
    env.ZDOTDIR = path.join(dir, "zsh");
  } else if (shell === "bash") {
    const first = `[ "\${PATH%%:*}" = "$HOP_SHIM_DIR" ] || PATH="$HOP_SHIM_DIR:$PATH"`;
    env.PROMPT_COMMAND = env.PROMPT_COMMAND ? `${first}; ${env.PROMPT_COMMAND}` : first;
  }
};
