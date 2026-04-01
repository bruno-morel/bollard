# Bollard Risk Model
## Trust But Verify: Risk-Based Gating for AI Agents

*v0.1 — March 2026*

> *"The question isn't 'should a human approve this?' — it's 'what's at stake if the agent is wrong?'"*

---

## 1. The Philosophy: Trust But Verify

Bollard doesn't treat AI agents as either fully trusted or fully untrusted. It operates on a principle borrowed from diplomacy: **trust but verify.** Agents are given autonomy proportional to the risk of the change they're making. Humans are always kept informed — but they're only required to act when the stakes justify the interruption.

This replaces the simpler model from earlier Bollard design iterations, which had binary "human gates" (always approve plan, always review PR). Binary gates are safe but don't scale: a team processing 50 agent PRs per day can't meaningfully review all of them. The risk model lets humans focus their attention where it matters most.

### The Spectrum

```
LOW RISK                                                    HIGH RISK
────────────────────────────────────────────────────────────────────
Agent acts              Agent acts,              Agent proposes,
autonomously.           human is notified        human must approve
Human gets              with summary.            before execution.
a digest.               Can intervene.           Blocks until approved.

Examples:               Examples:                Examples:
· Lint fix              · New util function      · Auth/payment changes
· Dep patch update      · Test refactor          · Database migrations
· Typo in docs          · Config change          · API contract changes
· Dead code removal     · Internal API change    · Infrastructure changes
                                                 · Security-sensitive code
```

---

## 2. Risk Dimensions

Risk isn't a single number — it's a composite of several independent dimensions. Bollard evaluates each dimension and combines them into a risk score.

### Dimension 1: Blast Radius (Users Impacted)

How many users are affected if this change is wrong?

| Level | Description | Score |
|-------|------------|-------|
| **None** | Internal tooling, dev scripts, docs | 0 |
| **Self** | Developer's own workflow, local config | 1 |
| **Team** | Internal APIs, shared libraries, CI config | 2 |
| **Customers (subset)** | Feature behind a flag, specific endpoint | 3 |
| **Customers (all)** | Auth, payments, core data path, public API | 4 |

### Dimension 2: Reversibility

How hard is it to undo if something goes wrong?

| Level | Description | Score |
|-------|------------|-------|
| **Trivial** | Git revert, feature flag off, config rollback | 0 |
| **Easy** | Redeploy previous version, undo migration (if backward-compatible) | 1 |
| **Hard** | Data migration that's not easily reversible, published API contract | 2 |
| **Irreversible** | Data loss, leaked secrets, broken external integrations, financial transactions | 3 |

### Dimension 3: Dollars at Risk

What's the financial exposure if the change is wrong?

| Level | Description | Score |
|-------|------------|-------|
| **$0** | No financial impact (docs, tests, dev tooling) | 0 |
| **Indirect** | Productivity loss, tech debt accumulation | 1 |
| **Moderate** | SLA breach potential, increased infra cost | 2 |
| **Direct** | Payment processing, billing logic, financial reporting | 3 |

### Dimension 4: Security Sensitivity

Does the change touch authentication, authorization, data access, or secrets?

| Level | Description | Score |
|-------|------------|-------|
| **None** | No security implications | 0 |
| **Low** | Input validation, logging (no PII) | 1 |
| **Medium** | Session handling, rate limiting, access control helpers | 2 |
| **High** | Auth flows, encryption, secrets management, PII handling, payment data | 3 |

### Dimension 5: Novelty

Is this a pattern the codebase has seen before, or is it new territory?

| Level | Description | Score |
|-------|------------|-------|
| **Routine** | Same pattern exists elsewhere in the codebase (dep update, lint fix) | 0 |
| **Familiar** | Similar pattern exists, minor variation | 1 |
| **Novel** | New pattern, new library, new architectural decision | 2 |
| **Unprecedented** | No prior art in the codebase, new domain logic | 3 |

---

## 3. Risk Score Calculation

```typescript
interface RiskAssessment {
  blastRadius: 0 | 1 | 2 | 3 | 4;
  reversibility: 0 | 1 | 2 | 3;
  dollarsAtRisk: 0 | 1 | 2 | 3;
  securitySensitivity: 0 | 1 | 2 | 3;
  novelty: 0 | 1 | 2 | 3;
}

function calculateRiskScore(r: RiskAssessment): number {
  // Weighted sum — blast radius and security are weighted higher
  // because their consequences are harder to contain
  return (
    r.blastRadius * 3 +
    r.reversibility * 2 +
    r.dollarsAtRisk * 2 +
    r.securitySensitivity * 3 +
    r.novelty * 1
  );
  // Max possible: 4*3 + 3*2 + 3*2 + 3*3 + 3*1 = 12 + 6 + 6 + 9 + 3 = 36
}
```

### Risk Tiers

| Score Range | Tier | Gate Behavior |
|------------|------|---------------|
| **0-5** | **Low** | Agent acts autonomously. Human receives a digest (daily or per-batch summary). No approval needed. |
| **6-14** | **Medium** | Agent acts, human is notified immediately with a summary of what was done and why. Human can intervene/rollback but doesn't need to approve in advance. |
| **15-24** | **High** | Agent proposes a plan and waits for human approval before executing. PR always requires human review before merge. |
| **25-36** | **Critical** | Agent produces a plan and detailed risk analysis. Requires explicit human approval at BOTH plan stage and PR stage. May require multiple reviewers. |

### Who Assesses Risk?

The **planning agent** performs the initial risk assessment as part of the plan. It evaluates each dimension by analyzing:

- Which files are affected (maps to blast radius via codebase topology)
- Whether the change touches known-sensitive paths (auth, payments, DB schemas)
- Whether similar changes exist in git history (novelty)
- The nature of the change (config vs. logic vs. schema)

The risk assessment is included in the plan output. When a human reviews the plan (high/critical tier, or during bootstrap Stages 0-3 where all plans require approval), they can override the risk tier up or down. An override is recorded in the run log with the human's reasoning — the original agent assessment is preserved for calibration tracking (see Section 9, Meta-Verification).

**Bootstrap override (Stages 0-3):** All changes require plan approval regardless of the risk model's tier assignment. This is deliberate — it stress-tests the risk model by forcing humans to compare the agent's tier against their own judgment. The risk model still runs and scores every change; the override only affects gating, not assessment. At Stage 4, when the team has calibration data, the model's gating decisions take effect.

The Plan is a Zod-validated JSON object. The planning agent outputs JSON; the engine validates it against the Plan schema. PR descriptions and audit logs receive the same JSON, pretty-printed. No separate serialization format.

```typescript
// Part of the planning agent's structured output (Zod-validated JSON)
interface Plan {
  title: string;
  description: string;
  acceptanceCriteria: string[];
  affectedFiles: string[];
  risk: RiskAssessment;        // ← the agent's risk evaluation
  riskScore: number;
  riskTier: "low" | "medium" | "high" | "critical";
  gateDecision: {
    planApproval: boolean;     // does this change need plan approval?
    prReview: boolean;         // does this change need PR review?
    notifyHumans: boolean;     // should humans be notified immediately?
    multipleReviewers: boolean;// does this need >1 reviewer?
  };
}
```

### Sensitive Path Registry

To help the planning agent assess risk accurately, projects can declare which code paths are sensitive. Sensitive paths set a **floor** on the risk tier — a change touching `src/auth/**` (marked critical) will never score below critical, regardless of what the 5-dimension calculation produces. The agent still evaluates all dimensions, but the tier is `max(calculated_tier, path_floor)`. This prevents the model from under-scoring a change to a payment handler just because the change itself is small and reversible.

```yaml
# .bollard.yml

risk:
  sensitive_paths:
    critical:
      - "src/auth/**"
      - "src/payments/**"
      - "src/billing/**"
      - "migrations/**"
      - "infrastructure/**"
    high:
      - "src/api/public/**"
      - "src/middleware/security/**"
      - "src/models/**"
    medium:
      - "src/api/internal/**"
      - "src/config/**"

  # Override risk tier for specific blueprint types
  blueprint_overrides:
    dependency-upgrade:
      max_tier: medium        # dep upgrades are never critical
    lint-fix:
      max_tier: low           # lint fixes are always low risk
    documentation:
      max_tier: low           # doc changes are always low risk
```

---

## 4. How Risk Flows Through the Pipeline

```
Task arrives
     │
     ▼
┌────────────────────┐
│  PLANNING AGENT    │
│                    │
│  Assesses risk:    │
│  · Reads task      │
│  · Analyzes files  │
│  · Checks paths    │
│  · Scores risk     │
│  · Decides gates   │
└────────┬───────────┘
         │
         ▼
    ┌────────────┐
    │ Risk tier? │
    └────┬───────┘
         │
    ┌────┼──────────┬──────────────┐
    ▼    ▼          ▼              ▼
  LOW   MEDIUM     HIGH         CRITICAL
    │    │          │              │
    │    │          ▼              ▼
    │    │    ┌──────────┐  ┌──────────┐
    │    │    │ PLAN     │  │ PLAN     │
    │    │    │ APPROVAL │  │ APPROVAL │
    │    │    │ (1 human)│  │ (2 human)│
    │    │    └────┬─────┘  └────┬─────┘
    │    │         │             │
    ▼    ▼         ▼             ▼
┌─────────────────────────────────────┐
│  EXECUTION + VERIFICATION           │
│  (same for all tiers)               │
│  Code → Adversarial Tests →         │
│  Static → Dynamic → Mutation →      │
│  Semantic Review                     │
└────────────────┬────────────────────┘
                 │
            ┌────┼──────────┬──────────────┐
            ▼    ▼          ▼              ▼
          LOW   MEDIUM     HIGH         CRITICAL
            │    │          │              │
            ▼    ▼          ▼              ▼
         Auto- Auto-     PR created    PR created
         merge merge     for human     for human
         │      │        review        review (2+)
         │      │          │              │
         ▼      ▼          ▼              ▼
      Digest  Immediate  Notified     Notified
      (batch) notification             + escalation
```

Key insight: **verification is the same regardless of risk tier.** Every change goes through all verification layers — static checks, all enabled adversarial scopes (boundary, contract, behavioral), mutation testing, and semantic review. The risk tier only affects the **gating behavior** — whether a human needs to approve before/after, and how urgently they're notified.

This means a low-risk change is still adversarially tested across all enabled scopes and mutation-tested. The agent doesn't get to skip verification just because the change is low-risk. Trust but verify means: *trust enough to not block, but verify everything anyway.*

**Adversarial scope coverage as a risk signal.** When a scope is disabled or unavailable (e.g., behavioral scope requires Docker, which isn't present), the risk model records this as reduced verification coverage. A change verified by only one adversarial scope has weaker guarantees than one verified by all three. This doesn't automatically elevate the risk tier, but it's visible in the verification summary and the PR body — the human reviewer sees exactly which scopes ran and which concerns were probed. See [07-adversarial-scopes.md](07-adversarial-scopes.md) for the scope × concern matrix.

### Bootstrap Override: All Gates On

During Stages 0-3 (building Bollard itself), **all plan approvals are mandatory regardless of risk tier.** This is deliberate: we want to stress-test the risk model's scoring against human judgment before trusting it to gate autonomously. Every plan gets human review, every PR gets human review.

At Stage 4, when the risk model has accumulated enough data (hundreds of scored plans compared against actual outcomes), risk-based gating activates: low/medium changes auto-proceed, high/critical require approval. The transition is a team decision based on evidence from the bootstrap.

---

## 5. Notification Model

### Low Risk: Digest

```
┌─────────────────────────────────────────────────┐
│  Bollard Daily Digest — March 26, 2026          │
│                                                  │
│  12 changes auto-merged today:                   │
│                                                  │
│  ✓ Updated eslint-plugin-react to 7.34.1        │
│  ✓ Fixed typo in API docs (README.md)           │
│  ✓ Removed 3 unused imports in /src/utils/      │
│  ✓ Bumped Node types to 22.3.0                  │
│  ✓ ... (8 more)                                 │
│                                                  │
│  All changes passed full verification pipeline.  │
│  Mutation scores: 82-94%. Total cost: $18.40.    │
│                                                  │
│  [View all runs] [View diffs]                    │
└─────────────────────────────────────────────────┘
```

### Medium Risk: Immediate Notification

```
┌─────────────────────────────────────────────────┐
│  Bollard: Change auto-merged (medium risk)      │
│                                                  │
│  Task: Add retry logic to LLM client            │
│  Risk score: 8/36 (medium)                      │
│    Blast radius: Team (2)                        │
│    Reversibility: Easy (1)                       │
│    Dollars at risk: None (0)                     │
│    Security: None (0)                            │
│    Novelty: Familiar (1)                         │
│                                                  │
│  Verification: ALL PASSED                        │
│    Tests: 47 passed, 0 failed                    │
│    Mutation score: 87%                           │
│    Semantic review: PASS                         │
│                                                  │
│  [View PR #142] [View diff] [Rollback]           │
└─────────────────────────────────────────────────┘
```

### High / Critical Risk: Approval Request

```
┌─────────────────────────────────────────────────┐
│  🔶 Bollard: Approval required (high risk)      │
│                                                  │
│  Task: Add Stripe webhook handler for refunds   │
│  Risk score: 19/36 (high)                       │
│    Blast radius: Customers/all (4)               │
│    Reversibility: Hard (2)                       │
│    Dollars at risk: Direct (3)                   │
│    Security: Medium (2)                          │
│    Novelty: Familiar (1)                         │
│                                                  │
│  Plan:                                           │
│  1. Add POST /webhooks/stripe endpoint           │
│  2. Verify Stripe signature (security)           │
│  3. Process refund events → update order status  │
│  4. Idempotency via event ID deduplication       │
│                                                  │
│  [Approve plan] [Edit plan] [Reject]             │
└─────────────────────────────────────────────────┘
```

---

## 6. Graduated Trust Over Time

The risk model isn't static. As Bollard accumulates run history, the thresholds can be adjusted based on evidence.

Default thresholds (hardcoded — override in `.bollard.yml` only when you have data):

| Tier | Score Range | Behavior |
|------|-------------|----------|
| Low | 0-5 | Auto-merge, daily digest |
| Medium | 6-14 | Auto-merge, immediate notification |
| High | 15-24 | Human approval required |
| Critical | 25+ | Multiple reviewers required |

Auto-merge, notification routing, mutation score requirements, and verification pass requirements are all hardcoded defaults derived from these tiers. To override thresholds:

```yaml
# .bollard.yml — only if defaults don't fit your project
risk:
  thresholds:
    low_max: 8                # more tolerant low tier
```

Over time, as the team sees data (success rates, false positive rates, cost-per-tier), they can:
- Lower the medium threshold (more changes auto-merge) if agents prove reliable
- Raise it if false positives emerge
- Add or remove paths from the sensitive path registry
- Adjust weights in the risk calculation

The key: **these are team decisions based on evidence, not leap-of-faith automation.**

---

## 7. Risk Assessment for Documentation Changes

Documentation changes follow the same risk model but with an important nuance: the **blast radius** of a documentation error isn't about users affected — it's about **decisions misled.**

Wrong documentation in an API guide could cause external developers to misuse the API. Wrong documentation in an architecture doc could cause internal engineers to make bad decisions. Wrong documentation in a runbook could cause incident responders to take the wrong action.

The planning agent evaluates doc risk based on:

| Doc Type | Typical Blast Radius | Typical Risk Tier |
|----------|---------------------|-------------------|
| Internal comments, code docs | Self/Team | Low |
| README, contributing guides | Team | Low-Medium |
| API reference (public) | Customers | High |
| Architecture decision records | Team (long-term) | Medium |
| Runbooks, incident response | Team (during incidents) | High |
| Legal/compliance docs | Customers/all | Critical |

This feeds into the documentation-as-artifact verification layer (see the Universal Artifact Pattern in [01-architecture.md](01-architecture.md)).

---

## 8. Risk-Driven Production Observability

The risk model doesn't stop at deploy. It also determines **how tightly production is monitored** after a change ships and **how corrections are gated**.

### Risk Tier → Monitoring & Remediation

| Risk Tier | Probe Frequency | Remediation Gating | Human Involvement |
|-----------|----------------|-------------------|-------------------|
| **Low** | Every 5 min | Auto-deploy fix if pipeline passes | Digest entry |
| **Medium** | Every 5 min | Auto-deploy fix if pipeline passes | Immediate notification, can rollback |
| **High** | Every 2 min | Fix staged as PR, human deploys | Human reviews fix before deploy |
| **Critical** | Every 1 min | Fix staged as PR, human deploys | Human reviews, may require 2+ reviewers |

**Rollout:** Higher-risk changes deploy progressively (canary → full) with probe windows between steps. Low-risk deploys immediately. See [01-architecture.md](01-architecture.md) Section 11 for the rollout-by-risk-tier table.

**Remediation** follows the **fix-forward** model: diagnose the issue, produce a fix through the full adversarial pipeline, deploy the fix. The canary halts while the fix is being produced. The fix goes through the same gating as new code (Section 4). The only difference is the task source: "production probe failure" instead of "developer request."

**Drift detection** supplements probes. Probes catch behavioral issues (wrong responses, latency spikes). Drift detection catches structural issues (unverified code in production, config changes that bypassed Bollard). Together they close the loop: nothing unverified stays in production.

### How Risk Scores Evolve Post-Deploy

A code path's risk score can change based on production evidence: repeated probe failures on a low-risk path suggest the assessment was wrong (bump the tier), while zero probe failures over 90 days on a high-risk path suggest loosening (team decision, not automatic). Drift frequency on a path also informs risk — paths that attract manual hotfixes may need a higher risk floor. This creates a data-driven feedback loop between production behavior and the risk model. See [01-architecture.md](01-architecture.md) Section 11 for the Production Feedback Loop design.

---

## 9. Escape Hatches: When Humans Need to Bypass Bollard

Production is down at 3am. The on-call needs to push a hotfix now. Bollard should never be the reason a team can't respond to an emergency.

### The `--emergency` Flag

```bash
bollard run "fix critical auth bypass" --emergency
```

What `--emergency` does:
- **Skips risk gates.** No human approval required regardless of risk tier.
- **Skips agentic nodes.** No planning agent, no semantic review. Only mechanical verification runs (lint, type check, tests).
- **Creates an audit trail.** The run is logged with `emergency: true`, the author's identity, and a timestamp. This is visible in `bollard history` and in the PR description.
- **Queues retroactive verification.** A follow-up Bollard run is automatically created that runs the full adversarial pipeline against the emergency change. This appears as a task within 24 hours.
- **Notifies the team.** An immediate notification goes out: "Emergency bypass used by [who] for [what] at [when]."

What `--emergency` does NOT do:
- Skip tests. If tests fail, the hotfix has a bug. Period.
- Skip linting or type checking. These take <30 seconds and catch real problems.
- Disable Bollard permanently. The flag is per-run, not a setting.

### Emergency Feature Kill

If a canary is causing production issues and the fix-forward pipeline hasn't completed yet:

```bash
bollard flag set <flagId> off           # immediate 0%, logged with audit trail
```

This disables the feature flag instantly, halts any in-progress rollout, logs the action, and creates a retroactive investigation task. The investigation goes through the full adversarial pipeline — fix forward, don't just leave the flag off.

### Meta-Verification: Watching the Watcher

Bollard's own risk assessments can be wrong. A miscalibrated risk model silently degrades every downstream gate. Three mechanisms detect this:

**Risk score auditing.** Every run records the risk assessment alongside the outcome. Over time this builds a confusion matrix — under-assessment (scored low, failed post-deploy) vs. over-assessment (scored high, was trivial). `bollard doctor --risk-audit` reports calibration quality.

**Information isolation verification.** At Stage 3+, Bollard mechanically checks that the adversarial test agent didn't reference implementation details it shouldn't know about — using TypeScript compiler API to extract identifiers from test output and diff against the public API surface. Deterministic, zero LLM cost.

**Prompt regression detection.** When a prompt changes, compare metrics over the next N runs against the previous N. See [02-bootstrap.md](02-bootstrap.md) for the prompt evaluation framework. Full meta-verification detail (confusion matrices, isolation AST algorithms, regression thresholds) is in [ROADMAP.md](ROADMAP.md).
