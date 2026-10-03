---
name: reviewing-changes
description: Use when a user requests a code review, a review of a branch or patch, or an assessment of changes since a specified commit, tag, or branch.
---

# Reviewing changes

Review the actual change against its requirements and the repository's contracts.

1. Fix the comparison scope: base reference, current revision, and whether staged, unstaged, or new files are included. Resolve the named reference before inspecting the diff. Preserve the working tree; review is read-only unless the user also requests fixes.
2. Read the originating requirement and relevant repository instructions. Inspect the changed code, its callers, and neighboring tests. Follow a public interface or persistence change through direct consumers rather than evaluating the edited lines in isolation.
3. Look for observable defects: incorrect results, lost history, permission escapes, races, incomplete cleanup, incompatible contracts, and failures hidden by a happy-path test. Separate these from stylistic preferences and speculative concerns.
4. For each finding, establish the triggering input or sequence, resulting behavior, practical impact, and precise current file location. Use a small reproduction or targeted test when it will resolve uncertainty. Label anything that remains a hypothesis.
5. Report actionable findings in priority order, then the validation performed and material coverage gaps. If there are no supported findings, say so without implying that every possible behavior was tested.

A useful finding explains how a user reaches the failure and what contract needs to hold; it need not dictate a complete rewrite. This skill does not authorize committing changes, merging a branch, or publishing a release.
