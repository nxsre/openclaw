---
summary: "Adds agent-callable tools."
read_when:
  - You are installing, configuring, or auditing the memory-core plugin
title: "Memory Core plugin"
---

# Memory Core plugin

Adds agent-callable tools.

## Distribution

- Package: `@openclaw/memory-core`
- Install route: included in OpenClaw

## Surface

contracts: tools

## Dreaming and consolidation

Memory Core also owns the background **dreaming** sweep that promotes strong short-term signals into `MEMORY.md`. See [Dreaming](/concepts/dreaming).

Promotion is append-only by default. The xcph build adds an optional **MEMORY.md consolidation** pass that runs after deep-phase promotion to semantically merge duplicate or outdated facts. It is gated by two environment switches (both off by default):

- `OPENCLAW_MEMORY_DREAMING_CONSOLIDATION` — `1` enables the merge pass.
- `OPENCLAW_MEMORY_DREAMING_CONSOLIDATION_DELETE` — `1` also allows deleting directly contradicted items.

Details and safety guardrails are in [Memory config — MEMORY.md consolidation](/reference/memory-config#memorymd-consolidation-env-switches) and [Dreaming](/concepts/dreaming).
