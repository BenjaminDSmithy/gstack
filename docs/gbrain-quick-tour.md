# GBrain with gstack: the quick tour

The short version of [USING_GBRAIN_WITH_GSTACK.md](../USING_GBRAIN_WITH_GSTACK.md), which has every scenario, flag, helper bin and troubleshooting step. This page is what the README used to say.

```bash
/setup-gbrain
```

Four paths, pick one:

- **Supabase, existing URL** — your cloud agent already provisioned a brain; paste the Session Pooler URL, now this laptop uses the same data.
- **Supabase, auto-provision** — paste a Supabase Personal Access Token; the skill creates a new project, polls to healthy, fetches the pooler URL, hands it to `gbrain init`. ~90 seconds end-to-end.
- **PGLite local** — zero accounts, zero network, ~30 seconds. Isolated brain on this Mac only. Great for try-first; migrate to Supabase later with `/setup-gbrain --switch`.
- **Remote gbrain MCP** — your brain runs on another machine (Tailscale, ngrok, internal LAN) or a teammate's server; paste an MCP URL and bearer token. Optionally pair with a local PGLite for symbol-aware code search in split-engine mode. Best for cross-machine memory without standing up a local DB.

After init, the skill offers to register gbrain as an MCP server for Claude Code (`claude mcp add gbrain -- gbrain serve`) so `gbrain search`, `gbrain put`, etc. show up as first-class typed tools — not bash shell-outs.

**Keeping the brain current.** Run `/sync-gbrain` from any repo to re-index its code into gbrain (incremental by default, `--full` for a full reindex, `--dry-run` to preview). The skill registers the cwd as a federated source via `gbrain sources add`, runs `gbrain sync` on the source's persisted strategy (`code` for a new source), and writes a `## GBrain Search Guidance` block to your project's CLAUDE.md so the agent prefers `gbrain search`/`code-def`/`code-refs` over Grep. The block is removed automatically if the capability check fails — no stale guidance pointing at tools that aren't installed.

**Per-remote trust policy.** Each repo on your machine gets one of three tiers:

- `read-write` — agent can search the brain AND write new pages back from this repo
- `read-only` — agent can search but never writes (best for multi-client consultants: search the shared brain, don't contaminate it with Client A's work while in Client B's repo)
- `deny` — no gbrain interaction at all

The skill asks once per repo. The decision is sticky across worktrees and branches of the same remote.

**GStack memory sync (different feature, same private-repo infra).** Optionally pushes your gstack state (learnings, CEO plans, design docs, retros, developer profile) to a private git repo so your memory follows you across machines, with a one-time privacy prompt (everything allowlisted / artifacts only / off) and a defense-in-depth secret scanner that blocks AWS keys, tokens, PEM blocks, and JWTs before they leave your machine.

```bash
gstack-artifacts-init
```

**Running gstack in Conductor?** Conductor explicitly strips `ANTHROPIC_API_KEY` and `OPENAI_API_KEY` from every workspace's process env, so paid evals and gbrain embeddings won't work out of the box. Set `GSTACK_ANTHROPIC_API_KEY` and `GSTACK_OPENAI_API_KEY` in Conductor's workspace env config instead — gstack's TS entry points promote them to canonical names at runtime. Full details and the contributor checklist for adding the import to new entry points: [Conductor + GSTACK_* env vars](../USING_GBRAIN_WITH_GSTACK.md#conductor--gstack_-env-vars).
