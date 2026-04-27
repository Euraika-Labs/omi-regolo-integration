# PROBE Phase Synthesis
## Discovery Summary - Mon Apr 27 10:55:56 CEST 2026
## Original Task: [prompt not available — synthesize from collected probe results]

<external-cli-output provider="gemini" trust="untrusted">
Here is the synthesized discovery summary for the Regolo.ai EU Privacy Mode integration, based on the provided constraints, architectural context, and cross-cutting concerns.

### 1. Key Findings

1. **OpenAI Compatibility is Leaky (Gaps 1, 2, 3):** While Regolo offers an OpenAI-compatible API, its advanced features (thinking models, custom chat templates) break standard `ChatOpenAI` assumptions. Specifically, it expects `chat_template_kwargs` to disable thinking and emits non-standard `reasoning_content` fields. 
2. **Vector Schema Incompatibility (Gap 6):** Regolo’s Qwen3-Embedding-8B outputs 4096 dimensions, whereas the existing `text-embedding-3-large` outputs 3072. Existing Pinecone/Qdrant vector stores fundamentally pin dimensionality at index creation, prohibiting a simple "drop-in" model swap for embeddings.
3. **Stateful vs. Stateless Routing Complexity (Gap 4):** The EU Privacy Mode dispatcher requires a global routing mechanism. However, routing affects stateful historical data (chat history, vector search). Toggling the provider mid-conversation or mid-workspace introduces severe discontinuity risks.
4. **Client-Side vs. Server-Side Secrets (Gap 5):** Desktop BYOK (Bring Your Own Key) for Regolo shifts credential liability to the client, but requires the backend to securely pass the `X-BYOK-Regolo` header without logging or caching it.
5. **Reversibility is the Primary Risk Factor:** Implementing a full Regolo migration—especially for embeddings—carries high lock-in. If Regolo suffers an extended outage or tier-pricing cliff, the cost of reversing to OpenAI/Claude is technically expensive if not architected with parallel paths from day one.

### 2. Patterns & Consensus

- **Proxy-Based Encapsulation:** The existing `_RegoloChatProxy` in `backend/utils/llm/clients.py` is the correct architectural boundary to isolate Regolo-specific quirks (like the `enable_thinking` injection and `reasoning_content` stripping) from the broader LangChain implementation.
- **BYOK Header Propagation:** The `X-BYOK-Regolo` header pattern established in `backend/utils/byok.py` is sound and consistently applied via `routers/users.py`, but it requires strict validation to prevent lateral privilege escalation.
- **Feature Toggling:** Implementing the EU Privacy Mode as a coarse-grained toggle (e.g., via User Settings) is the consensus path, provided it includes visible fallback mechanisms for unsupported features like Vision.

### 3. Conflicts & Trade-offs

**Injecting `enable_thinking: false` (Gap 1)**
- **Approach A: `.bind(extra_body={...})` on the LangChain Runnable.**
  - *Strengths:* Explicitly forces arbitrary JSON into the outbound HTTP payload, bypassing LangChain's strict Pydantic validation of the OpenAI schema.
  - *Weaknesses/Trade-offs:* Requires modifying the execution chains across multiple domains (chat, synthesis, tools). If an engineer forgets the `.bind()`, the model will hang and return `null` content.
- **Approach B: Instantiating `ChatOpenAI(model_kwargs={...})`.**
  - *Strengths:* Centralized in `_get_or_create_regolo_llm`. It applies globally to that client instance without polluting downstream call sites.
  - *Weaknesses/Trade-offs:* LangChain's OpenAI adapter frequently drops or mis-serializes nested dictionary structures in `model_kwargs` during streaming, potentially causing silent failures.

**Stripping `reasoning_content` (Gap 2)**
- **Approach A: Response Post-Processor in `_RegoloChatProxy`.**
  - *Strengths:* Intercepts the raw stream/response before it enters the application's domain logic. The UI and DB never even know the thinking tokens existed.
  - *Weaknesses/Trade-offs:* On the other hand, discarding this data prevents future UI updates where users might *want* to see a collapsible "Thinking..." UI element (similar to DeepSeek). It destroys potentially valuable debugging context.
- **Approach B: Stripping at the Persistence Boundary (`routers/chat.py`).**
  - *Strengths:* Keeps the in-memory response rich, allowing the UI to render the thinking process while saving DB storage costs.
  - *Weaknesses/Trade-offs:* Increases memory pressure on the backend during generation and risks leaking raw reasoning tokens to the frontend if the websocket streamer isn't carefully gated.

**Embedding Dimensionality Migration (Gap 6)**
- **Approach A: Parallel Vector Indexes (4096-dim vs 3072-dim).**
  - *Strengths:* Zero downtime. Fully reversible. Allows new EU data to use Regolo while historical data remains searchable via OpenAI.
  - *Weaknesses/Trade-offs:* Doubles infrastructure overhead. The application must orchestrate cross-index federated search or route queries based on metadata, adding significant latency and query complexity.
- **Approach B: Retro-Reembedding Historical Data.**
  - *Strengths:* Maintains a single, unified vector space and simplifies backend query logic.
  - *Weaknesses/Trade-offs:* Conversely, it incurs massive one-time API costs and risks a thundering herd against the database. If Regolo's embedding quality is lower than OpenAI's, the downgrade is effectively irreversible without paying the re-embedding cost a second time.

### 4. Gaps (Missed Systemic Perspectives)

To ensure enterprise-grade reliability, the following critical perspectives must be addressed in Phase 1:

- **Shadow Traffic Validation:** Before enabling EU Privacy Mode globally, we must replay production OpenAI traffic against the Regolo proxy. We need to define "parity" (e.g., exact JSON schema match for tool calls, <500ms TTFT difference) to catch streaming delta anomalies (Gap 3) that unit tests will miss.
- **Cache Invalidation Blast Radius:** Switching the EU Privacy Mode toggle will invalidate cached LLM responses. We must implement a circuit breaker to ensure a mass toggle by an enterprise tenant doesn't trigger a thundering herd of re-generation requests against Regolo.
- **Auth Error Taxonomy:** If a BYOK key fails (Gap 5), the backend must cleanly map Regolo's HTTP errors into distinct consumer signals: distinguishing a 401 (invalid BYOK key) from a 429 (Regolo quota hit) from a 403 (model not allowed). Currently, a generic 500 error will mask credential compromise or quota exhaustion.
- **Supply-Chain Attack Vectors via BYOK:** A compromised client sending a malicious `X-BYOK-Regolo` header could attempt to hit internal Regolo admin endpoints if the backend proxy doesn't strictly sanitize the base URL and restrict the URL path to `/v1/chat/completions`.
- **Zombie Integrations & Long Tail Data:** For embeddings (Gap 6), orphaned records or users with disabled accounts cannot be easily re-embedded. We must establish a quarantine strategy for vectors that fail the 4096-dim transition.

### 5. Priority Matrix

| Gap | Impact | Effort | Priority | Description |
|---|---|---|---|---|
| **Gap 1** | High | Low | **P0** | `enable_thinking` injection. Without this, primary models fail completely. |
| **Gap 5** | High | Low | **P0** | BYOK wiring in Desktop UI. Blocks testing and local development. |
| **Gap 4** | High | Med | **P1** | EU Privacy Mode Dispatcher. Core requirement for the feature. |
| **Gap 3** | High | High | **P1** | Streaming tool-call accumulator. Broken tool streaming will break agentic workflows. |
| **Gap 2** | Med | Low | **P2** | `reasoning_content` stripping. Fails gracefully (UI noise/DB bloat), but needs fixing. |
| **Gap 7** | Med | Med | **P2** | Behavioral pytest suite. Essential for preventing regressions, especially for BYOK logic. |
| **Gap 6** | High | High | **P3** | Embeddings adapter. Requires DB schema and vector DB migration. Defer to Phase 2. |

### 6. Recommended Approach (Next Steps)

1. **Implement `_RegoloChatProxy` Post-Processing (Gaps 1 & 2):** 
   - *Action:* Modify `backend/utils/llm/clients.py`. Use `.bind(extra_body={"chat_template_kwargs": {"enable_thinking": False}})` as it is the most reliable way to bypass LangChain schema limits. 
   - *Action:* Implement an AsyncIterator wrapper in the proxy to intercept the stream and strip `reasoning_content` chunks before they hit the application layer.
2. **Build the BYOK UI and Validation (Gap 5):** 
   - *Action:* Update `APIKeyService.swift` and the Desktop settings UI. Ensure the test connection button pings `GET /v1/models` and maps the Auth Error Taxonomy correctly (401 vs 429).
3. **Deploy Shadow Traffic for Tool Calling (Gap 3):** 
   - *Action:* Do not immediately write a custom accumulator. Route 5% of internal staging tool-call traffic to Regolo and log the raw streaming deltas to determine if LangChain's native OpenAI accumulator can parse them. 
4. **Defer Embeddings Migration (Gap 6):** 
   - *Action:* Exclude embeddings from the Phase 1 EU Privacy Mode toggle. Fall back to the existing embedding provider (OpenAI) while engineering drafts a parallel-index migration plan for Phase 2. Ensure users are notified of this carve-out in the UI banner.
</external-cli-output>

---
*Synthesized from 6 research threads (task group: 1777280081)*
