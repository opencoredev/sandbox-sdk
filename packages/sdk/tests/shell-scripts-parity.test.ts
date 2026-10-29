// Temporary parity check: the old inline scripts from processes.ts, copied verbatim.
import { expect, test } from "vitest";
import { quote } from "../src/shared/shell.js";
import {
  detachedLaunchScript,
  logPageScript,
  recordSetupScript,
  redactionSedScript,
  supervisorScript,
} from "../src/shell/process-records.js";

const dirs = ["/tmp/.sandbox-sdk/procs/dev", "/home/tenki/.sandbox-sdk/procs/it's-odd"];
const cwds = ["/workspace", "/workspace/my app/it's"];
const commands = ["echo READY; sleep 5", "printf '%s\\n' \"$X\" | tee 'a b'", "naïve ✓"];

function oldLog(dir: string, requested: number | undefined, lookaround: number, budget: number) {
  return `[ -f ${quote(`${dir}/spec.json`)} ] || exit 66; cat ${quote(`${dir}/spec.json`)} || exit 1; printf '\\000'; while ! mkdir ${quote(`${dir}/lock`)} 2>/dev/null; do sleep .01; done; trap 'rmdir ${quote(`${dir}/lock`)}' EXIT; b=$(cat ${quote(`${dir}/base`)}); n=$(wc -c < ${quote(`${dir}/out.log`)}); a=${requested ?? '"$b"'}; s=$((a-b-${lookaround})); [ "$s" -ge 0 ] || s=0; e=running; if [ -f ${quote(`${dir}/exit`)} ]; then e=$(cat ${quote(`${dir}/exit`)}); fi; printf '%s %s %s %s\\n' "$b" "$s" "$n" "$e"; dd if=${quote(`${dir}/out.log`)} bs=1 skip="$s" count=${budget + lookaround * 2} 2>/dev/null | base64`;
}

function oldSetup(dir: string, cwd: string) {
  return `mkdir -p ${quote(dir)} || exit 1; if [ -f ${quote(`${dir}/spec.json`)} ] && [ ! -f ${quote(`${dir}/exit`)} ]; then exit 73; fi; b=0; if [ -f ${quote(`${dir}/base`)} ]; then b=$(cat ${quote(`${dir}/base`)}); n=$(wc -c < ${quote(`${dir}/out.log`)}); b=$((b+n)); fi; IFS= read -r s && IFS= read -r r && printf '%s' "$s" | base64 -d > ${quote(`${dir}/spec.json`)} && (umask 077; printf '%s' "$r" | base64 -d > ${quote(`${dir}/restart.json`)}) && : > ${quote(`${dir}/out.log`)} && printf '%s' "$b" > ${quote(`${dir}/base`)} && rm -f ${quote(`${dir}/exit`)} || exit 1; m=$(cd ${quote(cwd)} 2>&1) && exit 0; c=$?; printf '%s\n' "$m" | sed 's/^/E/' > ${quote(`${dir}/out.log`)}; printf 0 > ${quote(`${dir}/pid`)}; printf '%s' "$c" > ${quote(`${dir}/exit`)}; exit 74`;
}

function oldWrapper(dir: string, cwd: string, command: string) {
  const sedPath = `${dir}/redact.sed`;
  const append = `append() { while ! mkdir ${quote(`${dir}/lock`)} 2>/dev/null; do sleep 0.01; done; printf '%s%s\\n' "$1" "$2" >> ${quote(`${dir}/out.log`)}; n=$(wc -c < ${quote(`${dir}/out.log`)}); if [ "$n" -gt 10485760 ]; then tail -c 5242880 ${quote(`${dir}/out.log`)} | tail -n +2 > ${quote(`${dir}/rotate`)}; kept=$(wc -c < ${quote(`${dir}/rotate`)}); b=$(cat ${quote(`${dir}/base`)}); echo $((b+n-kept)) > ${quote(`${dir}/base`)}; mv ${quote(`${dir}/rotate`)} ${quote(`${dir}/out.log`)}; fi; rmdir ${quote(`${dir}/lock`)}; };`;

  const reader = (stream: string, fifo: string) =>
    `(nl=$(printf '\\nX'); nl=\${nl%X}; while :; do chunk=$(dd bs=4096 count=1 2>/dev/null; printf .); chunk=\${chunk%.}; [ -n "$chunk" ] || break; need=0; for byte in $(printf '%s' "$chunk" | tail -c 4 | od -An -tu1); do if [ "$byte" -ge 240 ]; then need=3; elif [ "$byte" -ge 224 ]; then need=2; elif [ "$byte" -ge 192 ]; then need=1; elif [ "$byte" -ge 128 ]; then [ "$need" -le 0 ] || need=$((need-1)); else need=0; fi; done; if [ "$need" -gt 0 ]; then rest=$(dd bs=1 count="$need" 2>/dev/null; printf .); rest=\${rest%.}; chunk="$chunk$rest"; fi; chunk=$(printf '%s\\n' "$chunk" | sed -u -f ${quote(sedPath)}; printf .); chunk=\${chunk%.}; chunk=\${chunk%"$nl"}; while [ -n "$chunk" ]; do case "$chunk" in *"$nl"*) line=\${chunk%%"$nl"*}; append ${stream} "$line"; chunk=\${chunk#*"$nl"};; *) append ${stream.toLowerCase()} "$chunk"; chunk=;; esac; done; done < ${quote(fifo)}) &`;

  return `chmod 600 ${quote(sedPath)}; trap 'code=$?; printf "%s" "$code" > ${quote(`${dir}/exit`)}' EXIT; trap 'exit 143' TERM; ${append} rm -f ${quote(`${dir}/stdout`)} ${quote(`${dir}/stderr`)}; mkfifo ${quote(`${dir}/stdout`)} ${quote(`${dir}/stderr`)}; ${reader("O", `${dir}/stdout`)} out=$!; ${reader("E", `${dir}/stderr`)} err=$!; { cd ${quote(cwd)} && sh -c ${quote(command)}; } > ${quote(`${dir}/stdout`)} 2> ${quote(`${dir}/stderr`)}; code=$?; wait "$out" "$err"; exit "$code"`;
}

function oldLaunch(dir: string, wrapper: string, ready: boolean) {
  const check = ready
    ? ""
    : `; i=0; while [ "$i" -lt 10 ] && [ ! -f ${quote(`${dir}/exit`)} ]; do sleep 0.01; i=$((i+1)); done; cat ${quote(`${dir}/exit`)} 2>/dev/null; true`;

  return `nohup setsid sh -c ${quote(wrapper)} > /dev/null 2>&1 < /dev/null & echo $! > ${quote(`${dir}/pid`)}${check}`;
}

test("process record scripts keep their exact bytes", () => {
  for (const dir of dirs) {
    for (const after of [undefined, 0, 123_456])
      expect(logPageScript({ dir, after, lookbehind: 32_770, length: 16384 + 65_540 })).toBe(
        oldLog(dir, after, 32_770, 16384),
      );

    for (const cwd of cwds) {
      expect(recordSetupScript({ dir, cwd })).toBe(oldSetup(dir, cwd));

      for (const command of commands) {
        const supervisor = supervisorScript({ dir, cwd, command, sedPath: `${dir}/redact.sed` });
        expect(supervisor).toBe(oldWrapper(dir, cwd, command));

        for (const ready of [true, false])
          expect(detachedLaunchScript({ dir, supervisor, waitForExit: !ready })).toBe(
            oldLaunch(dir, supervisor, ready),
          );
      }
    }
  }
});

function oldSed(secrets: string[]) {
  const patterns = secrets.flatMap((secret) => secret.split("\n")).filter(Boolean);

  return (
    patterns
      .flatMap((secret) => {
        const escape = (text: string) => text.replace(/[\\[\].*^$|]/g, "\\$&");

        return [
          `s|${escape(secret)}|[REDACTED]|g`,
          ...Array.from({ length: secret.length - 1 }, (_, index) => [
            `s|${escape(secret.slice(0, secret.length - 1 - index))}$|[REDACTED]|`,
            `s|^${escape(secret.slice(index + 1))}|[REDACTED]|`,
          ]).flat(),
        ];
      })
      .join("\n") + "\n"
  );
}

test("redaction sed program keeps its exact bytes", () => {
  for (const secrets of [[], ["a"], ["s3cr3t"], ["multi\nline", "", "a|b.c*d[e]^$\\f"], ["ünï"]])
    expect(redactionSedScript(secrets)).toBe(oldSed(secrets));
});
