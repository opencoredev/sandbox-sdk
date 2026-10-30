"""Pure collection stop policy; callers own polling, signalling and output paths."""
import json
import sys


def stop_reasons(report):
    reasons = []
    if report.get("admissionStopped"):
        reasons.append("admissionStopped")
    # Absence resolutions remove the entry; history alone never authorizes deletion
    # or hides a newer unresolved entry with the same ID. Legacy entries are unresolved.
    unresolved = [entry for entry in report.get("cleanupReview", [])
                  if entry.get("status") != "checking" or report.get("finishedAt")]
    if unresolved:
        reasons.append("cleanupReview/quarantine")
    cost = sum((sample.get("estimatedCost") or 0) * (2 if sample["provider"] == "boxd" else 1)
               for sample in report.get("samples", [])
               if sample["scenario"].endswith("sandbox-lifetime"))
    if cost >= 100:
        reasons.append("modelled reserve >= $100")
    return reasons


if __name__ == "__main__":
    print(json.dumps(stop_reasons(json.load(sys.stdin))))
