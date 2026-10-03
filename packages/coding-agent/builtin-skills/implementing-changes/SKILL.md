---
name: implementing-changes
description: Use when a user asks to add a feature, change existing behavior, implement an agreed plan, or make a scoped code improvement in a repository.
---

# Implementing changes

Connect the requested behavior to the smallest coherent change and its verification.

1. Read repository instructions, the relevant package documentation, nearby implementation, and direct callers. Inspect the working-tree diff before editing so the user's existing work remains intact. Identify what the user will observe when the change is complete.
2. Follow existing interfaces and conventions. If the change affects a public contract, find its consumers and required compatibility behavior before editing. Resolve scope decisions that materially affect the product; choose routine implementation details from local evidence.
3. Make focused edits. Keep unrelated cleanup outside the change. For a behavior change, add or update a meaningful check for the observable outcome and relevant failure boundary. A reversible formatting or documentation adjustment usually needs inspection rather than a test that restates the edit.
4. Run the smallest sufficient checks using the repository's documented commands and available execution tools. Expand validation when the change crosses packages, affects public types, or changes build output. Distinguish a failing check introduced by this work from a baseline failure with evidence.
5. Inspect the final diff and confirm that the requested outcome, consumers, documentation, and checks agree. Commit only when requested or required by repository instructions. Inspect staged hunks, including overlapping files, so the commit contains only this task's changes and preserves the user's edits.

Report what changed, the verification performed, and remaining limits. If execution is unavailable, describe the checks that remain unrun rather than claiming they passed. Repository-specific rules take precedence over this general workflow.
