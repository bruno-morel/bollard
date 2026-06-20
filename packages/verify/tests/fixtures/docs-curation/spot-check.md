# curate-docs spot-check packet (template)

Fill during a live `bollard curate-docs run` at the human gate. Do not commit raw LLM output unless sanitized.

| Edit ID | File | Rationale | Grounding quotes (verbatim) | Fact tokens in newText | Verdict |
|---------|------|-----------|----------------------------|------------------------|---------|
| d1 | README.md | (from plan) | (from plan) | (extractFactTokens) | keep/reject |

**Gate decision:** approve only if every row is factual improvement with zero invented claims.

**Post-apply:** `bollard audit-docs` must exit 0.
