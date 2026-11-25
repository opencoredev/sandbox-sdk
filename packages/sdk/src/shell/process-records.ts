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

/** After a stop and a start, mark as killed (137) each record that has no exit and was last
 * written in an earlier second than the guest's boot (`btime`), and remove run markers older than
 * the boot. A record is checked again and written only while this script holds its lock, so a
 * setup that reuses the name since the boot is never marked killed, and any client can run this at
 * any time. The lock is only tried: this script never breaks or waits out a lock it does not hold,
 * and the whole scan gives up on contended records after about a second, leaving them as they
 * are. A timestamp that cannot be read proves nothing, so that record is left as it is too. /tmp is
 * writable by anything in the guest, so no symlink is followed and nothing another user owns is
 * written or removed: the exit is created only where no file or link stands. */
export function bootRepairScript(): string {
  const owned = (path: string) => `[ -d "${path}" ] && [ ! -L "${path}" ] && [ -O "${path}" ]`;

  const stale = `${owned("$d")} && [ -f "$d/spec.json" ] && [ ! -L "$d/spec.json" ] && [ ! -e "$d/exit" ] && [ ! -L "$d/exit" ] && t=$(stat -c %Y "$d/spec.json") && [ "$t" -lt "$boot" ]`;

  const root = "/tmp/.sandbox-sdk";

  return [
    `boot=$(sed -n 's/^btime //p' /proc/stat)`,
    `[ -n "$boot" ] || exit 1`,
    `${owned(root)} || exit 0`,
    `tries=0`,
    `${owned(`${root}/procs`)} && for d in ${root}/procs/*`,
    `do ${stale} || continue`,
    `until mkdir "$d/lock" 2>/dev/null`,
    `do tries=$((tries+1))`,
    `[ "$tries" -lt 100 ] || continue 2`,
    `sleep .01`,
    `done`,
    // An entry for this shell, so a waiter sees a live owner rather than an abandoned lock.
    `marked=0`,
    `if : > "$d/lock/$$" && ${stale}`,
    `then (set -C; printf 137 > "$d/exit") || marked=1`,
    `fi`,
    `rm "$d/lock/$$" 2>/dev/null && rmdir "$d/lock"`,
    `[ "$marked" -eq 0 ] || exit 1`,
    `done`,
    `${owned(`${root}/runs`)} && for m in ${root}/runs/*`,
    `do [ -e "$m" ] && [ ! -L "$m" ] && [ -O "$m" ] && [ "$(stat -c %Y "$m")" -lt "$boot" ] && rm -rf "$m"`,
    `done`,
    `true`,
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
    // The next log continues the absolute offsets of the previous run. pid stays 0 until the
    // launcher records one, so stop() never signals a stale pid from that run.
    `b=0`,
    `if [ -f ${file.base} ]`,
    `then b=$(cat ${file.base})`,
    `n=$(wc -c < ${file.log})`,
    `b=$((b+n))`,
    `fi`,
    `IFS= read -r s && IFS= read -r r && printf '%s' "$s" | base64 -d > ${file.spec} && (umask 077; printf '%s' "$r" | base64 -d > ${file.restart}) && : > ${file.log} && printf '%s' "$b" > ${file.base} && rm -f ${file.exit} && printf 0 > ${file.pid} || exit 1`,
    `m=$(cd ${quote(input.cwd)} 2>&1) && exit 0`,
    `c=$?`,
    `printf '%s\n' "$m" | sed 's/^/E/' > ${file.log}`,
    `printf '%s' "$c" > ${file.exit}`,
    `exit ${recordExit.badCwd}`,
  ].join("; ");
}

/** Maximum byte length of any single line across the configured secrets. */
export function maxSecretLineBytes(secrets: readonly string[]): number {
  let max = 0;

  for (const value of secrets) {
    for (const line of value.split("\n")) {
      if (!line) continue;
      const bytes = Buffer.byteLength(line);

      if (bytes > max) max = bytes;
    }
  }

  return max;
}

/** Maximum byte length of any secret prefix that sits left of `[REDACTED]` (or a prefix of it). */
export function maxLeftMarkerBytes(secrets: readonly string[]): number {
  const marker = "[REDACTED]";
  let max = 0;

  for (const value of secrets) {
    for (const line of value.split("\n")) {
      if (!line) continue;
      const markerAt = line.indexOf(marker);

      if (markerAt > 0) {
        const bytes = Buffer.byteLength(line.slice(0, markerAt));

        if (bytes > max) max = bytes;
      }

      const limit = Math.min(line.length - 1, marker.length - 1);

      for (let overlap = 1; overlap <= limit; overlap++) {
        if (marker.startsWith(line.slice(line.length - overlap))) {
          const bytes = Buffer.byteLength(line.slice(0, line.length - overlap));

          if (bytes > max) max = bytes;
        }
      }
    }
  }

  return max;
}

function sortedSecretLines(secrets: readonly string[]): string[] {
  return [...new Set(secrets.flatMap((value) => value.split("\n")).filter(Boolean))].sort(
    (a, b) => b.length - a.length,
  );
}

/** Deduplicated non-empty secret lines sorted longest-first for exact suffix-prefix boundary matching in stream readers. */
export function secretLinesText(secrets: readonly string[]): string {
  const lines = sortedSecretLines(secrets);

  return lines.length === 0 ? "" : `${lines.join("\n")}\n`;
}

/** The sed program the stream readers apply to each chunk. Each secret line is replaced
 * whole; for secrets up to 512 bytes, each prefix at a chunk's end and suffix at its start
 * is also replaced so a secret split across two reads is redacted without holdback. When any
 * secret line exceeds 512 bytes, the reader carries a trailing overlap window across chunks
 * instead, keeping redact.sed bounded while redacting secrets of any length across chunks.
 * Existing and emitted `[REDACTED]` markers are shielded using control bytes absent from
 * every secret so neither literal markers nor non-secret control bytes are mangled. */
export function redactionSedScript(secrets: readonly string[]): string {
  const lines = sortedSecretLines(secrets);

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

    if (secret.length <= 512) {
      for (let len = secret.length - 1; len >= 1; len--) {
        const prefix = secret.slice(0, len);
        const suffix = secret.slice(secret.length - len);

        if (prefix !== marker) rules.push(`s|${shield(prefix)}$|${replacement}|`);

        if (suffix !== marker) rules.push(`s|^${shield(suffix)}|${replacement}|`);
      }
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
    // Keep every single record well under the 32 KiB log-page lookbehind by splitting long lines
    // into <= 8 KiB partial (`o`/`e`) records followed by the final record marker.
    `if [ "\${#2}" -le 4096 ]`,
    `then printf '%s%s\\n' "$1" "$2" >> ${file.log}`,
    `else case "$1" in O|o) pm=o;; *) pm=e;; esac`,
    `printf '%s' "$2" | { prev=`,
    `while :`,
    `do seg=$(dd bs=8192 count=1 2>/dev/null; printf .)`,
    `seg=\${seg%.}`,
    `if [ -z "$seg" ]`,
    `then [ -z "$prev" ] || printf '%s%s\\n' "$1" "$prev" >> ${file.log}`,
    `break`,
    `fi`,
    `need=0`,
    `for byte in $(printf '%s' "$seg" | tail -c 4 | od -An -tu1)`,
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
    `seg="$seg$rest"`,
    `fi`,
    `[ -z "$prev" ] || printf '%s%s\\n' "$pm" "$prev" >> ${file.log}`,
    `prev=$seg`,
    `done; }`,
    `fi`,
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
 * and redacts with the sed script before anything reaches the log. When `holdBytes > 0`,
 * trailing bytes of an incomplete line are carried into the next read so secrets longer than
 * 512 bytes are redacted in full across chunk boundaries. A full line is recorded under the
 * upper-case marker, a trailing partial line under the lower-case one. */
function streamReader(input: {
  marker: "O" | "E";
  fifo: string;
  sedPath: string;
  holdBytes: number;
  secretsPath?: string;
}): string {
  // Fast single-sed path when every secret is <= 512 bytes (prefix/suffix rules are in redact.sed).
  if (input.holdBytes <= 0) {
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

  // Carry-window path when any secret line exceeds 512 bytes:
  // 1) Scrub secrets wrapped across newlines in `head`, holding trailing wrapped-prefix lines (>= 8 bytes) across reads.
  // 2) Keep any partial trailing line raw while checking suffix-prefix overlap before sed can rewrite a shorter inner secret.
  const wrapAwk = [
    `FILENAME!="-"{if(length($0)>1){rm="[REDACTED][REDACTED]";while(length(rm)<length($0)+20)rm=rm rm;if(index(rm,$0)==0)s[++n]=$0}next}`,
    `{L[++m]=$0}`,
    `END{`,
    `for(i=1;i<=n;i++){`,
    `sec=s[i];sl=length(sec);c1=substr(sec,1,1);`,
    `for(a=1;a<m;a++){`,
    `la=L[a];al=length(la);if(al==0)continue;`,
    `lim=al<sl-1?al:sl-1;scan=al-lim+1;`,
    `while(scan<=al){`,
    `off=index(substr(la,scan),c1);if(off==0)break;`,
    `idx=scan+off-1;p=al-idx+1;`,
    `if(substr(la,idx,p)==substr(sec,1,p)){`,
    `pos=p+1;b=a+1;ok=0;`,
    `while(b<=m){rem=sl-pos+1;lb=L[b];bl=length(lb);`,
    `if(bl>=rem){if(substr(lb,1,rem)==substr(sec,pos,rem))ok=1;break}`,
    `if(bl>0&&substr(sec,pos,bl)==lb){pos+=bl;b++}else break}`,
    `if(ok){L[a]=substr(la,1,al-p) "[REDACTED]";for(k=a+1;k<b;k++)L[k]="[REDACTED]";L[b]="[REDACTED]" substr(L[b],rem+1);break}}`,
    `scan=idx+1}}}`,
    // Check length(acc) >= mh before prepending L[k] so a starting line with a non-secret prefix is still held.
    `hc=0;`,
    `if(!eof&&n>0&&m>0){`,
    `acc="";`,
    `for(k=m;k>=1;k--){`,
    `if(length(acc)>=mh)break;`,
    `acc=L[k] acc;al=length(acc);`,
    `if(al>=2){hit=0;`,
    `for(i=1;i<=n;i++){`,
    `sec=s[i];sl=length(sec);minp=sl<16?sl-1:8;if(minp<2)minp=2;if(al<minp)continue;c1=substr(sec,1,1);`,
    `lim=al<sl-1?al:sl-1;scan=al-lim+1;`,
    `while(scan<=al){`,
    `off=index(substr(acc,scan),c1);if(off==0)break;`,
    `idx=scan+off-1;p=al-idx+1;`,
    `if(p>=minp&&substr(acc,idx,p)==substr(sec,1,p)){hc=m-k+1;hit=1;break}`,
    `scan=idx+1}`,
    `if(hit)break}}}}`,
    `print hc;for(j=1;j<=m;j++)print L[j]}`,
  ].join("");

  const holdAwk = [
    `BEGIN{mk="[REDACTED]";ml=length(mk)}`,
    `FILENAME!="-"{`,
    `if(length($0)>1)s[++n]=$0;`,
    `p=index($0,mk);if(p>1)lb[++nlb]=substr($0,1,p-1);`,
    `for(o=1;o<ml&&o<length($0);o++){if(substr(mk,1,o)==substr($0,length($0)-o+1,o))lb[++nlb]=substr($0,1,length($0)-o)}`,
    `next}`,
    `{t=$0;tl=length(t);k=0;`,
    `for(i=1;i<=n;i++){p=s[i];pl=length(p);m=tl<pl-1?tl:pl-1;`,
    `for(j=m;j>k;j--){if(substr(t,tl-j+1,j)==substr(p,1,j)){k=j;break}}}`,
    // Extend carry past left-of-marker prefixes and past any greedy left-to-right secret match crossing el.
    `if(k>0){c=1;while(c){c=0;`,
    `if(nlb>0&&k<mh){r=tl-k;for(i=1;i<=nlb;i++){bl=length(lb[i]);`,
    `if(bl>0&&bl<=r&&k+bl<=mh&&substr(t,r-bl+1,bl)==lb[i]){k+=bl;c=1;break}}}`,
    `if(c)continue;`,
    `el=tl-k;if(el<=0)break;`,
    `for(i=1;i<=n;i++){p=s[i];pl=length(p);if(pl<2)continue;`,
    `cur=1;`,
    `while(cur<=el){`,
    `off=index(substr(t,cur),p);`,
    `if(off==0)break;`,
    `ms=cur+off-1;me=ms+pl-1;`,
    `if(ms>el)break;`,
    `if(me>el){k=tl-ms+1;el=ms-1;c=1;break}`,
    `cur=me+1}`,
    `if(c)break}}}`,
    `print k}`,
  ].join("");

  const computeHold = input.secretsPath
    ? [
        `if [ "$has_awk" -eq 1 ]`,
        `then clen=$(printf '%s\\n' "$chunk" | LC_ALL=C awk -v mh=${input.holdBytes} '${holdAwk}' ${quote(input.secretsPath)} - 2>/dev/null)`,
        `clen=\${clen:--1}`,
        `else clen=-1`,
        `fi`,
      ]
    : [`clen=-1`];

  // Pure POSIX sh fallback for newline-wrapped secret scrubbing when awk is absent.
  const scrubWrappedShDef = input.secretsPath
    ? [
        `scrub_wrapped_sh() { _sw_text=$1; _sw_eof=$2`,
        `case "$_sw_text" in *"$nl"*) _sw_flat=$(printf '%s' "$_sw_text" | tr -d '\\n');; *) _sw_flat=$_sw_text;; esac`,
        `while IFS= read -r _sw_sec || [ -n "$_sw_sec" ]`,
        `do [ "\${#_sw_sec}" -ge 2 ] || continue`,
        `_sw_rm="[REDACTED][REDACTED]"`,
        `while [ "\${#_sw_rm}" -lt $((\${#_sw_sec}+20)) ]; do _sw_rm="$_sw_rm$_sw_rm"; done`,
        `case "$_sw_rm" in *"$_sw_sec"*) continue;; esac`,
        `_sw_iter=0`,
        `while :`,
        `do case "$_sw_flat" in *"$_sw_sec"*) _sw_iter=$((_sw_iter+1))`,
        `if [ "$_sw_iter" -gt 256 ]; then _sw_text="[REDACTED]"; _sw_flat="[REDACTED]"; break; fi`,
        `_sw_pre=\${_sw_flat%%"$_sw_sec"*}`,
        `_sw_s=\${#_sw_pre}; _sw_e=$((_sw_s+\${#_sw_sec}))`,
        `_sw_rest=$_sw_text; _sw_off=0; _sw_out=; _sw_first=1`,
        `while :`,
        `do case "$_sw_rest" in *"$nl"*) _sw_l=\${_sw_rest%%"$nl"*}; _sw_rest=\${_sw_rest#*"$nl"}; _sw_more=1;; *) _sw_l=$_sw_rest; _sw_rest=; _sw_more=0;; esac`,
        `_sw_ll=\${#_sw_l}; _sw_end=$((_sw_off+_sw_ll))`,
        `if [ "$_sw_end" -le "$_sw_s" ] || [ "$_sw_off" -ge "$_sw_e" ]`,
        `then :`,
        `elif [ "$_sw_off" -le "$_sw_s" ] && [ "$_sw_end" -ge "$_sw_e" ]`,
        `then _sw_l="\${_sw_l%%"$_sw_sec"*}[REDACTED]\${_sw_l#*"$_sw_sec"}"`,
        `elif [ "$_sw_off" -le "$_sw_s" ]`,
        `then _sw_kn=$((_sw_s-_sw_off))`,
        `if [ "$_sw_kn" -gt 0 ]; then _sw_p=$(printf '%s' "$_sw_l" | head -c "$_sw_kn"; printf .); _sw_l="\${_sw_p%.}[REDACTED]"; else _sw_l="[REDACTED]"; fi`,
        `elif [ "$_sw_end" -ge "$_sw_e" ]`,
        `then _sw_sn=$((_sw_e-_sw_off)); _sw_kt=$((_sw_ll-_sw_sn))`,
        `if [ "$_sw_kt" -gt 0 ]; then _sw_t=$(printf '%s' "$_sw_l" | tail -c "$_sw_kt"; printf .); _sw_l="[REDACTED]\${_sw_t%.}"; else _sw_l="[REDACTED]"; fi`,
        `else _sw_l="[REDACTED]"`,
        `fi`,
        `if [ "$_sw_first" -eq 1 ]; then _sw_out=$_sw_l; _sw_first=0; else _sw_out="$_sw_out$nl$_sw_l"; fi`,
        `_sw_off=$_sw_end`,
        `[ "$_sw_more" -eq 1 ] || break`,
        `done`,
        `if [ "$_sw_out" = "$_sw_text" ]; then _sw_text="[REDACTED]"; _sw_flat="[REDACTED]"; break; fi`,
        `_sw_text=$_sw_out`,
        `_sw_flat=$(printf '%s' "$_sw_text" | tr -d '\\n');`,
        `*) break;`,
        `esac`,
        `done`,
        `done < ${quote(input.secretsPath)}`,
        `_sw_hold=0`,
        `if [ "$_sw_eof" -eq 0 ] && [ "\${#_sw_flat}" -le 1048576 ]`,
        `then while IFS= read -r _sw_sec || [ -n "$_sw_sec" ]`,
        `do [ "\${#_sw_sec}" -ge 8 ] || continue`,
        `_sw_rm="[REDACTED][REDACTED]"`,
        `while [ "\${#_sw_rm}" -lt $((\${#_sw_sec}+20)) ]; do _sw_rm="$_sw_rm$_sw_rm"; done`,
        `case "$_sw_rm" in *"$_sw_sec"*) continue;; esac`,
        `_sw_p8=$(printf '%s' "$_sw_sec" | head -c 8)`,
        `case "$_sw_flat" in *"$_sw_p8"*) _sw_aft=\${_sw_flat##*"$_sw_p8"}`,
        `if [ $(( \${#_sw_aft} + 8 )) -lt "\${#_sw_sec}" ]; then _sw_hold=1; break; fi;`,
        `esac`,
        `done < ${quote(input.secretsPath)}`,
        `fi; }`,
      ]
    : [];

  const scrubWrappedHead = input.secretsPath
    ? [
        `hcnt=0`,
        `emit_head=1`,
        `if [ "$has_awk" -eq 1 ]`,
        `then wrapped=$(printf '%s\\n' "$head" | LC_ALL=C awk -v mh=${input.holdBytes} -v eof=0 '${wrapAwk}' ${quote(input.secretsPath)} - 2>/dev/null; printf .)`,
        `wrapped=\${wrapped%.}`,
        `if [ -n "$wrapped" ]`,
        `then hcnt=\${wrapped%%"$nl"*}`,
        `head=\${wrapped#*"$nl"}`,
        `head=\${head%"$nl"}`,
        `fi`,
        `else scrub_wrapped_sh "$head" 0`,
        `head=$_sw_text`,
        `if [ "$_sw_hold" -eq 1 ]`,
        `then held_h=$head`,
        `head=`,
        `emit_head=0`,
        `else held_h=`,
        `fi`,
        `fi`,
        `if [ "$hcnt" -gt 0 ]`,
        `then total_l=$(printf '%s\\n' "$head" | wc -l)`,
        `keep_l=$((total_l-hcnt))`,
        `if [ "$keep_l" -gt 0 ]`,
        `then emit_h=$(printf '%s\\n' "$head" | head -n "$keep_l"; printf .)`,
        `emit_h=\${emit_h%.}`,
        `emit_h=\${emit_h%"$nl"}`,
        `held_h=$(printf '%s\\n' "$head" | tail -n "$hcnt"; printf .)`,
        `held_h=\${held_h%.}`,
        `held_h=\${held_h%"$nl"}`,
        `head=$emit_h`,
        `else held_h=$head`,
        `head=`,
        `emit_head=0`,
        `fi`,
        `elif [ "$emit_head" -eq 1 ]`,
        `then held_h=`,
        `fi`,
      ]
    : [`held_h=`, `emit_head=1`];

  const eofFlush = input.secretsPath
    ? [
        `if [ -n "$carry" ]`,
        `then if [ "$has_awk" -eq 1 ]`,
        `then wrapped=$(printf '%s\\n' "$carry" | LC_ALL=C awk -v mh=${input.holdBytes} -v eof=1 '${wrapAwk}' ${quote(input.secretsPath)} - 2>/dev/null; printf .)`,
        `wrapped=\${wrapped%.}`,
        `if [ -n "$wrapped" ]`,
        `then carry=\${wrapped#*"$nl"}`,
        `carry=\${carry%"$nl"}`,
        `fi`,
        `else scrub_wrapped_sh "$carry" 1`,
        `carry=$_sw_text`,
        `fi`,
        `printf '%s\\n' "$carry" | sed -f ${quote(input.sedPath)} | { _ef_has=0; _ef_prev=`,
        `while IFS= read -r line`,
        `do if [ "$_ef_has" -eq 1 ]; then append ${input.marker} "$_ef_prev"; fi`,
        `_ef_prev=$line; _ef_has=1`,
        `done`,
        `if [ "$_ef_has" -eq 1 ] && [ -n "$_ef_prev" ]; then append ${input.marker.toLowerCase()} "$_ef_prev"; fi; }`,
        `fi`,
      ]
    : [
        `if [ -n "$carry" ]`,
        `then chunk=$(printf '%s\\n' "$carry" | sed -f ${quote(input.sedPath)}; printf .)`,
        `chunk=\${chunk%.}`,
        `chunk=\${chunk%"$nl"}`,
        `[ -z "$chunk" ] || append ${input.marker.toLowerCase()} "$chunk"`,
        `fi`,
      ];

  const partialTailLines = [
    `if [ -n "$held_h" ]`,
    `then carry="$held_h$nl$chunk"`,
    `if [ "\${#carry}" -gt 1048576 ]`,
    `then drop_line=1`,
    `carry=`,
    `fi`,
    `elif [ -n "$chunk" ]`,
    `then tlen=\${#chunk}`,
    ...computeHold,
    `if [ "$clen" -lt 0 ]`,
    `then if [ "$tlen" -gt 1048576 ]`,
    `then drop_line=1`,
    `carry=`,
    `else carry=$chunk`,
    `fi`,
    `elif [ "$clen" -le 0 ]`,
    `then emit=$(printf '%s\\n' "$chunk" | sed -f ${quote(input.sedPath)}; printf .)`,
    `emit=\${emit%.}`,
    `emit=\${emit%"$nl"}`,
    `[ -z "$emit" ] || append ${input.marker.toLowerCase()} "$emit"`,
    `elif [ "$tlen" -gt "$clen" ]`,
    `then elen=$((tlen-clen))`,
    `while [ "$elen" -gt 0 ]`,
    `do b=$(printf '%s' "$chunk" | tail -c "$clen" | head -c 1 | od -An -tu1)`,
    `b=\${b##* }`,
    `if [ -n "$b" ] && [ "$b" -ge 128 ] && [ "$b" -lt 192 ]`,
    `then elen=$((elen-1))`,
    `clen=$((clen+1))`,
    `else break`,
    `fi`,
    `done`,
    `if [ "$elen" -gt 0 ]`,
    `then emit=$(printf '%s' "$chunk" | head -c "$elen"; printf .)`,
    `emit=\${emit%.}`,
    `emit=$(printf '%s\\n' "$emit" | sed -f ${quote(input.sedPath)}; printf .)`,
    `emit=\${emit%.}`,
    `emit=\${emit%"$nl"}`,
    `[ -z "$emit" ] || append ${input.marker.toLowerCase()} "$emit"`,
    `fi`,
    `carry=$(printf '%s' "$chunk" | tail -c "$clen"; printf .)`,
    `carry=\${carry%.}`,
    `else carry=$chunk`,
    `fi`,
    `fi`,
  ];

  return [
    `(LC_ALL=C`,
    `export LC_ALL`,
    `has_awk=0`,
    `command -v awk >/dev/null 2>&1 && has_awk=1`,
    `nl=$(printf '\\nX')`,
    `nl=\${nl%X}`,
    ...scrubWrappedShDef,
    `carry=`,
    `drop_line=0`,
    `while :`,
    `do raw=$(dd bs=4096 count=1 2>/dev/null; printf .)`,
    `raw=\${raw%.}`,
    `if [ -z "$raw" ]`,
    `then if [ "$drop_line" -eq 1 ]`,
    `then append ${input.marker.toLowerCase()} "[REDACTED]"`,
    `else ${eofFlush.join("; ")}`,
    `fi`,
    `break`,
    `fi`,
    // Count the continuation bytes still owed by a multi-byte character at the chunk's end.
    `need=0`,
    `for byte in $(printf '%s' "$raw" | tail -c 4 | od -An -tu1)`,
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
    `raw="$raw$rest"`,
    `fi`,
    // When an incomplete line exceeded 1 MiB, suppress the remainder of that line until newline or EOF.
    `if [ "$drop_line" -eq 1 ]`,
    `then case "$raw" in *"$nl"*) append ${input.marker} "[REDACTED]"`,
    `drop_line=0`,
    `raw=\${raw#*"$nl"}`,
    `[ -n "$raw" ] || continue;`,
    `*) continue;`,
    `esac`,
    `fi`,
    `chunk="$carry$raw"`,
    `carry=`,
    `held_h=`,
    // Redact complete lines in one pass (with wrapped-secret detection); keep any partial
    // trailing line raw so suffix-prefix carry matching runs before sed can rewrite a shorter secret.
    `case "$chunk" in *"$nl"*) tail=\${chunk##*"$nl"}`,
    `head=\${chunk%"$nl$tail"}`,
    ...scrubWrappedHead,
    `if [ "$emit_head" -eq 1 ]`,
    `then printf '%s\\n' "$head" | sed -f ${quote(input.sedPath)} | while IFS= read -r line`,
    `do append ${input.marker} "$line"`,
    `done`,
    `fi`,
    `chunk=$tail;`,
    `esac`,
    ...partialTailLines,
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
  holdBytes?: number;
  secretsPath?: string;
}): string {
  const file = records(input.dir);
  const holdBytes = input.holdBytes ?? 0;
  const secretsCleanup = input.secretsPath ? ` ${quote(input.secretsPath)}` : "";

  return [
    `chmod 600 ${quote(input.sedPath)}${secretsCleanup}`,
    // The sed program holds the secrets verbatim; drop it before the exit record says the process is done.
    `trap ${quote(`code=$?; rm -f ${quote(input.sedPath)}${secretsCleanup}; printf "%s" "$code" > ${file.exit}`)} EXIT`,
    `trap 'exit 143' TERM`,
    `${appendFunction(input.dir)} rm -f ${file.stdout} ${file.stderr}`,
    `mkfifo ${file.stdout} ${file.stderr}`,
    `${streamReader({ marker: "O", fifo: `${input.dir}/stdout`, sedPath: input.sedPath, holdBytes, secretsPath: input.secretsPath })} out=$!`,
    `${streamReader({ marker: "E", fifo: `${input.dir}/stderr`, sedPath: input.sedPath, holdBytes, secretsPath: input.secretsPath })} err=$!`,
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
  // A stop() that ran after setup recorded an exit; report it instead of starting the command.
  const stopped = `if [ -f ${file.exit} ]; then cat ${file.exit}; exit 0; fi`;
  const launch = `nohup setsid sh -c ${quote(input.supervisor)} > /dev/null 2>&1 < /dev/null & echo $! > ${file.pid}`;

  if (!input.waitForExit) return `${stopped}; ${launch}`;

  return [
    stopped,
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
