/**
 * The guest scripts every Maritime command runs under, and the one that cancels it. Maritime starts a
 * command in its guest daemon's process group and does not stop it when the output stream closes
 * (checked live, 2026-11-23), so the adapter gives each command a process group of its own and kills
 * that group itself.
 */

/** Where every command's process-group record and cancel marker live. */
export const execDir = "/tmp/.sandbox-sdk/exec";

/**
 * Runs as `setsid -w sh -c wrapper -- cwd command tag`, so `$$` leads a new session and process group.
 * It records that PID before it checks for a cancel marker, and the killer writes the marker before it
 * reads the PID. So a cancel that reaches the guest before the command either stops it from starting
 * (exit 137) or finds its group to kill. A missing cwd is a non-zero exit, like a failed `cd`. When the
 * record cannot be made (the directory cannot be created or written), the user's command never runs: a
 * cancel could not find it. That exits 125 with a line on stderr. When the command's shell exits while
 * another process is still in the group (`cmd &`, which can hold the output stream open), the record
 * stays, so a cancel still finds and kills that group. `/proc/<pid>/stat` names each process's group
 * after its `(comm)`; reading it forks nothing into the group. The scan errs toward keeping the record:
 * every member that could fork one the glob missed existed when the glob ran, so it is either read as a
 * member or fails its read, and both keep it. A record left behind is harmless: a later cancel finds its
 * group gone and exits 0.
 */
export const wrapper = [
  `d=${execDir}; t="$d/$3"`,
  `f() { echo "sandbox-sdk: cannot record the command under $d" >&2; exit 125; }`,
  `[ -d "$d" ] || mkdir -p "$d" || f`,
  `{ echo $$ > "$t"; } 2>/dev/null || f`,
  `if [ -e "$t.cancel" ]; then rm -f "$t" "$t.cancel"; exit 137; fi`,
  `cd -- "$1" || { rm -f "$t"; exit 1; }`,
  `sh -c "$2"; s=$?`,
  "for g in /proc/[0-9]*/stat; do",
  `  [ "$g" = "/proc/$$/stat" ] && continue`,
  // A process that exits mid-scan may have forked a member the glob missed, and a line with no `)` (a
  // newline in the process name) cannot be read: both keep the record. The braces: a vanished process
  // fails the redirect itself, before a `2>` after it applies.
  `  l=; { read -r l < "$g"; } 2>/dev/null || exit $s`,
  `  case $l in *")"*) ;; *) exit $s ;; esac`,
  "  l=${l##*)}; set -- $l",
  `  [ "$3" = "$$" ] && exit $s`,
  "done",
  `rm -f "$t"`,
  `exit $s`,
].join("\n");

/**
 * Kills one command's process group: argv is `tag`. It writes the cancel marker first, then reads the
 * PID record. No record means the wrapper has not passed its marker check yet (the marker stops it) or
 * already finished, so it exits 0. A record that is not a plain number above 1 exits 1 without a kill
 * (`kill -KILL -1` would signal every process). Otherwise it exits 0 only once `kill -0` answers
 * "No such process" for the group; any other answer, or a group still alive after about two seconds,
 * exits 1 and leaves the record for a retry. `gone` returns 0 when the group is gone, 1 while a member
 * still exists (a killed process stays until reaped), 2 when `kill` failed another way. Only the group
 * is signalled, never the bare PID: the wrapper always leads its group, so once the group is gone the
 * PID can only name an unrelated process that reused it. A marker it cannot write (the directory cannot
 * be created or written) exits 1: it would not stop a command that has not started yet. Commands run as
 * Maritime's guest user, which has passwordless sudo, so a command can start root-owned processes in its
 * group. When `sudo -n` works, every signal and check goes through it, and those die too; otherwise the
 * plain `kill` builtin is used, and a root-owned survivor answers "Operation not permitted", which exits 1.
 */
export const killer = [
  `d=${execDir}; t="$d/$1"`,
  `[ -d "$d" ] || mkdir -p "$d" || exit 1`,
  `{ : > "$t.cancel"; } 2>/dev/null || exit 1`,
  `p=`,
  `read -r p < "$t" 2>/dev/null`,
  `[ -n "$p" ] || exit 0`,
  `case $p in *[!0-9]* | 0*) exit 1 ;; esac`,
  `[ "$p" -gt 1 ] || exit 1`,
  `u=; sudo -n true 2>/dev/null && u=1`,
  // dash, the image's sh, refuses `--` before a negative PID in its builtin: `kill -KILL -PID` names the
  // group. The external `kill` that sudo runs takes `--`, and needs it before a negative PID.
  `k() { if [ -n "$u" ]; then sudo -n kill "$1" -- -"$p"; else kill "$1" -"$p"; fi; }`,
  `gone() { e=$(k -0 2>&1) && return 1; case $e in *"No such process"*) return 0;; esac; return 2; }`,
  `i=0`,
  `while :; do`,
  `  k -KILL 2>/dev/null`,
  `  gone; r=$?`,
  `  [ "$r" -eq 0 ] && break`,
  `  [ "$r" -eq 1 ] && [ "$i" -lt 40 ] || exit 1`,
  `  i=$((i + 1)); sleep 0.05`,
  `done`,
  `rm -f "$t"`,
  `exit 0`,
].join("\n");

/** The `cmd` argv of one command under {@link wrapper}. */
export function wrappedCommand(input: { cwd: string; command: string; tag: string }): string[] {
  return ["setsid", "-w", "sh", "-c", wrapper, "--", input.cwd, input.command, input.tag];
}

/** The `cmd` argv that cancels the command `tag`. */
export function killCommand(tag: string): string[] {
  return ["sh", "-c", killer, "--", tag];
}

/** Maritime's foreground limit for one command, in seconds (https://maritime.sh/docs/limits). */
export const maxCommandSeconds = 3600;

/**
 * Maritime's own deadline for a command: the caller's plus a margin, so the adapter's own timeout, which
 * kills the whole group, fires first. Capped at Maritime's one-hour foreground limit.
 */
export function commandSeconds(timeoutMs: number): number {
  const seconds = Math.ceil(timeoutMs / 1000) + 10;

  return Math.min(
    maxCommandSeconds,
    Math.max(1, Number.isFinite(seconds) ? seconds : maxCommandSeconds),
  );
}
