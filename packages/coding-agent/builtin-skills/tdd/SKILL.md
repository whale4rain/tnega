---
name: tdd
description: Use when a user requests test-driven development, red-green-refactor, or a test-first feature or bug fix.
---

# Test-driven development

Follow the user's instructions and repository rules first. Apply this workflow to observable behavior. For reversible documentation, formatting, or other low-impact changes, use proportionate inspection rather than tests that merely repeat the implementation.

1. Read the relevant implementation, callers, nearby tests, and documented test commands. State one behavior and the production defect that a test must detect. For a bug, reproduce the reported boundary, including concurrency or failure conditions when relevant.
2. Write the smallest test expressing that behavior through the existing public interface. Prefer real collaborators; substitute a dependency only when its external effects make a controlled test necessary. Assert outcomes and invariants rather than private structure or mock call sequences.
3. Run the focused test before implementation. Record its expected failure. Compilation errors, broken fixtures, and unrelated failures are not red evidence: correct the setup and run again. A test that already passes needs a different case or demonstrates existing behavior.
4. Implement only the behavior required to make the test pass. Run the focused test and relevant existing checks. Fix regressions before continuing.
5. Refactor after green: improve names, remove duplication, and simplify interfaces without adding behavior. Rerun affected checks after edits. Start another red cycle for another requirement.

For a duplicate-charge race, a passing checkout test is insufficient. First make two concurrent requests expose the duplicate effect; then verify the fix preserves exactly one charge and the expected responses.

Completion requires observed red and green results for the changed behavior, relevant checks passing, and a reviewed diff. Report executed commands and any unverified limitations. Time pressure is a reason to narrow the case, not to label tests written afterward as TDD.
