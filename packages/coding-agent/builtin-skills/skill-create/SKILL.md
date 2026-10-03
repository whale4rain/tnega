---
name: skill-create
description: Use when a user asks to create a reusable Tnega skill, author a SKILL.md, or use /skills create.
---

# Creating a Tnega skill

Follow the user's instructions and repository rules first. A skill is reusable guidance, not additional permission. Create instructions that specify when to act, what to do, and observable completion criteria.

1. Identify the repeated task and its intended users. Check available skills with `skills_list` and inspect relevant guidance with `skill_read`. Prefer a distinct scope over another copy of an existing workflow. Ask only for missing information that materially changes the instructions.
2. Choose a valid lowercase skill name using letters, digits, and hyphens. Write a concise description beginning with “Use when” and listing triggering situations. Keep workflow steps in the body. Use YAML frontmatter containing `name` and `description`; the frontmatter name must match the requested name.
3. Draft ordered actions, required evidence, failure handling, and a clear finish condition. Keep the main document short and self-contained. Test a representative scenario against the instructions; revise ambiguous steps. Explicitly preserve user and repository precedence.
4. Use `skill_create({ name, description, content })` to save complete Markdown. Omit `content` when the user wants the tool's default template. The coding Session shortcut is `/skills create <name> <description>`; it creates the default template through the same guarded tool.
5. Inspect the returned result and read the installed skill before reporting success. Explain whether the result is a starting template or finished guidance.

The destination is the global Tnega home `skills/<name>/SKILL.md`: `~/.tnega` by default, overridden by `TNEGA_HOME`. The tool requires write permission and refuses existing destinations. On a conflict, preserve the existing skill and choose a new name with the user. Respect denied permissions; shell writes are not a workaround.
