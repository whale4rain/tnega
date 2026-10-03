---
name: planning-work
description: Use when work spans several dependent steps, requirements are unclear, a user requests a plan, or a task needs explicit acceptance criteria before execution.
---

# Planning work

A useful plan makes the next action clear and completion observable.

1. State the outcome, constraints, and evidence that will demonstrate success. Inspect the relevant Workspace files before choosing an implementation sequence. Identify uncertainties that could change the design or scope.
2. Divide the work into deliverable steps. For each step, identify the dependency, affected area, and acceptance check. Put shared interfaces and risky assumptions before dependent implementation. Size steps so one can be verified without finishing the entire task.
3. Resolve consequential unknowns through inspection or a focused user question. If a decision can wait, make that dependency explicit and continue independent work. Separate required work from optional improvements.
4. In a Tnega coding Session, `/plan` or Plan mode generates a plan without implementing it. Auto mode is appropriate for ordinary authorized execution. Goal mode supports a persistent objective; use the Session's available goal controls when the user requests that workflow.
5. During execution, update the plan when evidence changes the required work. Check acceptance criteria before marking a step complete, and report blocked dependencies accurately.

For example, an invoice change sharing checkout validation should first identify the common contract, then implement its consumer changes, then verify both flows. A planning-only request ends with the plan; a request to plan and implement continues into the authorized work when the current Session mode permits execution. If the Session is Plan-only, explain the required mode transition using its available controls. This skill does not itself change the Session mode or create a persistent Goal.
