---
name: ddd
description: Use when a user requests domain-driven design, domain modeling, bounded contexts, or clearer business terminology and invariants.
---

# Domain-driven design

Follow the user's instructions and repository rules first. Build a model around demonstrated business decisions, using the smallest structure that expresses them. DDD is useful when rules or meanings are difficult to preserve; a simple data transformation can remain simple.

1. Read existing domain documentation and the implementation that owns the requested behavior. Collect concrete examples: actors, commands, outcomes, exceptional cases, and conflicting rules. Separate observed requirements from assumptions. Resolve uncertainty that changes behavior with the user while continuing independent inspection.
2. Establish shared vocabulary. Record each business term, its meaning, and the code or example supporting it. Reuse established names. If one term has different meanings across workflows, identify the boundary and how information crosses it rather than forcing a universal model.
3. State invariants and lifecycle transitions. Identify which changes must succeed together and where consistency can be delayed. Choose an aggregate boundary only when those rules justify one; distinguish domain events describing completed facts from transport messages.
4. Classify concepts by behavior. An entity needs identity that survives change. A value object is defined by its values and validation. Put a rule with the concept that owns it; use a domain service for a business operation that has no natural owner. Persistence and external adapters serve the model.
5. Validate the proposed model against normal, boundary, and failure scenarios. Explain which example each abstraction protects. Implement a small slice and verify the invariant through observable behavior.

For invoices, demonstrate why issued amounts cannot change and how cancellation works before introducing repositories or layers. A row in a database alone does not justify an entity or aggregate.

Deliver the vocabulary, invariants, boundaries, unresolved assumptions, and evidence for chosen structures. Update existing domain records when required; avoid speculative frameworks and unrelated restructuring.
