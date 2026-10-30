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
    `mkdir -p ${file.dir} || exit 1`,
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
 * split across two reads is still redacted. */
export function redactionSedScript(secrets: readonly string[]): string {
  const rules: string[] = [];

  for (const secret of secrets.flatMap((value) => value.split("\n"))) {
    if (!secret) continue;
    rules.push(`s|${sedEscape(secret)}|[REDACTED]|g`);

    for (let index = 0; index < secret.length - 1; index++) {
      rules.push(`s|${sedEscape(secret.slice(0, secret.length - 1 - index))}$|[REDACTED]|`);
      rules.push(`s|^${sedEscape(secret.slice(index + 1))}|[REDACTED]|`);
    }
  }

  return rules.join("\n") + "\n";
}

/** Escape the characters a basic sed regex or the `|` delimiter would read as syntax. */
function sedEscape(text: string): string {
  return text.replace(/[\\[\].*^$|]/g, "\\$&");
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
    `chunk=$(printf '%s\\n' "$chunk" | sed -u -f ${quote(input.sedPath)}; printf .)`,
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
    `trap 'code=$?; printf "%s" "$code" > ${file.exit}' EXIT`,
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
