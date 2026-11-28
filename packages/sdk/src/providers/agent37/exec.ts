/**
 * The guest scripts every Agent 37 command runs under, and the ones that cancel it and move bytes.
 * Agent 37's exec runs one `sh -c` string and answers once it exits, with stdout and stderr capped at
 * 512 KB each, and it does not stop the command when the request goes away (checked live, 2026-11-28). So
 * the adapter gives each command a process group of its own, kills that group itself, and keeps output
 * in files the adapter reads back when it is too big for one answer.
 */
import { quote } from "../../shared/shell.js";

/** Where every command's process-group record, cancel marker, stdin and output live. */
export const execDir = "/tmp/.sandbox-sdk/exec";

/** Output up to this many bytes per stream comes back in the exec answer; more is read from its file. */
export const inlineBytes = 262_144;

/** Bytes per chunked read: their base64 fits the 512 KB stdout cap with room to spare. */
export const readChunkBytes = 368_640;

/** Bytes per chunked upload: their base64 keeps the request under Agent 37's 1 MB body cap. */
export const writeChunkBytes = 524_288;

/** The first line of the answer trailer the supervisor prints on stdout once the command exits. */
export const trailerPrefix = "sandbox-sdk-exit:";

/**
 * The command's own session, run by {@link supervisor} as `setsid -w sh -c wrapper -- cwd command tag`,
 * so `$$` leads a new session and process group. It records that PID before it checks for a cancel marker,
 * and the killer writes the marker before it reads the PID. So a cancel that reaches the guest before the
 * command either stops it from starting (exit 137) or finds its group to kill. A missing cwd is a non-zero
 * exit, like a failed `cd`. When the record cannot be made, the user's command never runs: a cancel could
 * not find it. That exits 125 with a line on stderr.
 */
export const wrapper = [
  `d=${execDir}; t="$d/$3"`,
  `f() { echo "sandbox-sdk: cannot record the command under $d" >&2; exit 125; }`,
  `{ echo $$ > "$t"; } 2>/dev/null || f`,
  `if [ -e "$t.cancel" ]; then rm -f "$t" "$t.cancel"; exit 137; fi`,
  `cd -- "$1" || { rm -f "$t"; exit 1; }`,
  `sh -c "$2"`,
].join("\n");

/**
 * What Agent 37's own `sh -c` runs, after `set -- wrapper cwd command tag stdin` sets its arguments, so no
 * large argument passes through `execve`. It stages stdin (base64, or empty for none), runs
 * {@link wrapper} in a new session with stdout and stderr in files, and once that exits asks the kernel
 * whether the group still has members (`kill -0 -PGID`, from outside it); only "No such process" removes
 * the record, so a later cancel still finds a group a background child keeps alive. Then it prints each
 * stream of at most {@link inlineBytes} and removes its file, and ends stdout with a line naming the tag,
 * the exit status and both stream sizes. A bigger stream stays in `$t.out` or `$t.err` for the adapter
 * to read and remove.
 */
export const supervisor = [
  `i=$1; shift`,
  `d=${execDir}; t="$d/$3"`,
  `f() { echo "sandbox-sdk: cannot record the command under $d" >&2; exit 125; }`,
  `[ -d "$d" ] || mkdir -p "$d" 2>/dev/null || f`,
  `n=/dev/null`,
  `if [ -n "$4" ]; then printf %s "$4" | base64 -d > "$t.in" 2>/dev/null || f; n="$t.in"; fi`,
  `setsid -w sh -c "$i" -- "$1" "$2" "$3" < "$n" > "$t.out" 2> "$t.err"; s=$?`,
  `rm -f "$t.in"`,
  `g=`,
  `{ read -r g < "$t"; } 2>/dev/null`,
  `case $g in '' | *[!0-9]* | 0*) g= ;; esac`,
  `if [ -n "$g" ] && [ "$g" -gt 1 ]; then e=$(kill -0 -"$g" 2>&1) || case $e in *"No such process"*) rm -f "$t" ;; esac; fi`,
  `o=$(wc -c < "$t.out" 2>/dev/null) || o=-1`,
  `r=$(wc -c < "$t.err" 2>/dev/null) || r=-1`,
  `if [ "$o" -ge 0 ] && [ "$o" -le ${inlineBytes} ]; then cat "$t.out"; rm -f "$t.out"; fi`,
  `if [ "$r" -ge 0 ] && [ "$r" -le ${inlineBytes} ]; then cat "$t.err" >&2; rm -f "$t.err"; fi`,
  `printf '\\n%s%s %s %s %s\\n' '${trailerPrefix}' "$3" "$s" "$o" "$r"`,
].join("\n");

/** The exec `command` of one user command: {@link supervisor} running it under {@link wrapper}. */
export function wrappedCommand(input: {
  cwd: string;
  command: string;
  tag: string;
  stdin: string | undefined;
  env: Record<string, string>;
}): string {
  const stdin =
    input.stdin === undefined ? "" : Buffer.from(input.stdin, "utf8").toString("base64");

  const assignments = Object.entries(input.env).map(([key, value]) => quote(`${key}=${value}`));

  const command = assignments.length
    ? `exec env ${assignments.join(" ")} sh -c ${quote(input.command)}`
    : input.command;

  return `set -- ${[wrapper, input.cwd, command, input.tag, stdin].map(quote).join(" ")}\n${supervisor}`;
}

/**
 * Kills one command's process group: `$1` is its tag. It writes the cancel marker first, then reads the
 * PID record. No record means the wrapper has not passed its marker check yet (the marker stops it) or
 * already finished, so it exits 0. A record that is not a plain number above 1 exits 1 without a kill
 * (`kill -KILL -1` would signal every process). Otherwise it exits 0 only once `kill -0` answers "No
 * such process" for the group, then removes the record, the marker and any output files; any other
 * answer, or a group still alive after about two seconds, exits 1 and leaves the record for a retry.
 * Commands run as root, so every process a command starts can be signalled.
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
  // dash's kill builtin takes the group as `-PID`, with no `--` before it.
  `gone() { e=$(kill -0 -"$p" 2>&1) && return 1; case $e in *"No such process"*) return 0;; esac; return 2; }`,
  `i=0`,
  `while :; do`,
  `  kill -KILL -"$p" 2>/dev/null`,
  `  gone; r=$?`,
  `  [ "$r" -eq 0 ] && break`,
  `  [ "$r" -eq 1 ] && [ "$i" -lt 40 ] || exit 1`,
  `  i=$((i + 1)); sleep 0.05`,
  `done`,
  `rm -f "$t" "$t.cancel" "$t.out" "$t.err" "$t.in"`,
  `exit 0`,
].join("\n");

/** The exec `command` that cancels the command `tag`. */
export function killCommand(tag: string): string {
  return `set -- ${quote(tag)}\n${killer}`;
}

/**
 * Reads up to `$3` bytes of file `$1` from byte `$2`: its size on the first line, then those bytes in
 * base64. A path that does not exist prints `SDK_FILE_NOT_FOUND`, one that is not a regular file
 * `SDK_NOT_A_FILE`.
 */
const reader = [
  `[ -e "$1" ] || { echo SDK_FILE_NOT_FOUND; exit 0; }`,
  `[ -f "$1" ] || { echo SDK_NOT_A_FILE; exit 0; }`,
  `s=$(wc -c < "$1") || exit 1`,
  `echo "$s"`,
  `tail -c +$(($2 + 1)) -- "$1" | head -c "$3" | base64 -w0`,
].join("\n");

/** The exec `command` that reads one chunk of a file. */
export function readCommand(path: string, offset: number, length: number): string {
  return `set -- ${[path, String(offset), String(length)].map(quote).join(" ")}\n${reader}`;
}

/**
 * Writes one chunk of an upload: `$1` the file to write, `$2` the chunk in base64; the parent directory
 * is made first. Then, with `$3` set, it moves the file over the target `$3`, after `chmod $4` when
 * `$4` is set, so a single-chunk upload is one call.
 */
const writer = [
  `set -e`,
  `mkdir -p -- "$(dirname -- "$1")"`,
  `printf %s "$2" | base64 -d > "$1"`,
  `[ -n "$3" ] || exit 0`,
  `[ -z "$4" ] || chmod "$4" -- "$1"`,
  `mv -f -- "$1" "$3"`,
].join("\n");

/** The exec `command` that writes one upload chunk to `file`; `target` moves it into place. */
export function writeCommand(input: {
  file: string;
  chunk: Uint8Array;
  target?: string;
  mode?: number;
}): string {
  const args = [
    input.file,
    Buffer.from(input.chunk).toString("base64"),
    input.target ?? "",
    input.mode === undefined ? "" : input.mode.toString(8),
  ];

  return `set -- ${args.map(quote).join(" ")}\n${writer}`;
}

/**
 * Joins the parts `$1.0` to `$1.<$2 - 1>` of a chunked upload into `$1`, removing each, then moves
 * `$1` over the target `$3`, after `chmod $4` when `$4` is set.
 */
const joiner = [
  `set -e`,
  `: > "$1"`,
  `i=0`,
  `while [ "$i" -lt "$2" ]; do cat -- "$1.$i" >> "$1"; rm -f -- "$1.$i"; i=$((i + 1)); done`,
  `[ -z "$4" ] || chmod "$4" -- "$1"`,
  `mv -f -- "$1" "$3"`,
].join("\n");

/** The exec `command` that joins `parts` upload chunks staged at `staging.N` and moves them to `target`. */
export function joinCommand(input: {
  staging: string;
  parts: number;
  target: string;
  mode?: number;
}): string {
  const args = [
    input.staging,
    String(input.parts),
    input.target,
    input.mode === undefined ? "" : input.mode.toString(8),
  ];

  return `set -- ${args.map(quote).join(" ")}\n${joiner}`;
}

/** The exec `command` that removes an upload's staging file and its parts. */
export function discardCommand(staging: string): string {
  return `set -- ${quote(staging)}\nrm -f -- "$1" "$1".*`;
}
