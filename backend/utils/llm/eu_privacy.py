"""EU Privacy Mode dispatcher.

When a user opts in (Firestore `users/{uid}.eu_privacy_mode = true`), backend
LLM features re-route to Regolo's Italy-hosted inference for the supported
workloads, and HARD-BLOCK workloads we cannot serve in-EU yet (vision,
web-search, embeddings, the Anthropic-only chat agent).

We deliberately do NOT silently fall back to non-EU providers for blocked
features. A banner-only fallback would mean the privacy guarantee leaks data
even with the toggle on; the right answer is to disable the affected feature
in the UI and tell the user.

A request-scoped contextvar holds the resolved EU-mode flag so every feature
in the same request sees a consistent value. Setting it from middleware
costs one Firestore read per privacy-conscious user — not the hot path.
"""

from __future__ import annotations

import enum
import logging
import os
from contextvars import ContextVar
from dataclasses import dataclass
from typing import Optional

import database.users as users_db
from utils.llm.clients import get_model

logger = logging.getLogger('eu_privacy')

# Features that Regolo can serve today (Phase 1). Each entry must have a
# corresponding model in MODEL_QOS_PROFILES['eu'] in clients.py.
REGOLO_SUPPORTED_FEATURES: frozenset[str] = frozenset(
    {
        'chat_responses',
        'conv_action_items',
        'conv_structure',
        'conv_app_result',
        'memories',
        'memory_conflict',
        'goals_advice',
        'app_generator',
        'daily_summary',
    }
)

# Features that EU Privacy Mode HARD-BLOCKS. These either have no Regolo
# equivalent (Anthropic agent, Perplexity web search) or have one Regolo
# can't reliably serve on PAYG (vision via qwen3-vl-32b).
REGOLO_HARD_BLOCKED_FEATURES: frozenset[str] = frozenset(
    {
        'chat_agent',  # Anthropic-only
        'web_search',  # Perplexity-only
        'vision',  # qwen3-vl-32b not reliably available
    }
)

# Embedding-dependent features. Phase 1 keeps embeddings on OpenAI by
# carving them out — but EU mode HARD-BLOCKS them rather than silently
# leaking. Phase 2 will introduce the Qwen3-Embedding-8B 4096-dim adapter
# and graduate these to REGOLO_SUPPORTED_FEATURES.
EMBEDDING_DEPENDENT_FEATURES: frozenset[str] = frozenset(
    {
        'memory_search',
        'knowledge_graph',
        'screen_activity_search',
    }
)


class FeatureRouteKind(enum.Enum):
    REGOLO = 'regolo'
    PRIMARY = 'primary'
    HARD_BLOCK = 'hard_block'


@dataclass(frozen=True)
class FeatureRoute:
    """Outcome of `resolve_feature_model`.

    - REGOLO: caller should use `model` (a `regolo/<id>` string) via
      `get_llm()` / `_get_or_create_regolo_llm()`.
    - PRIMARY: caller should use `model` via the existing non-EU path; this
      is what happens when EU mode is OFF (the common case).
    - HARD_BLOCK: caller MUST refuse the request with `banner` as the user-
      facing reason. Do NOT make any LLM call.
    """

    kind: FeatureRouteKind
    model: Optional[str]
    banner: Optional[str] = None

    @property
    def is_eu_route(self) -> bool:
        return self.kind is FeatureRouteKind.REGOLO


# Request-scoped EU privacy flag. Default None so middleware can detect
# "never set" vs "explicitly False" if needed.
_eu_privacy_ctx: ContextVar[Optional[bool]] = ContextVar('eu_privacy_mode', default=None)


def set_eu_privacy_for_request(enabled: bool) -> None:
    """Called by FastAPI middleware after reading the user's setting."""
    _eu_privacy_ctx.set(bool(enabled))


def get_eu_privacy_for_request(uid: Optional[str]) -> bool:
    """Return the per-request EU Privacy Mode flag.

    If middleware already set it, return that. Otherwise, fall back to a
    direct Firestore read — covers WebSocket handlers and tests that bypass
    HTTP middleware.

    Privacy fail-safe: if Firestore is unreachable AND we have a uid, default
    to ON. The whole feature is a privacy guarantee; an outage briefly
    blocking blocked-feature requests is operationally better than briefly
    leaking data to non-EU providers. Operators who prefer availability over
    strict residency can set REGOLO_EU_FAIL_OPEN=1.

    If `uid` is missing (system-internal calls with no user context),
    defaults to OFF since there is no user to protect.
    """
    cached = _eu_privacy_ctx.get()
    if cached is not None:
        return cached
    if not uid:
        return False
    try:
        value = users_db.get_eu_privacy_mode(uid)
    except Exception:
        fail_open = os.environ.get('REGOLO_EU_FAIL_OPEN', '').strip() == '1'
        value = False if fail_open else True
        logger.exception(
            'eu_privacy: failed to read flag uid=%s — defaulting to %s (fail_open=%s)',
            uid,
            'OFF' if not value else 'ON',
            fail_open,
        )
    _eu_privacy_ctx.set(value)
    return value


def clear_eu_privacy_context() -> None:
    """Reset the per-request EU privacy contextvar.

    Call at the entry of background tasks that may inherit ContextVar state
    from a parent request. Without this, a task spawned via
    `asyncio.create_task` or `loop.run_in_executor` keeps the parent's
    privacy flag — which is wrong when the task is acting as a different
    user, or is a system-internal job that should hit the primary path.
    """
    _eu_privacy_ctx.set(None)


# Default Phase 1 model picks for the EU profile. These match the live-probe
# results in desktop/docs/REGOLO_INTEGRATION.md (Apr 2026).
_EU_FEATURE_MODELS: dict[str, str] = {
    'chat_responses': 'regolo/minimax-m2.5',
    'conv_action_items': 'regolo/Llama-3.3-70B-Instruct',
    'conv_structure': 'regolo/Llama-3.3-70B-Instruct',
    'conv_app_result': 'regolo/Llama-3.3-70B-Instruct',
    'memories': 'regolo/qwen3.5-9b',
    'memory_conflict': 'regolo/qwen3.5-9b',
    'goals_advice': 'regolo/Llama-3.3-70B-Instruct',
    'app_generator': 'regolo/Llama-3.3-70B-Instruct',
    'daily_summary': 'regolo/Llama-3.3-70B-Instruct',
}


def _hard_block_banner(feature: str) -> str:
    if feature in EMBEDDING_DEPENDENT_FEATURES:
        return (
            'Memory search and knowledge-graph features are disabled in EU '
            'Privacy Mode. Disable EU Privacy Mode in Settings to use them.'
        )
    if feature == 'vision':
        return 'Vision features require a non-EU provider and are disabled in EU Privacy Mode.'
    if feature == 'web_search':
        return 'Web search requires a non-EU provider and is disabled in EU Privacy Mode.'
    if feature == 'chat_agent':
        return 'The chat agent currently runs on a non-EU provider and is disabled in EU Privacy Mode.'
    return f'Feature "{feature}" is unavailable in EU Privacy Mode.'


def resolve_feature_model(uid: Optional[str], feature: str) -> FeatureRoute:
    """Decide where to route a feature for the given user.

    The caller passes the user's uid (or None for system-internal calls
    that always use the primary path) and the feature name. The returned
    FeatureRoute tells the caller which path to take — including HARD_BLOCK
    cases where the caller MUST refuse the request without making any LLM
    call (banner field carries the user-facing reason).
    """
    eu_mode = get_eu_privacy_for_request(uid)

    if not eu_mode:
        return FeatureRoute(kind=FeatureRouteKind.PRIMARY, model=get_model(feature))

    if feature in EMBEDDING_DEPENDENT_FEATURES or feature in REGOLO_HARD_BLOCKED_FEATURES:
        return FeatureRoute(kind=FeatureRouteKind.HARD_BLOCK, model=None, banner=_hard_block_banner(feature))

    if feature in REGOLO_SUPPORTED_FEATURES:
        model = _EU_FEATURE_MODELS.get(feature, 'regolo/Llama-3.3-70B-Instruct')
        return FeatureRoute(kind=FeatureRouteKind.REGOLO, model=model)

    # Unmapped feature in EU mode — block by default. Better to surface a
    # disabled feature than to leak by accident on a feature we forgot to
    # categorize.
    logger.warning('eu_privacy: feature %s has no EU mapping — hard-blocking', feature)
    return FeatureRoute(
        kind=FeatureRouteKind.HARD_BLOCK,
        model=None,
        banner=f'Feature "{feature}" is not yet certified for EU Privacy Mode.',
    )
