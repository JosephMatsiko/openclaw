# Frontier Lab Primitive Harvest — Chuck V3 Phase 0 Input

**Status**: DRAFT. Single-voice Codex synthesis, pending configured cross-family Fleet review (`anthropic / openai / google / perplexity / sovereign-local`). OpenAI is tagged as originating-family self-review for this artifact, not decisive independent ratification.

**Purpose**: harvest the strongest primitive from each serious agent stack without turning Chuck into a clone of any one product. A primitive enters Chuck only if it strengthens sovereignty, adjudication, evidence validation, execution safety, or compounding improvement.

**Core rule**: industry comparators supply primitives; Chuck filters them through verification, provenance, refusal, and operator doctrine.

| Stack                                                          | Adopted primitive                                                                                                                                             | Counter-design warning                                                                                                                 | Chuck implication                                                                                                                                                                                                                     | Verification status                                                                                         |
| -------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------- |
| Safe Superintelligence / Ilya Sutskever superalignment lineage | Safety and capability advanced together; weak-to-strong supervision; scalable oversight; adversarial pipeline testing; insulation from product-cycle pressure | SSI is a research mission, not an operable product surface. Do not turn "superintelligence" language into authority claims or mystique | Add a Superalignment Preparedness lane to Phase 0: stress-test whether weaker supervisors, local models, and Fleet reviewers can catch stronger-surface failures; keep safety ahead of autonomy before adding self-improvement powers | Verified from SSI official site and OpenAI superalignment/weak-to-strong research pages; details time-bound |
| OpenAI AgentKit / Agents SDK                                   | Evals, trace grading, guardrails, computer-use safety checks                                                                                                  | Do not outsource trust to hosted traces or one vendor's guardrail layer                                                                | Build local trace grading over Decision Records; require safety-check-style operator acknowledgement for high-risk computer-use actions                                                                                               | Verified from official docs                                                                                 |
| Anthropic Claude Code / MCP / Computer Use                     | Permission-first coding, MCP trust prompts, sandbox guidance for computer use                                                                                 | MCP servers are not audited by Anthropic; computer use in logged-in environments is prompt-injection sensitive                         | Treat every MCP/Skill/tool server as untrusted until quarantined; default to read-only and fail-closed permissions                                                                                                                    | Verified from official docs                                                                                 |
| Google ADK / Agent Platform                                    | Agent/tool/callback abstractions, deterministic workflow agents, deployment/eval posture                                                                      | Tool limitations and cloud coupling can hide execution constraints                                                                     | Model Chuck workflows as explicit controllers first, LLM agents second; callbacks become Kernel hooks                                                                                                                                 | Verified from official docs                                                                                 |
| AWS Bedrock / AgentCore                                        | Runtime isolation, guardrails, memory, browser/code execution as managed primitives                                                                           | Enterprise convenience can blur data-boundary and vendor-lock decisions                                                                | Mirror the isolation pattern locally: every browser/code run gets a scoped sandbox, receipt, and rollback plan                                                                                                                        | Verified from official docs where available; details time-bound                                             |
| Microsoft Agent Framework                                      | Typed workflows, state management, middleware, telemetry, human-in-loop                                                                                       | Enterprise framework gravity favors cloud integration and multi-tenant assumptions                                                     | Use typed workflow/state patterns, but keep single-operator/local-first boundaries                                                                                                                                                    | Verified from official docs                                                                                 |
| LangGraph / LangChain                                          | Checkpointing, durable execution, pending writes, human-in-loop resumes                                                                                       | Generic graph frameworks do not enforce Chuck's epistemic discipline by default                                                        | Implement TaskCapsule checkpoints and replayable resumability without surrendering Kernel control                                                                                                                                     | Verified from official docs                                                                                 |
| Mistral Agents + Conversations                                 | Persistent conversation IDs, entries, client/server handoff controls                                                                                          | Cloud-stored conversation state can conflict with sovereignty defaults                                                                 | Adopt explicit conversation/session/event objects; keep storage local unless operator opts out                                                                                                                                        | Verified from official docs                                                                                 |
| Cohere                                                         | Fine-grained citations for tool outputs and grounded retrieval                                                                                                | Citation existence does not guarantee evidence correctness                                                                             | Require span-backed citations and validate cited spans before claims can influence decisions                                                                                                                                          | Verified from official docs                                                                                 |
| Meta / Llama Stack                                             | Open-weight/local agents, tool groups, safety shields, memory/RAG APIs                                                                                        | Local models may be less capable on frontier reasoning and can still share synthetic-data blind spots                                  | Keep sovereign-local as offline floor and capability-mismatch flag, not automatic equal-weight voter                                                                                                                                  | Verified from official docs                                                                                 |
| xAI / Grok                                                     | Long-context posture, function calling, built-in web/X/code tools, X/Twitter-native real-time context                                                         | Server-side built-ins execute outside local control and current-model claims are time-bound                                            | Treat xAI as the sixth configured family after local session probe passed; strongest value is live-social evidence and X-originating claims                                                                                           | Verified from official docs plus local session probe; model claims time-bound                               |
| DeepSeek                                                       | OpenAI-compatible endpoint, strict function/tool schema mode                                                                                                  | Hosted/no-login surfaces have unresolved trust-boundary and attribution concerns                                                       | Keep as research note only until Joseph reopens it; no operational family, no default surface, no Fleet vote                                                                                                                          | Verified from official docs; deliberately excluded operationally                                            |
| Alibaba / Qwen / Model Studio                                  | OpenAI-compatible routing, Qwen/DeepSeek/GLM/Kimi surface, parallel tool-calling support                                                                      | Provider-router surfaces can blur actual model family attribution                                                                      | If used, receipts must record actual model/family, not just Model Studio as a surface                                                                                                                                                 | Verified from official docs                                                                                 |
| Moonshot / Kimi                                                | OpenAI-compatible API, long-context/thinking/tool surface, official web-search/memory tools                                                                   | Official tools can become hidden state outside Chuck's Vault                                                                           | Use as optional long-context family; keep memory writes inside Chuck's local provenance graph                                                                                                                                         | Verified from official docs                                                                                 |
| Perplexity / Comet / Computer / Personal Computer              | Search-native UX, Spaces-style project context, Comet/browser controls, Mac-native always-on product feel                                                     | Product polish can hide disagreements, evidence truncation, and proprietary orchestration                                              | Borrow the product feel and search surfaces; do not copy synthesis-as-truth. Route through Evidence + Fleet + Kernel                                                                                                                  | Verified from official docs; product details time-bound                                                     |
| OpenClaw / ClawHub                                             | Channel/tool chassis, skill marketplace, local assistant loop, sandbox knobs                                                                                  | Public skill/plugin firehose is a supply-chain risk; host tools may run with broad local permissions                                   | Keep OpenClaw as hands/channels; quarantine ClawHub installs before enablement; no core fork dependency                                                                                                                               | Verified from official docs and local repo                                                                  |

## Stack Notes

### OpenAI AgentKit / Agents SDK

- **Adopt**: eval flywheel, trace grading, guardrails, computer-use safety acknowledgements.
- **Counter-design**: hosted traces and one-vendor guardrails are not authority.
- **Chuck move**: local Decision Records become the trace corpus; high-risk computer-use actions require Kernel acknowledgement.

### Safe Superintelligence / Ilya Sutskever Superalignment Lineage

- **Adopt**: safety and capability are one engineering problem, not two workstreams; weaker supervisors need help evaluating stronger systems; alignment pipelines need adversarial stress tests before authority increases.
- **Counter-design**: SSI does not currently provide a usable Chuck surface, model family, connector, or API primitive. Treat it as a research and discipline source, not a vendor capability.
- **Chuck move**: Phase 0 gets a Superalignment Preparedness lane: weak-supervisor/strong-surface tests, adversarially trained failure cases, red-team detection drills, and "safety-ahead-of-capability" gates before Self-Improvement Lab or long-horizon autonomy.

### Anthropic Claude Code / MCP / Computer Use

- **Adopt**: read-only default posture, explicit permission gates, MCP trust prompts, sandbox warnings.
- **Counter-design**: MCP servers and computer-use environments are external attack surfaces.
- **Chuck move**: every MCP server, Skill, and plugin starts untrusted and enters through quarantine.

### Google ADK / Agent Platform

- **Adopt**: agents/tools/callbacks and workflow agents as explicit control points.
- **Counter-design**: tool compatibility limitations and cloud coupling can become hidden constraints.
- **Chuck move**: callbacks become Kernel hooks; workflows are deterministic controllers with LLMs inside bounded steps.

### AWS Bedrock / AgentCore

- **Adopt**: modular runtime, memory, gateway, identity, code interpreter, browser, observability, evaluations, policy, registry.
- **Counter-design**: managed convenience can blur sovereignty and data-boundary decisions.
- **Chuck move**: reproduce the pattern locally: isolated sessions, scoped tool identity, receipt-backed browser/code runs, policy before execution.

### Microsoft Agent Framework

- **Adopt**: typed workflows, state isolation, checkpointing, middleware, telemetry, human-in-loop gates.
- **Counter-design**: enterprise framework assumptions trend toward cloud and multi-tenant surfaces.
- **Chuck move**: use the typed workflow lesson while preserving single-operator, local-first state.

### LangGraph / LangChain

- **Adopt**: checkpointing, pending writes, resume from supersteps, human-in-loop.
- **Counter-design**: generic orchestration does not enforce no-simple-majority, Vault scope, or refusal.
- **Chuck move**: TaskCapsules get checkpoint/resume semantics, but Kernel remains the controller.

### Mistral Agents + Conversations

- **Adopt**: explicit Agent, Conversation, Entry objects and client/server handoff choice.
- **Counter-design**: stored conversation state can violate local-first defaults.
- **Chuck move**: model sessions as explicit local objects; cloud storage is opt-in and recorded.

### Cohere

- **Adopt**: fine-grained citation objects over tool outputs and document IDs.
- **Counter-design**: citation presence is not proof of correctness.
- **Chuck move**: claims need span-backed citations, and cited spans must verify before claim weighting.

### Meta / Llama Stack

- **Adopt**: local/open-weight agents, tool groups, shields, memory/RAG APIs.
- **Counter-design**: local does not automatically mean high-capability or independent.
- **Chuck move**: sovereign-local stays essential as offline floor and mismatch flag; complex-task vote weight remains capability-aware.

### xAI / Grok

- **Adopt**: long-context posture, function calling, built-in search/code tool shape, and X/Twitter-native real-time context.
- **Counter-design**: server-side built-ins execute outside Chuck's local control.
- **Chuck move**: sixth configured family; best used for live-social monitoring, incident awareness, zeitgeist detection, and claims originating on X before they are documented elsewhere. Tool use must be receipt-attributed and local execution preferred when possible.

### DeepSeek

- **Adopt**: OpenAI-compatible endpoint and strict function/tool schema mode.
- **Counter-design**: compatibility can mask family correlation and cheap overuse; hosted/no-login surfaces do not satisfy Chuck's trust boundary.
- **Chuck move**: excluded from operational Fleet until further notice. Keep only as historical/research context unless Joseph explicitly reopens a local-only experiment.

### Alibaba / Qwen / Model Studio

- **Adopt**: OpenAI-compatible routing surface, parallel tool-call behavior, broad model catalog.
- **Counter-design**: a provider router is not a producing family.
- **Chuck move**: receipts must record actual model/family behind the surface.

### Moonshot / Kimi

- **Adopt**: OpenAI-compatible API, long-context/thinking modes, official web-search/memory tools.
- **Counter-design**: official memory tools can create hidden state outside the Vault.
- **Chuck move**: use for long-context coverage only when memory/provenance stays local and explicit.

### Perplexity / Comet / Computer / Personal Computer

- **Adopt**: search-native UX, project Spaces, Comet/browser controls, Mac-native always-on product feel.
- **Counter-design**: polished synthesis can hide disagreement, truncation, and proprietary orchestration.
- **Chuck move**: borrow product feel and source surfaces; route claims through Evidence + Fleet + Kernel.

### OpenClaw / ClawHub

- **Adopt**: channels, tools, local assistant loop, Skills/ClawHub firehose, sandbox knobs.
- **Counter-design**: public skills/plugins are a supply-chain surface; host tools can be broad.
- **Chuck move**: OpenClaw remains hands/channels; Chuck governs skill installation, action authority, and execution arbitration.

## Cross-Stack Primitives To Carry Into V3

1. **Trace-grade everything**: OpenAI/Microsoft/LangGraph converge on traceability. Chuck's Decision Record corpus is the local-first version.
2. **Sandbox before autonomy**: OpenAI, Anthropic, Perplexity, AWS, and OpenClaw all point toward isolation for computer-use/tool execution. Chuck makes sandbox receipts mandatory.
3. **Citations need verification**: Cohere and Perplexity make citations product-visible; Chuck requires cited spans to exist and be hash-linked.
4. **Workflow controllers beat free-form agents**: Google ADK, Microsoft Agent Framework, and LangGraph all validate explicit workflow shape. Chuck's Kernel is the controller.
5. **Provider compatibility is not family independence**: Qwen, Kimi, xAI, Perplexity, and any future provider-compatible surface can extend coverage, but receipts must prove actual producing family. DeepSeek remains excluded operationally until reopened.
6. **Product feel matters, but doctrine governs**: Perplexity and OpenClaw show the ergonomic target. Chuck should feel alive and capable without hiding disagreement or skipping refusal.
7. **Safety must stay ahead of autonomy**: SSI and OpenAI's superalignment work sharpen the rule that stronger systems cannot be trusted just because weaker supervisors approve them. Chuck needs weak-to-strong calibration, adversarial tests, and refusal gates before self-improvement or long-horizon powers expand.

## Sources

- OpenAI Agent evals: https://platform.openai.com/docs/guides/agent-evals
- OpenAI Agents / AgentKit: https://platform.openai.com/docs/guides/agents
- OpenAI trace grading: https://platform.openai.com/docs/guides/trace-grading
- OpenAI computer use: https://platform.openai.com/docs/guides/tools-computer-use
- SSI official site: https://ssi.inc/
- OpenAI Superalignment: https://openai.com/index/introducing-superalignment/
- OpenAI weak-to-strong generalization: https://openai.com/index/weak-to-strong-generalization/
- Anthropic Claude Code security: https://docs.anthropic.com/en/docs/claude-code/security
- Anthropic MCP: https://docs.anthropic.com/en/docs/claude-code/mcp
- Anthropic computer use: https://docs.anthropic.com/en/docs/build-with-claude/computer-use
- Google ADK overview: https://google.github.io/adk-docs/
- Google ADK tools: https://google.github.io/adk-docs/tools/
- Google ADK callbacks: https://google.github.io/adk-docs/callbacks/
- AWS Bedrock AgentCore overview: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/what-is-bedrock-agentcore.html
- AWS AgentCore Browser: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/browser-tool.html
- AWS AgentCore Runtime: https://docs.aws.amazon.com/bedrock-agentcore/latest/devguide/agents-tools-runtime.html
- Microsoft Agent Framework: https://learn.microsoft.com/en-us/agent-framework/overview/
- Microsoft Agent Framework workflows: https://learn.microsoft.com/en-us/agent-framework/journey/workflows
- LangGraph checkpointing: https://langchain-ai.github.io/langgraphjs/reference/modules/langgraph-checkpoint.html
- Mistral Agents and Conversations: https://docs.mistral.ai/agents/agents
- Cohere tool-use citations: https://docs.cohere.com/docs/tool-use-citations
- Llama Stack agents: https://llama-stack.readthedocs.io/en/latest/providers/agents/index.html
- xAI function calling: https://docs.x.ai/docs/guides/function-calling
- DeepSeek function calling: https://api-docs.deepseek.com/guides/function_calling/
- Alibaba/Qwen function calling: https://www.alibabacloud.com/help/en/model-studio/qwen-function-calling
- Kimi API overview: https://platform.kimi.ai/docs/api/overview
- Perplexity Computer: https://www.perplexity.ai/help-center/en/articles/13837784-what-is-computer
- Perplexity Personal Computer: https://www.perplexity.ai/help-center/en/articles/14659663-what-is-personal-computer
- Perplexity Spaces: https://www.perplexity.ai/help-center/en/articles/10352961-what-are-spaces/
- Perplexity Comet enterprise controls: https://www.perplexity.ai/help-center/en/articles/12781449-comet-for-enterprise
- Perplexity Comet policies: https://www.perplexity.ai/help-center/en/articles/13529668-comet-policies-and-controls
- OpenClaw GitHub: https://github.com/openclaw/openclaw
- OpenClaw ClawHub docs: https://docs.openclaw.ai/clawhub
