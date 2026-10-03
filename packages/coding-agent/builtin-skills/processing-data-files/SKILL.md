---
name: processing-data-files
description: Use when a user asks to inspect, clean, transform, summarize, or validate CSV, TSV, JSON, JSONL, or spreadsheet files.
---

# Processing data files

Preserve the meaning of the data while making every transformation explainable.

1. Identify the format, encoding, size, schema, and requested output. Inspect representative records and the headers before choosing a parser. Check whether the file tools report truncated content; a prefix is not the complete dataset.
2. Preserve an original copy or write to a new output path. Keep identifiers such as `00123` as text. Establish date conventions, missing-value rules, units, and the key used to identify duplicate records. Resolve ambiguous rules before removing information.
3. Use a parser appropriate to the format. CSV and TSV may contain quoted delimiters and embedded newlines; splitting on commas or lines loses records. Validate each JSONL record independently. Use available `office_inspect` and `office_read` for `.xlsx`, then follow the actual `office_create` or `office_edit` schema for changes.
4. For large transformations, use an available execution tool and installed runtime rather than assuming Python, Node.js, or a particular library exists. PTC can orchestrate registered tools and transform bounded in-memory results; it has no direct filesystem access.
5. Validate record counts, required fields, preserved identifiers, representative edge cases, and totals before delivering. Reopen the output and report transformations, rejected records, and unresolved values. Distinguish sample checks from full validation. Save reusable transformation scripts or rules with the results when requested; if tools cannot process the full input, explain the limit instead of promising a complete output.

For deduplication, explain which key and retained-record rule were used. This skill covers file workflows; it does not imply a live spreadsheet connection or unlimited tool output.
