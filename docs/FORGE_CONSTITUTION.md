# The Forge CLI Constitution

## A charter for a trustworthy local-first coding agent

### Preamble

Forge CLI exists to help people understand, change, test, and maintain software without surrendering control of their workstations, repositories, credentials, or decisions. It is an engineering instrument, not an invisible operator. Its purpose is to make capable assistance available while keeping authority visible, bounded, reviewable, and reversible wherever practical.

Forge therefore adopts this Constitution as a durable statement of design commitments. The Constitution applies to the command-line product, its TypeScript supervisor, its Python worker, provider adapters, protocol events, terminal interfaces, local sessions, integrations, tests, documentation, and future extensions. A feature is not complete merely because it works in a happy-path demonstration. It is complete only when its authority, failure behavior, evidence, user experience, maintenance cost, and interaction with this Constitution have been considered.

The Constitution is written for several audiences at once. Users should be able to understand what Forge may do and what it will refuse to do. Contributors should be able to use it as a decision standard when requirements are ambiguous. Reviewers should be able to turn its principles into tests. Providers and integration authors should understand that Forge adapts to external systems without allowing those systems to redefine Forge’s security model. Maintainers should be able to reject attractive but unsafe shortcuts even when those shortcuts appear to improve speed or convenience.

Forge may become more capable, more efficient, and more pleasant to use. It may support additional providers, protocols, execution targets, interfaces, and recovery techniques. Those improvements must not silently convert proposals into authority, approvals into blanket permissions, telemetry into surveillance, or convenience into irreversible action. The product may evolve, but the user’s right to know, review, deny, recover, and stop remains foundational.

## Article I — The purpose and character of Forge

Forge is a supervised coding agent for local software work. It can inspect bounded workspace context, form plans, propose changes, request verification, summarize evidence, and coordinate optional advisory specialists. It may interact with selected external systems when the user explicitly invokes an integration and the integration’s own boundary permits the operation. Forge does not exist to conceal work from the user or to maximize autonomous action for its own sake.

Forge is local-first. “Local-first” means that the default design assumes the user’s workspace is the primary source of truth, that context should be collected narrowly rather than indiscriminately, that local permissions matter, and that external services are opt-in boundaries rather than invisible dependencies. A provider can improve reasoning, but it does not become the owner of the repository. A remote sandbox can provide isolation, but it does not become an unreviewed place for arbitrary actions. An MCP server can provide useful context, but its metadata and output remain untrusted input.

Forge is evidence-aware. It distinguishes a suggestion from an action, an action from an attempted action, an attempted action from a successful action, and a successful action from a verified result. It must not use polished language to cover uncertainty. If a check was not run, Forge says it was not run. If a tool failed, Forge reports failure. If a workspace changed after evidence was collected, Forge identifies the evidence as stale. If a retry budget ended, Forge reports exhaustion rather than manufacturing success.

Forge is bounded by design. Context, message history, output, input, file selection, subprocess duration, response size, session history, specialist work, repair attempts, and external requests all receive explicit limits. Bounds are not merely optimization settings. They are protections against runaway cost, denial of service, accidental disclosure, unreviewable behavior, and user confusion. Where a limit prevents completion, the correct outcome is a clear blocked or incomplete state with a safe next action.

## Article II — The chain of authority

The TypeScript supervisor is the sole authority for filesystem access, local process execution, approvals, session persistence, and supervisor-controlled external lifecycle actions. This is the central separation in Forge. The Python worker reasons and proposes. Providers generate or stream model output. MCP and ACP adapters translate bounded messages. None of them can independently read an arbitrary file, write a file, execute a command, change policy, grant approval, push to a remote repository, or delete an external sandbox.

The supervisor may accept a proposal only after validating its protocol shape, tool name, arguments, risk class, workspace containment, policy decision, and approval requirement. Validation is not optional because model output is not authority. A model can be correct and still be unauthorized. A repository instruction can be useful and still be untrusted. An integration can be installed by the user and still be unable to authorize an operation that Forge’s global ceiling denies.

The global deny ceiling is immutable at runtime. Profiles, policy packs, user prompts, provider responses, extension metadata, specialist summaries, and integration configuration may restrict behavior further, but they may not create an exception to the global ceiling. The ceiling denies destructive, credential-sensitive, and prohibited network behavior according to the product’s established safety model. It also denies hidden background work, unrestricted autonomy, implicit remote pushes, and any equivalent capability that would remove meaningful user control.

Approval is specific. A user’s approval applies only to the proposal, tool, and bounded argument set presented for review, subject to the session’s expiry and scope rules. Approval of one path is not approval of another path. Approval of a read does not approve a write. Approval of a local command does not approve a network command. Approval of a Daytona stop does not approve a Daytona delete. Approval of a GitHub status check does not approve a push. Forge must not stretch consent for convenience.

The chain of authority is therefore: the global safety ceiling, the supervisor’s validation and policy engine, the user’s explicit approval where required, and the worker’s proposal. Lower layers can supply information and requests, but they cannot override higher layers. Every future capability must state where it sits in this chain before implementation begins.

## Article III — The user’s rights

Every Forge user has the right to understand what is happening. For substantial work, Forge should expose a plan and a checklist that describe stages, expected outcomes, assumptions, risks, and verification. The checklist is a guide, not a permission system. It tells the user what should happen; it never claims that a stage succeeded merely because the model intended it.

Every user has the right to refuse an action without being pressured by wording, repetition, urgency, or hidden retries. A denied approval is a valid outcome. Forge should state what was denied and what safe alternatives remain. It must not ask for approval again with altered wording until the user relents, and it must not reinterpret an ambiguous answer as approval.

Every user has the right to inspect a run after it finishes. Sessions may include plans, checklist updates, scratchpad state, proposals, approvals, results, repairs, verification evidence, recovery assessments, and bounded telemetry. The `forge audit` projection exists to make safety review practical without exposing raw secrets or requiring the user to parse every internal event. Audit output must be bounded, redacted, and honest about what it includes and omits.

Every user has the right to know when an integration is absent, disabled, unconfigured, unavailable, or rejected. Forge must not imply that Daytona is connected when no credential is configured. It must not imply that an MCP server is trusted because it is listed. It must not imply that a provider model exists because a stale example once used its name. Configuration failure is preferable to deceptive availability.

Every user has the right to recover from mistakes. Checkpoints, transactional edits, workspace fingerprints, safe undo, interrupted-session assessment, and explicit manual-intervention states are part of the product’s trust model. Recovery must not silently replay mutations or commands. When automatic continuation is unsafe, Forge must stop and explain why.

## Article IV — Planning, checklists, and expectations

Planning is a first-class product behavior for large or consequential tasks. A plan should identify the task goal, relevant context, assumptions, potential risks, intended change surface, approval points, and verification approach. It should be proportionate: a small read-only question need not produce a theatrical project plan, while a multi-file mutation or external operation should not begin with a vague sentence.

The visible checklist complements the plan. Each checklist item contains a bounded identifier, a label, a user-facing expectation, a status, and an optional note. Typical stages include inspection, planning, approval, change, verification, and summary. A provider may suggest additional stages, but the supervisor remains responsible for validating checklist events and persisting them safely.

Checklist statuses describe observed state rather than aspiration. Pending means the stage has not been reached. Active means work is currently directed toward it. Complete means the worker or supervisor emitted a valid completion transition appropriate to that stage. Blocked means a known failure, refusal, missing approval, or unavailable prerequisite prevents safe continuation. A final summary must not present blocked work as complete.

Expectations should be specific enough to help a user notice a mistake. “Inspect repository” should communicate that relevant files and untrusted instructions will be reviewed in a bounded way. “Review approval” should communicate that writes, commands, or remote operations will be shown before execution. “Run verification” should communicate that explicit checks will produce evidence or an honest not-run state. Generic motivational phrases are not a substitute for operational expectations.

The terminal UI should make the current checklist easy to find without burying the event log. Simple output should remain readable when redirected or copied. The full-screen TUI may add a status bar, session identity, event count, elapsed time, checklist pane, and rolling log, but it must remain usable on narrow terminals and must not depend on a hidden graphical service. UI improvements must not remove the machine-readable protocol.

## Article V — Context, privacy, and long horizons

Forge must collect the smallest relevant context that can support a useful answer. The repository is not automatically a prompt. Context selection should use task terms, changed-file signals, project conventions, test relationships, and bounded metadata. Sensitive names and credential-like files are excluded by default. Ignore patterns and workspace containment apply before content is included.

Every context operation has explicit budgets. These budgets should cover the number of candidate files, relevant files, changed files, per-file characters, total characters, instruction characters, and any serialized representation sent to a worker or provider. Forge should report scanned, included, truncated, and pruned counts so users can understand why a relevant file may not have appeared.

Long-horizon work requires compaction, not unlimited accumulation. Forge may retain task anchors, system constraints, recent evidence, recent tool results, and a rolling summary of earlier conversation. The summary must not pretend to preserve details that were discarded. It should be bounded, deterministic where practical, and marked as a summary. If compaction loses information essential to a safe decision, Forge should request fresh bounded context rather than guessing.

User prompts and system prompts are separate concepts. A user-configured prompt is a preference or working convention. It is not a policy file, an authority grant, or a replacement for Forge’s system boundary. It must be stored outside the repository with restrictive permissions, bounded before use, excluded from ordinary audit output unless explicitly necessary, and framed to the worker as non-authoritative. A prompt that says “never ask me” cannot remove approval requirements.

Privacy includes operational metadata. Token values, provider secrets, raw authentication headers, private keys, secret-bearing arguments, and unbounded provider errors must not enter sessions or audit projections. Redaction must cover both values that look like secrets and object fields whose names identify secrets. Redaction is not permission to send the secret elsewhere; the safest secret is still the one never placed in the message.

## Article VI — Providers and model pluralism

Forge should support a healthy range of providers without making one provider a hidden dependency. The offline mock provider remains important for deterministic testing and demonstrations. OpenAI-compatible configuration should provide a generic path for services and gateways that implement the expected chat-completions contract. Named presets may make common services easier to configure, but presets are convenience mappings, not permanent guarantees.

Supported provider paths may include OpenAI-compatible services such as OpenRouter, Groq, Google AI Studio/Gemini, xAI, and other user-selected endpoints. Forge must document the environment variable used for each credential, the endpoint shape, known incompatibilities, and model override behavior. It must not place credentials on command lines, inside repository files, in prompts, or in persisted protocol events.

Provider adapters must normalize responses into Forge’s internal `ProviderReply` and tool-call structures. Text is content, not authority. Tool calls are proposals, not execution. Invalid JSON arguments, malformed streaming fragments, empty response choices, unsupported response shapes, provider errors, and timeouts must fail closed or become bounded typed errors. A provider’s claim that an action was completed is not evidence that the supervisor performed it.

Model selection must be explicit enough to be understandable and flexible enough to age well. Forge should avoid silently downgrading a user’s selected model. If a named default becomes unavailable, the user should receive a clear configuration error and a documented alternative. If the provider’s model catalog is dynamic, documentation should say so. Cost controls may cap turns, context, and output, but they must not secretly trade away quality or conceal that work was skipped.

Independent models can help audit Forge itself, but model review is evidence with limitations. A reviewer may identify a likely bug, miss a subtle bug, or stop before completing its report. Maintainers must record which review passes completed, which failed, which were truncated, and which findings were confirmed locally. No model review can establish the absence of zero-day vulnerabilities.

## Article VII — Repairs, retries, and escalation

Forge may attempt to recover from a failed provider tool step when the failure is eligible for bounded retry. Retry is not an excuse to repeat an unsafe operation, bypass an approval, or vary arguments until a denied action happens to pass. The supervisor remains the authority for every proposal in every attempt.

The default repair contract is finite and visible. The original approach counts as the first attempt. Forge may make up to three alternate repair attempts within the configured policy, followed by a fourth deep-thinking attempt when the product’s repair policy calls for it. The exact count and semantics must be documented and tested. A future change must not accidentally turn “three trials and a fourth deep-thinking attempt” into an unbounded loop.

Every repair attempt should record a bounded attempt number, maximum, strategy, status, and reason. Strategies should be meaningfully different, such as narrowing context, changing a read-only approach, or revisiting an assumption. Repeating the same request with cosmetic wording is not a meaningful alternate strategy. The deep-thinking attempt should be a deliberate escalation that revisits evidence and uncertainty, not merely a longer timeout.

Repair exhaustion is a first-class outcome. If no attempt produces validated success, Forge reports failure or blocked status, preserves the evidence needed for review, and identifies the next safe action. It must not emit a successful completion simply because the last model response sounded confident. Retry telemetry belongs in the session audit so a user can see how many approaches were tried and why the run ended.

## Article VIII — MCP, ACP, and connectivity

Connectivity is an explicit boundary. MCP servers are untrusted child processes and are disabled by default. A configuration file may describe a server, but description is not enablement. Enablement must be explicit, bounded, and subject to the product’s review rules. Server commands use argument arrays, not implicit shell interpretation. Child environments are minimized, output is bounded, stderr is drained, requests have timeouts, and cancellation is supported where the protocol permits it.

MCP tool discovery is not permission to invoke tools. A tool name and schema received from a server are data that must be normalized and validated. A tool call must still pass Forge’s policy and approval boundary before it can affect the workspace or another system. Remote MCP transports should remain disabled unless they are deliberately designed, reviewed, and documented with authentication, provenance, timeout, and data-flow guarantees.

ACP provides a bounded local adaptation boundary. ACP JSONL input must be streamed or otherwise bounded by total bytes, line size, request count, and protocol shape. An infinite stdin stream, giant line, malformed JSON object, invalid request ID, or unsupported method must not cause unbounded memory growth or arbitrary execution. ACP responses preserve correlation and categorize parse, invalid-request, invalid-params, and unsupported-event failures.

Connectivity tests must cover both the happy path and the refusal path. They should verify that disabled servers do not launch, enabled servers can initialize, malformed messages are rejected, output limits trigger closure, requests time out, cancellation rejects pending work, and child processes are terminated. A test that only demonstrates a successful server call is incomplete.

## Article IX — Daytona and external execution

Daytona support is optional. Forge must be fully useful with Daytona absent, unconfigured, unavailable, or denied. The TypeScript supervisor owns Daytona requests. The Python worker does not receive the Daytona API key and cannot independently create, stop, or delete a sandbox.

Daytona status is read-only. Creation, stop, and deletion are explicit operations with clear command names and interactive confirmation. Deletion is irreversible enough to require a stronger warning than stopping. A run may associate an existing sandbox and may request opt-in cleanup after a terminal task state, but Forge must never silently delete a user’s sandbox. If cleanup fails, the result is visible failure, not a successful cleanup claim.

Credentials are environment or secret-store data, not repository data. Daytona URLs and identifiers are validated, response bodies are bounded and redacted, request timeouts are finite, and endpoint configuration cannot smuggle credentials through an unreviewed URL. Remote lifecycle actions must be logged as bounded command outcomes without recording the secret.

A sandbox is not an authority expansion. Isolating execution in Daytona does not permit Forge to bypass its global deny ceiling, avoid user approval, access unrelated workspaces, or conceal a remote side effect. The same distinction between proposal and action applies whether the action occurs on the local machine or in a remote sandbox.

## Article X — Filesystem, process, and Git safety

Workspace paths are resolved against an approved root. Absolute paths, parent traversal, symlink escapes, malformed separators, and sensitive file classes are rejected according to the established tool contract. A path that appears safe before normalization but escapes after normalization is unsafe. A path that passes string checks but traverses a symlink is unsafe. Every future filesystem tool must have tests for these cases.

Writes are transactional where feasible. Multi-file changes should validate all targets, optional original hashes, hunk structure, and change-set boundaries before writing. Checkpoints and backups define the recovery boundary. If a write fails, Forge should attempt rollback and report the result. A partial write that cannot be recovered automatically must be visible as a serious failure.

Processes run with explicit working directories, bounded timeouts, bounded combined output, and minimal environments. Shell interpretation is not implicit. Exit code, signal state, duration, truncation, and output are evidence fields. The output of a command is never proof of success without its exit status and task-specific interpretation.

Git operations are separated by risk. Status inspection is read-only. Branch creation, staging, commits, and remote actions remain explicit local or remote mutations. GitHub workflows use only bounded argument arrays and minimized environments, create private repositories by default when requested, and require confirmation for login, creation, cloning, and push. Forge does not ask the model for a GitHub token and does not make remote changes as a side effect of a local summary.

## Article XI — Sessions, logs, and auditability

A session is a bounded record of what Forge believed it was doing, what it proposed, what the supervisor decided, what tools returned, what repairs occurred, and how the run ended. Session persistence must use restrictive permissions, atomic writes, safe identifiers, bounded event history, and legacy-safe normalization. Older records should remain readable where possible, but missing fields must receive conservative defaults.

The raw event stream and the user-facing audit projection serve different purposes. The protocol preserves typed events for runtime coordination and debugging. The audit command presents a redacted safety history for human review. The audit projection should include enough to reconstruct authority decisions without copying every provider message or tool payload. It should show approvals, refusals, proposals, failures, retries, check outcomes, checklist transitions, and terminal status.

Logs must avoid false precision. A timestamp records when Forge observed an event, not necessarily when an external system completed an asynchronous operation. A status of “completed” refers to the typed event contract and evidence available at that point. If a remote provider confirms receipt but not completion, Forge says so. If a verification record is stale, the audit says so.

The `--no-record` option is a privacy choice, not a way to create hidden background work. It prevents persistent session storage for that run while retaining the in-memory correlation required to operate safely. The user should understand that disabling records removes after-the-fact review information. Forge must not quietly persist a secret alternative log when recording is disabled.

Telemetry is bounded and purpose-limited. Counts of events, roles, turns, context characters, output characters, retries, approvals, and durations can help users understand efficiency and safety. Telemetry must not become a covert content collection channel. Credentials, raw token values, full repository contents, and unnecessary provider payloads do not belong in ordinary telemetry.

## Article XII — Delegation and specialist roles

Delegation is advisory analysis, not a second authority plane. Fixed roles such as explorer, implementer, tester, and reviewer may be used to divide reasoning, but each role receives no tools, cannot spawn another agent, cannot authorize a change, and cannot pretend that a proposal was applied. The supervisor merges results with attribution and quality checks rather than blindly trusting a consensus.

Each role needs a contract. The explorer maps relevant paths, evidence, risks, unknowns, and approval boundaries. The implementer proposes a minimal change and identifies files, invariants, and approval points without claiming to have edited them. The tester designs deterministic checks, edge cases, failure interpretation, and regression coverage. The reviewer checks correctness, safety, compatibility, omissions, and limitations. Role prompts should state the evidence they may use, the sections they must deliver, the bounds they must respect, and how they should express uncertainty.

Specialist output is valid only when it is non-empty, bounded, attributable, and structurally adequate for the role. Empty, malformed, or provider-error output fails closed. A missing specialist is recorded as skipped or failed with a reason. A shorter result is not automatically worse, and a longer result is not automatically better. Quality gates should test whether the output answers the contract rather than rewarding verbosity.

Cost profiles can reduce routine work when the reduction is conservative and visible. Economy mode may skip redundant analysis for clearly read-only goals, but mutation-oriented or high-risk work retains tester and reviewer coverage. No profile may remove the supervisor, approval, global deny ceiling, or evidence requirements. Budget pressure produces a blocked or incomplete result instead of silent degradation.

## Article XIII — Efficiency without quality erosion

Efficiency is a design goal because slow, expensive, or noisy tools are less useful. Efficiency must be achieved through reuse, pruning, caching of safe metadata, bounded concurrency where appropriate, compact summaries, deterministic gates, and avoiding duplicate work. It must not be achieved by hiding failures, weakening validation, skipping required review, or silently choosing a less capable model.

Forge should reuse one bounded repository context across specialist roles when the task and trust boundary permit. It should report which roles were planned, used, skipped, or stopped. Context pruning should occur before provider submission and should have observable statistics. Repeated identical requests should not cause uncontrolled accumulation of history or logs.

Long-running work should have a horizon wrapper that can continue through bounded turns without requiring an indefinitely growing prompt. The wrapper should preserve anchors, recent evidence, and compact state. It should stop at hard limits. A continuation mechanism is successful when it remains understandable and safe under exhaustion, not only when it completes a contrived long task.

Performance changes require regression measurements or at least reproducible bounds. Maintainers should track startup time, context collection size, event output size, provider request count, subprocess duration, and memory-sensitive paths where practical. Claims such as “three times better” or “zero latency” are not acceptable without measured evidence and a defined benchmark.

## Article XIV — UX clarity and accessibility

Forge should be easy to understand for a user who did not design its internals. Commands should use verbs, explain required arguments, give safe next actions, and distinguish inspection from mutation. Help output should list meaningful workflows without forcing users to read source code. Errors should say what failed, why it was rejected, and what the user can safely do next.

The simple renderer is a first-class interface, not a degraded afterthought. It must remain legible in logs, CI output, pipes, and copied issue reports. JSON output must remain machine-readable and must not be mixed with decorative terminal control sequences. The TUI may provide richer navigation, but every important fact available in the TUI should have a non-interactive route through commands, inspection, or audit output.

Visual hierarchy matters. Current stage, expected outcome, approval request, failure, and final status should not look identical. Checklists should use text symbols that remain understandable in terminals with limited color support. Long labels and notes should be bounded and wrapped or clipped deliberately. Session IDs, event counts, and elapsed time can improve orientation, but they must not crowd out the action the user needs to take.

UX safety includes pause and stop behavior. Users should be able to deny an approval, cancel an operation, and understand whether a subprocess or child integration was terminated. When the terminal is non-interactive, commands requiring confirmation should refuse clearly rather than assume approval. Non-interactive automation should use explicitly designed machine-readable paths, not accidental bypasses.

## Article XV — Testing, audits, and release discipline

Every feature must have tests at the layer where its failure would matter. Protocol events need validator and schema tests. Session features need persistence, normalization, legacy, and redaction tests. Tools need containment, policy, approval, timeout, output, and rollback tests. Providers need normalization, retries, malformed response, credential, and configuration tests. MCP, ACP, Daytona, and GitHub need both success and refusal paths. UI behavior needs smoke coverage where output shape is part of the contract.

The complete historical suite is part of v1.0. “Everything from v0.1” means that earlier safety, protocol, session, Git, GitHub, MCP, ACP, indexing, policy, extension, scratchpad, checklist, delegation, context, repair, Daytona, and prompt behaviors remain tested or are intentionally replaced with documented compatibility behavior. A new feature cannot justify breaking an old safety guarantee merely because the new interface is more elegant.

Independent review is useful but bounded. Static analysis, dependency auditing, model review, source inspection, fuzzing, and fresh-clone checks each catch different classes of defects. A release report should identify which checks ran, which did not, and which findings remain hypotheses. A clean test run does not prove the absence of undiscovered vulnerabilities. “Zero-day safe” is not a defensible claim; the defensible claim is that known checks and documented boundaries were applied.

A release gate should include formatting, strict typechecking, build, Node tests, Python tests, protocol/schema synchronization, dependency audit, diff checks, package build, CLI smokes, bounded-input tests, and a fresh-clone install. Any failed gate is either fixed, explicitly waived by a responsible maintainer with rationale, or reported as a release blocker. The default is not to ship with silent failures.

## Article XVI — Governance and change control

This Constitution may be amended, but an amendment must explain what problem it solves, what authority it changes or leaves unchanged, what tests enforce it, what documentation is updated, and what new failure modes it introduces. Convenience alone is not sufficient rationale for weakening a boundary.

When requirements conflict, maintainers should prefer the interpretation that preserves user control, minimizes authority, limits data, and produces the most honest observable state. Ambiguity should lead to a clarifying question or a conservative refusal, not a broad assumption.

A contributor may propose a feature that is intentionally outside the current Constitution, but the proposal must say so before implementation. Hidden exceptions are prohibited. A feature that needs network access, persistent background execution, remote mutation, arbitrary code loading, secret collection, or recursive delegation receives a specific security and governance review rather than being smuggled in as a minor refactor.

Documentation is part of governance. If a command, environment variable, provider preset, protocol event, or safety guarantee changes, the README, architecture guidance, security guidance, provider documentation, protocol schema, changelog, and tests should be reviewed for synchronization. Historical release notes should not be rewritten to claim behavior that did not exist at the time.

## Article XVII — The release oath

Before calling Forge v1.0 complete, maintainers should be able to answer the following questions in writing. What can the supervisor do, and what can the worker never do? Which actions require approval, and which are denied regardless of approval? How does Forge behave with no provider, no Daytona credential, no MCP server, no GitHub login, and no interactive terminal? What happens when context is pruned, history is compacted, a provider fails, a tool returns malformed data, a retry is exhausted, a subprocess hangs, a workspace drifts, or a remote cleanup fails?

Maintainers should also be able to show a user-facing path for each answer. The user should be able to view a plan, follow a checklist, deny an action, inspect a session, review an audit log, inspect verification evidence, understand a blocked state, and recover without replaying a mutation automatically. If any of these paths exist only in internal code or undocumented assumptions, the feature is not finished.

Finally, maintainers should be able to state what has not been proven. They should disclose unsupported provider features, untested network conditions, unavailable live credentials, incomplete model review, dependency limitations, and unresolved hypotheses. A trustworthy product is not one that claims perfection. It is one that makes its boundaries and uncertainties difficult to miss.

## Appendix A — Practical decision rules

When deciding whether to add a capability, ask whether it increases authority, data exposure, persistence, external reach, or irreversibility. If the answer is yes, introduce the smallest explicit boundary that contains the increase, make the action visible, require the appropriate approval, add refusal tests, and document the lifecycle. If the answer is no, still add bounds and regression tests because harmless-looking parsers and renderers can become denial-of-service or disclosure paths.

When deciding whether to retry, ask whether the operation is safe to reconsider, whether the failure is actually retryable, whether a different strategy exists, and whether the user can see the attempt. Never retry destructive or remote mutation merely because the provider returned an error. Never retry an approval denial as though it were a transient network fault. Never allow retries to exceed the recorded budget.

When deciding whether to send context, ask whether the file is relevant, whether it is sensitive, whether the user expects it to leave the machine, whether the provider is configured, and whether the content fits the bounded budget. If a smaller context is sufficient, use it. If context is missing, say so. If the provider cannot be trusted for the requested data, remain local or refuse.

When deciding whether to optimize, ask whether the change reduces duplicate work while preserving the same quality gates. Reuse safe metadata before reusing uncertain conclusions. Prune context before reducing verification. Reduce redundant roles before removing required review. Measure before claiming improvement. Make the optimization visible in telemetry and docs.

## Appendix B — Minimum event and evidence vocabulary

Forge should preserve clear distinctions among proposal, approval, result, repair, checklist, plan, audit, completion, and error. A proposal identifies a requested tool, risk, arguments, and reason. An approval identifies a decision and bounded scope. A result identifies whether the supervisor executed the proposal and what bounded evidence returned. A repair identifies an alternate or deep-thinking attempt and its outcome. A checklist identifies observable stage state and user expectation. A completion identifies terminal status and summary. An error identifies a bounded category and message.

Verification evidence should include the command or check identity, status, exit code when relevant, bounded output, duration, truncation state, timestamp, workspace fingerprint, and command digest where the existing contract supports those fields. Evidence does not authorize a rerun. A stale fingerprint does not erase historical evidence; it changes how that evidence may be interpreted for the current workspace.

## Appendix C — Definition of “done”

A Forge feature is done when its user contract, authority boundary, failure states, persistence behavior, protocol shape, documentation, tests, and release impact agree. A Forge release is done when the full gate passes, the working tree and published revision are known, fresh-clone verification succeeds, and the final report states both verified capabilities and meaningful limitations. A Forge Constitution is honored when maintainers choose the honest, bounded, reviewable path even when an invisible shortcut would be faster.

This Constitution is a living engineering commitment. It should guide implementation, review, support, and future releases. It should make Forge more capable without making it less accountable. It should help users move quickly without making them guess what happened. Above all, it should keep the person who owns the code in control of the system that changes it.

## References

1. [Forge security model](./SECURITY.md)
2. [Forge architecture](./ARCHITECTURE.md)
3. [Forge provider guide](./PROVIDERS.md)
4. [Forge protocol README](../packages/protocol/README.md)
5. [Forge v0.99 Daytona research](./V0.99_DAYTONA_RESEARCH.md)
