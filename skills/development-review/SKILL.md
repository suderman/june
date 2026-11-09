---
name: development-review
description: Coordinate a user-delegated independent development/review loop with org_review_task. Use for DEV_REVIEW or REVIEW_PARENT tasks, review findings, exact-commit acceptance and return-for-fixes. Keep one development outcome, scoped permissions and human checks. Not permission to enroll work without the user's delegation.
---

# Development and independent review

June coordinates this workflow. Coding workers implement or review their assigned task; they never grant AUTO or coordinate their own acceptance.

## Permission first

Read the whole development task, including Dialog and prior linked reviews. The user must have delegated independent review and bounded in-scope fixes, not merely requested a second opinion. If that authority is missing, ask. Do not enroll unrelated work or use a review finding to expand implementation scope.

Keep a single development task as outcome owner. Use `org_review_task`, not general resume/complete, once it has `DEV_REVIEW`. Review records have `REVIEW_PARENT` and `REVIEW_COMMIT`. All review and acceptance records stay in the same project Org file. The tool supports one local Git repository and branch. Multiple repositories, cross-host sessions or changed assignments need a decision, not an improvised extension.

## Start at EVAL

EVAL means ready for someone to test or review. It does not imply Jon or an agent specifically. The developer must finish feasible checks and publish only if authorized, with an exact full commit hash. Wait until the original linked worker has settled or exited. Never interrupt it or send a named prompt to hurry a handoff.

Read the current task with `org_read_task`. Use `org_review_task` action `start`, its revision and the full commit hash. First start also needs:

- `authorization`: the user's delegation of bounded in-scope fixes and independent review.
- `permissions`: separate local verification, remote reads, remote writes, developer commits/pushes, activation and deployment. Copy limits and exclusions from the actual task. Reviewer work is read-only apart from local test artifacts and its own review record. It cannot fix, commit, push, activate, deploy, start services or commission work.
- `checks`: agent reviewer responsibility and specific checks, including feasible edge cases and failure paths. Tests the agent can perform must not be handed to Jon by default.
- `human`: exact required human checks, or an explicit empty array when none remain. Taste, physical-world checks, some phone actions and boot/reboot sequences can need Jon. Never remove these because tests pass.
- `agent`: enabled reviewer agent. The first reviewer is a fresh independent session. This implementation starts a fresh reviewer every round; it can read previous linked evidence for continuity.

The command checks the clean source branch/hash, creates a separate detached private clone without remotes or shared Git metadata, and queues one ordinary AUTO review task. It leaves development at EVAL. The dispatcher still owns launching, directory exclusion and session recovery. June follows the review through the existing durable follow mechanism. No separate orchestrator or approval-triggered deployment exists.

## Return findings without Jon copying them

On the review's EVAL notice, read its whole Outcome, immutable verdict and evidence, then re-read the development task. Check whether findings are within the original scope. Use `org_review_task` action `advance` on the development ID with its current task revision and exact reviewed commit.

- `fixes` returns the same development task to AUTO with its original agent and session history. Dialog links the review, copies its findings summary and repeats permissions. Developer reads the full review, corrects only authorized findings, verifies and finishes EVAL with a new commit. Then `start` a new exact-revision review. Do not ask Jon to relay findings.
- `pass` accepts agent checks for that commit. If human checks remain, development stays EVAL. Otherwise it closes DONE under the delegated contract. Never use this to close a task that still needs separate acceptance outside the contract.
- `blocked`, missing permission or the third unsuccessful round leaves development HOLD for Jon. Do not reset the counter, create a replacement loop or commission follow-up work. Findings outside scope need Jon, not another worker.

Read results before claiming anything changed. A replay can return an earlier phase without changing a later task state. If development is EVAL after fixes but its commit is unchanged, do not spin on duplicate `start` calls. Ask Jon about the unresolved finding. Unexpected branch/source movement, a reviewer HOLD/crash, missing verdict or a dirty/partial snapshot also needs inspection. Escalate rather than repeatedly launching or resetting snapshots. Existing stop/reassign safeguards still apply. No action proves child processes ended.

## Human acceptance

Report agent acceptance and the specific remaining checks. Only after Jon explicitly confirms named checks for the exact agent-approved commit, call action `human` with the development revision, commit, those exact names in `human`, and his actual acceptance in `note`. Partial acceptance stays EVAL. All required checks must be accepted for the same commit before DONE. A changed commit needs a new review and clears old human acceptance.

Do not infer Jon's acceptance from silence, an agent's verdict or a tool returning success. Approval grants no new permission to deploy or activate. Those remain separate actions under the original task or a new explicit request.

## Restart and cleanup

Contracts, round links, exact verdicts, session links and human acceptance live in Org, not pane output. Follows persist across June restarts. Operations replay without a second task or a second AUTO grant. If a call was interrupted, read Org and retry the same action/commit; do not invent a new review record. A completed clone left before the Org save can be reused only when clean, at the same hash and without remotes. A partial/dirty clone is never reset or deleted automatically.

A loop startup error or a `starting` receipt older than ten minutes parks HOLD with durable `launch-uncertain` ownership. The dispatcher keeps its pane/tab/session evidence and worktree/slot reservation, sends no input and does not relaunch. A crash before the HOLD save recovers the parking. Resume/finish remain blocked. Jon must inspect the exact receipt, Herdr and child processes; this version has no automatic reconciliation/release command. Do not delete receipts, bypass HOLD or create a duplicate as a workaround. Recovery/release needs a separate explicit decision after inspection.

Closed panes do not erase records. The dispatcher can resume the original developer from its recorded native session, or reconstruct context from Org when its configured launcher uses fresh sessions. An unavailable session/launcher or crashed reviewer is a blocker to inspect, not permission for unlimited retries. The loop caps revision reviews at three, including revisions changed while awaiting human checks.

Snapshots live under `~/.local/state/org-work/<domain>/<project>/review-loop/` on the dispatcher host. Org records the host and path. Keep them while reviews or human checks need them. After acceptance and confirmed reviewer exit, remove disposable snapshots without touching source or Org evidence. No daemon or real service is started for verification.

## Availability

The updated `org-edit`, dispatcher, June tool and skill must be applied together on the launching host. They are not all checkout-live. Application needs a June flake input update and authorized host activation. Also register this skill in June's indexed roots: with Jon's approval, add `~/.config/june/skills` to his existing `skillDirs` without removing other roots, or use his existing skill-link setup. This installation indexes `~/.agents/skills` and `~/profile/skills`; activation alone does not make the new packaged skill discoverable. Merge the new template convention into his existing AGENTS.md if needed. Restart June while idle, then verify `skill_read` with `name: development-review` succeeds before enrolling work. The source update performs none of those application changes. An old installed `org-edit` refuses this operation before writing. Report that limit; never hand-edit state or imitate a handoff with a normal Herdr prompt.
