# Proposal: carve the tier-2+ interaction-framework preamble into on-demand `sections/`

Prepared 2026-07-05 for garrytan/gstack. **Status: proposal for maintainer
buy-in on #1572 before implementation — not a ready-to-merge branch.** See
"Why proposal-first" below.

Relates to: **#1572** (skill: cache preamble bash output within session to
reduce duplication). Adjacent open work: #2001/#2022 (gate upgrade prose),
#1150/#1188 (gate telemetry preamble), #1972 (shrink skill descriptions).
None carve the interaction-framework prose; this proposal is complementary.

## Problem (measured on v1.58.5.0, `11de390b`, host=claude, interactive)

Every `~/.claude/skills/<name>/SKILL.md` is a symlink to generated output;
each is dominated by `{{PREAMBLE}}`, composed in `scripts/resolvers/preamble.ts`.

| Tier | Rendered preamble | ~tokens (4 B/tok) | # skills |
|------|-------------------|-------------------|----------|
| 1 | 25,690 B | ~6.4k | 6 |
| 2 | 45,295 B | ~11.3k | 16 |
| 3–4 | 46,336 B | ~11.6k | 22 |

A tier-2 skill like `context-save` (54,971 B total) is **84% preamble**.
Install-wide, ~1.9 MB of ~3.57 MB of SKILL.md bytes is the same preamble
duplicated ~44× (~53%). Every gstack skill invocation pays ~11k tokens of
preamble before its own body.

Per-section breakdown of the tier-4 preamble prose (rendered bytes):

| Section | Bytes | Nature |
|---|---|---|
| ask-user-format | 10,546 | prose — **ordering-sensitive, keep inline** |
| plan-mode-info | 2,888 | prose + env contract |
| question-tuning | 2,494 | prose |
| context-recovery | 2,378 | prose |
| writing-style | 1,113 | prose |
| continuous-checkpoint | 922 | prose |
| completeness / confusion / context-health / repo-mode / search | ~9,000 | prose |

The functional bash (preamble-bash 6.2k, brain-sync 5.8k, upgrade-check 1.2k),
one-time onboarding gates, and model overlay are NOT prose and stay inline.

## Proposal

Extend the repo's **existing** on-demand carve mechanism — `sections/*.md`
generated for the Claude host, `{{SECTION:id}}` inlined for every other host
(`discoverSectionTemplates` in `scripts/discover-skills.ts`; live precedents
`plan-eng-review/sections/`, `qa/references/`) — to the tier-2+
interaction-framework prose.

Move these generators' output into a generated shared
`<skill>/sections/interaction-framework.md`, leaving a 2–3 line inline pointer
("Read `~/.claude/skills/gstack/<skill>/sections/interaction-framework.md`
before your first AskUserQuestion / when the framework applies"):

- `writing-style`, `completeness`, `confusion-protocol`, `context-health`,
  `context-recovery`, `continuous-checkpoint`, `question-tuning` (tier 2+)
- `repo-mode`, `search-before-building` (tier 3+)

**Explicitly kept inline: `ask-user-format`.** `preamble.ts` documents that it
must render before the model overlay ("reversing this order regresses
plan-review cadence — v1.6.4.0 bug"). Carving it to an on-demand Read would
remove the ambient pacing directive the overlay depends on. It stays inline;
this proposal does not touch it.

This is the same Claude-host-only change shape as the existing carves: content
still reaches the model, on-demand via a Read pointer instead of inline. Other
hosts inline via `{{SECTION:id}}` and are byte-unchanged.

There is already a lighter precedent for this exact prose set:
`--explain-level=terse` (`ctx.explainLevel === 'terse'`) compresses
writing-style/completeness/confusion-protocol/context-health to pointer lines,
but only as an opt-in build flag saving ~2.2 KB. This proposal makes the
on-demand carve the default via the proven `sections/` path.

## Estimated savings

- ~10–20.5 KB relocated per tier-2+ invocation ≈ **~2.5–5.1k tokens** lighter
  (preamble drops ~22–44%; `context-save` 55 → ~40–34 KB, `qa` 84 → ~73–63 KB).
- Applies to 38 tier-2+ skills. Tier-1 unaffected. ~0.8 MB less duplicated
  preamble on disk.
- Upper bound assumes ask-user-format is *also* carved later (separate change,
  needs the ordering invariant re-homed first) — this PR targets the safe
  ~10 KB subset.

## Why proposal-first (not a blind fork PR)

1. **Behaviour-sensitive module.** `preamble.ts` carries documented ordering
   invariants; a carve must preserve them. Wants a maintainer's eye.
2. **Verification is API-gated.** The real behaviour gate is `bun run
   test:evals` (EVALS=1, live model calls). The mechanical freshness gate
   `skill:check` is currently red on a clean checkout for an unrelated reason
   — `.gbrain/skills/*` stale under `gen:skill-docs --host gbrain` host
   detection — so a fork can't cleanly prove Claude-host equivalence in
   isolation.
3. **Active area.** #1572 is open and several preamble PRs are in flight;
   coordinating avoids a carve that collides with concurrent gating work.

## Suggested next step

Comment this proposal on **#1572** to get maintainer agreement on (a) the
`sections/interaction-framework.md` shape, (b) keeping `ask-user-format`
inline, (c) default-on vs behind `--explain-level`. On agreement, implement in
`scripts/resolvers/preamble.ts` + a new
`scripts/resolvers/preamble/generate-interaction-framework-section.ts` + the
`sections/` templates, regenerate, and gate on `test:evals`.

Full local investigation (per-section bytes, churn evidence, why fork-side
edits conflict on every rebase): `PREAMBLE-BLOAT-NOTES.md` in the maintainer's
gstack fork.

---

## Re-measured 2026-08-20 against v1.68.1.0

The numbers above were taken on v1.58.5.0. Upstream has shipped ten releases
since, including the v1.64.1.0 code-smell wave (net -24,943 lines) which
trimmed onboarding prose from eight utility skills. Re-measured to check
whether the problem had solved itself. It has not; it grew.

Method: group tracked `*/SKILL.md` by their `preamble-tier` frontmatter, then
take the MINIMUM shared content across pairs within each tier (difflib
matching blocks over lines). The minimum across unrelated pairs is the floor
of what every skill in that tier carries, so it cannot be inflated by two
sibling skills sharing body text.

| Tier | v1.58.5.0 | v1.68.1.0 | Change | Skills |
|---|---|---|---|---|
| 1 | 25,690 B | 27,742 B (~6.6k tok) | +8.0% | 8 |
| 2 | 45,295 B | 47,429 B (~11.3k tok) | +4.7% | 19 |
| 3 | 46,336 B | 48,432 B (~11.5k tok) | +4.5% | 15 |
| 4 | 46,336 B | 48,591 B (~11.5k tok) | +4.9% | 6 |

Duplicated preamble now accounts for roughly 2.14 MB of the 3.41 MB of tracked
`SKILL.md` bytes, or **63%**, up from ~53% at v1.58.5.0. Total tracked
`SKILL.md` bytes fell (3.57 MB to 3.41 MB) while the duplicated share rose,
which is the v1.64.1.0 trim landing on skill bodies rather than on the
preamble.

Tier 2 and above is now 40 skills, not 38.

The resolver set has also grown. `scripts/resolvers/preamble/` holds 25
generators, including several added since this proposal was written
(`generate-evidence-directive`, `generate-test-failure-triage`,
`generate-completion-status`, `generate-spawned-session-check`,
`generate-brain-health-instruction`). Each is prose that every tier-2+ skill
carries inline.

No carve has landed upstream: there is no `*/sections/interaction-framework.md`
in the tree at v1.68.1.0, and the `sections/` mechanism this proposal builds on
is unchanged.

### Measuring tool

v1.63.0.0 shipped `bin/gstack-context-bill`, a token bill-of-materials for a
skills tree. It did not exist when this proposal was written and it is now the
right instrument to cite. Its per-invoke figures on v1.68.1.0:

```
review        109.5KB (~26.6K tok)
office-hours  100.0KB (~24.3K tok)
setup-gbrain   94.1KB (~22.9K tok)
retro          93.0KB (~22.6K tok)
plan-ceo-review 91.4KB (~21.7K tok)
ship           89.1KB (~21.7K tok)
TOTAL on disk 6.4MB (~1645.0K tok) across 62 skills
```

Roughly half of each of those numbers is the shared preamble.

### Tracker state at 2026-08-20

- **#1572** still OPEN, last touched 2026-07-15. Its one comment (time-attack)
  objects that caching the preamble would cache mutable repository state and
  suppress required per-invocation side effects, and asks for the work to be
  limited to an explicitly pure data subset. That objection is about caching
  the preamble BASH. It does not apply to relocating prose, and the prose is
  precisely the "explicitly pure data subset" the comment asks for. This
  proposal is a cleaner answer to #1572's problem than #1572's own approach.
- **#2001** CLOSED. **#2022**, **#1150**, **#1188**, **#1972** still OPEN. None
  carves the interaction-framework prose, so the complementarity claim above
  still holds.
