import { execFileSync } from "node:child_process";
import { expect, test } from "vitest";
import { quote } from "../src/shared/shell.js";

test("quote round-trips awkward strings through a real shell", () => {
  for (const value of ["", "plain", "it's", "a'b'c", "$HOME `id` $(id)", "line\nbreak", "\\"]) {
    expect(execFileSync("sh", ["-c", `printf '%s' ${quote(value)}`], { encoding: "utf8" })).toBe(
      value,
    );
  }
});
