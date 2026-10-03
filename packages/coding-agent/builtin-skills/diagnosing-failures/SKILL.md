---
name: diagnosing-failures
description: Use when behavior is broken, a test fails, a command throws, a service hangs, or a user reports a performance regression or intermittent problem.
---

# Diagnosing failures

Find the failing boundary before changing the implementation.

1. Capture the actual symptom: operation, input, expected result, observed result, environment, and time. Read the error and relevant logs. Preserve a minimal reproduction or failing check; yesterday's passing test is historical evidence, not a current verification.
2. Trace the request through its boundaries. Compare a failing case with a working case and inspect recent changes relevant to the divergence. For intermittent behavior, gather several observations with timestamps and conditions. For slowness, measure where elapsed time accumulates.
3. Form one concrete hypothesis and choose a discriminating observation. Instrument or run a bounded experiment using the available tools. Change one variable at a time so the result can support or reject that hypothesis.
4. Fix the demonstrated cause in the owning module. Preserve error reporting and cleanup behavior. If the tool is absent, permission is denied, or a sandbox is unavailable, report that boundary rather than treating it as evidence of an application defect.
5. Repeat the original reproduction and appropriate neighboring checks. When a full suite fails, compare against a known baseline before attributing every failure to the fix.

Finish with the cause, the observed evidence, the change, and current verification. If reproduction remains inconsistent, report the strongest supported hypothesis and what evidence is still missing. This skill does not authorize broad upgrades or unrelated refactoring.
