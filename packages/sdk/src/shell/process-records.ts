/** Guest shell programs for the portable process-record shim. They are shell because the
 * guest must keep writing records after the SDK client that started a process is gone.
 * Each builder lists one shell command per line; the lines join with "; ". */
import { quote } from "../shared/shell.js";

/** Exit codes the record programs use to report a state, not a failure. */
export const recordExit = {
  /** The log reader found no spec.json: the process was never started. */
  missing: 66,
  /** Setup found a spec.json without an exit file: the process is still running. */
  running: 73,
  /** Setup could not enter the working directory and recorded that as the process exit. */
  badCwd: 74,
} as const;

/** Quoted paths of every record file under one process directory. */
function records(dir: string) {
  return {
    dir: quote(dir),
    spec: quote(`${dir}/spec.json`),
    restart: quote(`${dir}/restart.json`),
    base: quote(`${dir}/base`),
    log: quote(`${dir}/out.log`),
    rotate: quote(`${dir}/rotate`),
    exit: quote(`${dir}/exit`),
    pid: quote(`${dir}/pid`),
    lock: quote(`${dir}/lock`),
    stdout: quote(`${dir}/stdout`),
    stderr: quote(`${dir}/stderr`),
  };
}

/** Take a record directory's lock: a directory holding one entry named for its owner's pid.
 * A waiter frees a lock whose owner has died, and one left empty for about a second by an
 * owner killed between its two steps, so a writer killed by stop() cannot wedge the log.
 * Breaking a dead owner's lock hinges on removing its entry, which only one waiter can do. */
function lockLines(lock: string): string[] {
  return [
    // $$ is the parent shell's pid inside a subshell; /proc/self names the subshell itself.
    `lock_me=$$`,
    `read -r lock_me _ 2>/dev/null < /proc/self/stat`,
    `lock_idle=0`,
    `until mkdir ${lock} 2>/dev/null && : > ${lock}/"$lock_me"`,
    // A glob, not ls, so the wait loop forks nothing but sleep.
    `do lock_owner=`,
    `for lock_entry in ${lock}/*`,
    `do [ -e "$lock_entry" ] && lock_owner=\${lock_entry##*/}`,
    `done`,
    `if [ -n "$lock_owner" ]`,
    `then lock_idle=0`,
    // A zombie still answers kill -0, so /proc's state field decides where it exists.
    `if [ -r /proc/self/stat ]`,
    `then lock_state=Z`,
    `read -r _ _ lock_state _ 2>/dev/null < /proc/"$lock_owner"/stat`,
    `elif kill -0 "$lock_owner" 2>/dev/null`,
    `then lock_state=S`,
    `else lock_state=Z`,
    `fi`,
    `case "$lock_state" in Z|X) rm ${lock}/"$lock_owner" 2>/dev/null && rmdir ${lock} 2>/dev/null;; esac`,
    `elif [ -d ${lock} ]`,
    `then lock_idle=$((lock_idle+1))`,
    `[ "$lock_idle" -lt 100 ] || { rmdir ${lock} 2>/dev/null; lock_idle=0; }`,
    `fi`,
    `sleep .01`,
    `done`,
  ];
}

/** Release a lock taken by {@link lockLines} in the same shell. */
function unlockCommand(lock: string): string {
  return `rm ${lock}/"$lock_me" 2>/dev/null && rmdir ${lock}`;
}

/** Print spec.json, a NUL, a `base start size status` header line, then a base64 log window.
 * It takes the writer's lock, so rotation cannot pair a new base with an old log. */
export function logPageScript(input: {
  dir: string;
  /** Absolute log offset to read after; undefined starts at the oldest kept byte. */
  after: number | undefined;
  lookbehind: number;
  length: number;
}): string {
  const file = records(input.dir);

  return [
    `[ -f ${file.spec} ] || exit ${recordExit.missing}`,
    `cat ${file.spec} || exit 1`,
    `printf '\\000'`,
    ...lockLines(file.lock),
    `trap ${quote(unlockCommand(file.lock))} EXIT`,
    `b=$(cat ${file.base})`,
    `n=$(wc -c < ${file.log})`,
    `a=${input.after ?? '"$b"'}`,
    `s=$((a-b-${input.lookbehind}))`,
    `[ "$s" -ge 0 ] || s=0`,
    `e=running`,
    `if [ -f ${file.exit} ]`,
    `then e=$(cat ${file.exit})`,
    `fi`,
    `printf '%s %s %s %s\\n' "$b" "$s" "$n" "$e"`,
    `dd if=${file.log} bs=1 skip="$s" count=${input.length} 2>/dev/null | base64`,
  ].join("; ");
}

/** Prepare a process directory in one exec. stdin carries spec.json and restart.json as two
 * base64 lines, which keeps exact UTF-8 bytes through transports that normalize input.
 * A missing working directory becomes the process's own failed exit and log. */
export function recordSetupScript(input: { dir: string; cwd: string }): string {
  const file = records(input.dir);

  return [
    `(umask 077; mkdir -p ${file.dir}) || exit 1`,
    // The lock makes the running check and the record writes one step, so two concurrent
    // starts under one name cannot both pass the check.
    ...lockLines(file.lock),
    `trap ${quote(unlockCommand(file.lock))} EXIT`,
    `if [ -f ${file.spec} ] && [ ! -f ${file.exit} ]`,
    `then exit ${recordExit.running}`,
    `fi`,
    // The next log continues the absolute offsets of the previous run.
    `b=0`,
    `if [ -f ${file.base} ]`,
    `then b=$(cat ${file.base})`,
    `n=$(wc -c < ${file.log})`,
    `b=$((b+n))`,
    `fi`,
    `IFS= read -r s && IFS= read -r r && printf '%s' "$s" | base64 -d > ${file.spec} && (umask 077; printf '%s' "$r" | base64 -d > ${file.restart}) && : > ${file.log} && printf '%s' "$b" > ${file.base} && rm -f ${file.exit} || exit 1`,
    `m=$(cd ${quote(input.cwd)} 2>&1) && exit 0`,
    `c=$?`,
    `printf '%s\n' "$m" | sed 's/^/E/' > ${file.log}`,
    `printf 0 > ${file.pid}`,
    `printf '%s' "$c" > ${file.exit}`,
    `exit ${recordExit.badCwd}`,
  ].join("; ");
}

/** The sed program the stream readers apply to each chunk. Each secret line is replaced
 * whole, and each of its prefixes at a chunk's end and suffixes at its start, so a secret
 * split across two reads is still redacted. Existing and emitted `[REDACTED]` markers are
 * shielded using control bytes absent from every secret so neither literal markers nor
 * non-secret control bytes are mangled. */
export function redactionSedScript(secrets: readonly string[]): string {
  const lines = [...new Set(secrets.flatMap((value) => value.split("\n")).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );

  if (lines.length === 0) return "\n";

  // Choose three distinct non-whitespace control bytes absent from all secrets:
  // `esc` escapes literal occurrences of itself (`esc` -> `esc + lit`), while
  // `esc + mark` shields existing and newly emitted `[REDACTED]` markers until the end.
  const candidates = [
    "\u001e",
    "\u001f",
    "\u001c",
    "\u001d",
    "\u0001",
    "\u0002",
    "\u0003",
    "\u0004",
    "\u0005",
    "\u0006",
    "\u0007",
    "\u0008",
    "\u000b",
    "\u000c",
    "\u000e",
    "\u000f",
    "\u0010",
    "\u0011",
    "\u0012",
    "\u0013",
    "\u0014",
    "\u0015",
    "\u0016",
    "\u0017",
    "\u0018",
    "\u0019",
    "\u001a",
    "\u001b",
  ].filter((ch) => lines.every((secret) => !secret.includes(ch)));

  const esc = candidates[0];
  const lit = candidates[1];
  const mark = candidates[2];
  const placeholder = esc && lit && mark ? `${esc}${mark}` : undefined;
  const replacement = placeholder ?? "[REDACTED]";
  const rules: string[] = [];

  const marker = "[REDACTED]";

  const shield = (value: string) =>
    esc && lit && placeholder
      ? value.split(marker).map(sedEscape).join(placeholder)
      : sedEscape(value);

  if (esc && lit && placeholder) {
    rules.push(`s|${esc}|${esc}${lit}|g`);
    rules.push(`s|\\[REDACTED\\]|${placeholder}|g`);
  }

  for (const secret of lines) {
    rules.push(`s|${shield(secret)}|${replacement}|g`);

    for (let index = 0; index < secret.length - 1; index++) {
      const prefix = secret.slice(0, secret.length - 1 - index);
      const suffix = secret.slice(index + 1);

      if (prefix !== marker) rules.push(`s|${shield(prefix)}$|${replacement}|`);

      if (suffix !== marker) rules.push(`s|^${shield(suffix)}|${replacement}|`);
    }
  }

  if (esc && lit && placeholder) {
    const rightSuffixes = new Set<string>();
    const leftPrefixes = new Set<string>();
    const aroundPairs: [string, string][] = [];
    const markerContainingSecrets: string[] = [];

    for (const secret of lines) {
      if (marker.includes(secret)) continue;

      if (secret.includes(marker)) markerContainingSecrets.push(secret);
      const limit = Math.min(secret.length - 1, marker.length);

      for (let overlap = 1; overlap <= limit; overlap++) {
        if (marker.endsWith(secret.slice(0, overlap))) rightSuffixes.add(secret.slice(overlap));

        if (marker.startsWith(secret.slice(secret.length - overlap)))
          leftPrefixes.add(secret.slice(0, secret.length - overlap));
      }

      let markerAt = secret.indexOf(marker);

      while (markerAt !== -1) {
        const before = secret.slice(0, markerAt);
        const after = secret.slice(markerAt + marker.length);

        if (before && after) aroundPairs.push([before, after]);
        markerAt = secret.indexOf(marker, markerAt + 1);
      }
    }

    const spansAdjacentMarkers = lines.some(
      (secret) => "[REDACTED][REDACTED]".includes(secret) && !marker.includes(secret),
    );

    const absorbRules: string[] = [];

    for (const secret of markerContainingSecrets) {
      absorbRules.push(`s|${shield(secret)}|${placeholder}|g`);
    }

    for (const [before, after] of aroundPairs) {
      absorbRules.push(`s|${shield(before)}${placeholder}${shield(after)}|${placeholder}|g`);
    }

    for (const suffix of [...rightSuffixes].sort((a, b) => b.length - a.length)) {
      absorbRules.push(`s|${placeholder}${shield(suffix)}|${placeholder}|g`);
    }

    for (const prefix of [...leftPrefixes].sort((a, b) => b.length - a.length)) {
      absorbRules.push(`s|${shield(prefix)}${placeholder}|${placeholder}|g`);
    }

    if (spansAdjacentMarkers) {
      absorbRules.push(`s|${placeholder}${placeholder}|${placeholder}|g`);
    }

    if (absorbRules.length > 0) {
      rules.push(":m", ...absorbRules, "t m");
    }

    rules.push(`s|${placeholder}|[REDACTED]|g`);
    rules.push(`s|${esc}${lit}|${esc}|g`);
  }

  return rules.join("\n") + "\n";
}

/** Escape the characters a basic sed regex or the `|` delimiter would read as syntax. */
function sedEscape(text: string): string {
  // `\|` is consumed as an escaped delimiter or read as GNU BRE alternation; `[|]` stays literal.
  return text.replace(/[\\[\].*^$]/g, "\\$&").replace(/\|/g, "[|]");
}

/** A shell function `append MARKER TEXT` that adds one log record under the writer's lock
 * and rotates out.log to its newest 5 MB once it passes 10 MB, advancing base to match. */
function appendFunction(dir: string): string {
  const file = records(dir);

  const body = [
    ...lockLines(file.lock),
    `printf '%s%s\\n' "$1" "$2" >> ${file.log}`,
    `n=$(wc -c < ${file.log})`,
    `if [ "$n" -gt 10485760 ]`,
    `then tail -c 5242880 ${file.log} | tail -n +2 > ${file.rotate}`,
    `kept=$(wc -c < ${file.rotate})`,
    `b=$(cat ${file.base})`,
    `echo $((b+n-kept)) > ${file.base}`,
    `mv ${file.rotate} ${file.log}`,
    `fi`,
    unlockCommand(file.lock),
  ].join("; ");

  return `append() { ${body}; };`;
}

/** A background subshell that reads one output FIFO and appends each line as a record.
 * It reads 4 KB at a time, then up to three more bytes so a UTF-8 character is never split,
 * and redacts with the sed script before anything reaches the log. A full line is recorded
 * under the upper-case marker, a trailing partial line under the lower-case one. */
function streamReader(input: { marker: "O" | "E"; fifo: string; sedPath: string }): string {
  return [
    `(nl=$(printf '\\nX')`,
    `nl=\${nl%X}`,
    `while :`,
    `do chunk=$(dd bs=4096 count=1 2>/dev/null; printf .)`,
    `chunk=\${chunk%.}`,
    `[ -n "$chunk" ] || break`,
    // Count the continuation bytes still owed by a multi-byte character at the chunk's end.
    `need=0`,
    `for byte in $(printf '%s' "$chunk" | tail -c 4 | od -An -tu1)`,
    `do if [ "$byte" -ge 240 ]`,
    `then need=3`,
    `elif [ "$byte" -ge 224 ]`,
    `then need=2`,
    `elif [ "$byte" -ge 192 ]`,
    `then need=1`,
    `elif [ "$byte" -ge 128 ]`,
    `then [ "$need" -le 0 ] || need=$((need-1))`,
    `else need=0`,
    `fi`,
    `done`,
    `if [ "$need" -gt 0 ]`,
    `then rest=$(dd bs=1 count="$need" 2>/dev/null; printf .)`,
    `rest=\${rest%.}`,
    `chunk="$chunk$rest"`,
    `fi`,
    // One chunk in, then end of input: no -u needed, and BusyBox sed (Alpine) has none.
    `chunk=$(printf '%s\\n' "$chunk" | sed -f ${quote(input.sedPath)}; printf .)`,
    `chunk=\${chunk%.}`,
    `chunk=\${chunk%"$nl"}`,
    `while [ -n "$chunk" ]`,
    `do case "$chunk" in *"$nl"*) line=\${chunk%%"$nl"*}`,
    `append ${input.marker} "$line"`,
    `chunk=\${chunk#*"$nl"};`,
    `*) append ${input.marker.toLowerCase()} "$chunk"`,
    `chunk=;`,
    `esac`,
    `done`,
    `done < ${quote(input.fifo)}) &`,
  ].join("; ");
}

/** The supervisor runs the command with stdout and stderr on two FIFOs, feeds each through
 * a stream reader into out.log, and writes the exit code when it ends, TERM included. */
export function supervisorScript(input: {
  dir: string;
  cwd: string;
  command: string;
  sedPath: string;
}): string {
  const file = records(input.dir);

  return [
    `chmod 600 ${quote(input.sedPath)}`,
    // The sed program holds the secrets verbatim; drop it before the exit record says the process is done.
    `trap ${quote(`code=$?; rm -f ${quote(input.sedPath)}; printf "%s" "$code" > ${file.exit}`)} EXIT`,
    `trap 'exit 143' TERM`,
    `${appendFunction(input.dir)} rm -f ${file.stdout} ${file.stderr}`,
    `mkfifo ${file.stdout} ${file.stderr}`,
    `${streamReader({ marker: "O", fifo: `${input.dir}/stdout`, sedPath: input.sedPath })} out=$!`,
    `${streamReader({ marker: "E", fifo: `${input.dir}/stderr`, sedPath: input.sedPath })} err=$!`,
    `{ cd ${quote(input.cwd)} && sh -c ${quote(input.command)}; } > ${file.stdout} 2> ${file.stderr}`,
    `code=$?`,
    `wait "$out" "$err"`,
    `exit "$code"`,
  ].join("; ");
}

/** Start the supervisor detached from this exec and record its pid. With waitForExit, poll
 * about 100 ms for a command that exits at once and print its exit code if it does. */
export function detachedLaunchScript(input: {
  dir: string;
  supervisor: string;
  waitForExit: boolean;
}): string {
  const file = records(input.dir);
  const launch = `nohup setsid sh -c ${quote(input.supervisor)} > /dev/null 2>&1 < /dev/null & echo $! > ${file.pid}`;

  if (!input.waitForExit) return launch;

  return [
    launch,
    `i=0`,
    `while [ "$i" -lt 10 ] && [ ! -f ${file.exit} ]`,
    `do sleep 0.01`,
    `i=$((i+1))`,
    `done`,
    `cat ${file.exit} 2>/dev/null`,
    `true`,
  ].join("; ");
}
