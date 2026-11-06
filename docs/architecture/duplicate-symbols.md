<!-- repo-map:no-verification -->
<!-- GENERATED FILE -- do not edit by hand.
     Regenerate with `repo-tools map`. -->

# Duplicate Symbols

A name is listed here when two or more distinct files across the monorepo define it. A file that only re-exports the name does not count. Each name carries one tag (see `DupEntryTag`), so the actionable subset is clear:

- `TRUE_DUPLICATE`: a real merge target.
- `DISPATCH_VARIANT`: two or more `mathTyped(...)` registrations of the same public name. The registrations are distinct dispatch surfaces, not copy-paste bodies.
- `ALIAS_DELEGATION`: a `const X = importedY` forward. The entry is excluded once fewer than two real bodies remain.
- `ALLOWLISTED`: the name matches `duplicate-allowlist.json`. Examples are hot-path `is*` guards, mirrors in another language and per-package `VERSION` strings.

> **Note:** This report groups names by OWN definition, not by call graph, then classifies each flagged name (see DupEntryTag): TRUE_DUPLICATE (the actionable merge targets), DISPATCH_VARIANT (>=2 mathTyped(...) registrations of the same public name — distinct dispatch surfaces, not copy-paste bodies), ALIAS_DELEGATION (a const-alias forward to an imported symbol, not an independent body — excluded once fewer than 2 real bodies remain), and ALLOWLISTED (matches duplicate-allowlist.json: for example hot-path is* guards, mirrors in another language, per-package VERSION strings). NOT detected: same-file typed-dispatch overload polymorphism for different argument shapes within one registration — a human still triages TRUE_DUPLICATE entries using the defining files + public flags before merging anything.

## Summary — runtime (function/constant/class)

| Category | Count |
| --- | --: |
| **TRUE_DUPLICATE** (actionable) | 1 |
| DISPATCH_VARIANT | 0 |
| ALIAS_DELEGATION | 0 |
| ALLOWLISTED | 0 |
| _Total flagged names_ | 1 |

## Summary — types (interface/type/enum)

| Category | Count |
| --- | --: |
| **TRUE_DUPLICATE** (actionable) | 3 |
| DISPATCH_VARIANT | 0 |
| ALIAS_DELEGATION | 0 |
| ALLOWLISTED | 0 |
| _Total flagged names_ | 3 |

## Runtime duplicates

### TRUE_DUPLICATE — actionable merge targets

| Name | Category | Defining files (package, public?, sub-tag) | Canonical hint |
| --- | --- | --- | --- |
| `redactPii` | function | `src/learn/learn-inject.ts` (unknown, internal, PLAIN)<br>`src/learn/pii-redactor.ts` (unknown, internal, PLAIN) | `internal-only` |

### DISPATCH_VARIANT — distinct public typed-dispatch surfaces

_None._

### ALIAS_DELEGATION — const-alias forwards (not independent bodies)

_None._

### ALLOWLISTED — accepted layering (see duplicate-allowlist.json)

_None._

## Type duplicates (lower priority)

### TRUE_DUPLICATE

| Name | Category | Defining files (package, public?, sub-tag) | Canonical hint |
| --- | --- | --- | --- |
| `PidRegistry` | interface | `src/learn/agent-runner.ts` (unknown, internal, PLAIN)<br>`src/learn/learn-lock.ts` (unknown, internal, PLAIN) | `internal-only` |
| `ProcSnapshot` | interface | `src/learn/agent-runner.ts` (unknown, internal, PLAIN)<br>`src/orphan-reaper.ts` (unknown, internal, PLAIN) | `internal-only` |
| `SearchOptions` | interface | `src/learn/knowledge-store.ts` (unknown, internal, PLAIN)<br>`src/search.ts` (unknown, public, PLAIN) | `src/search.ts` |

### DISPATCH_VARIANT

_None._

### ALIAS_DELEGATION

_None._

### ALLOWLISTED

_None._
