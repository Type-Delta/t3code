/**
 * Server-internal provider conversation cursor capability.
 *
 * Payloads crossing this boundary are versioned envelopes whose inner value
 * is decoded only by the owning provider adapter. This service deliberately
 * has no transport/shared-contract representation.
 */
import * as Context from "effect/Context";

import type { ProviderConversationNavigationShape } from "./ProviderService.ts";

export class ProviderConversationNavigation extends Context.Service<
  ProviderConversationNavigation,
  ProviderConversationNavigationShape
>()("t3/provider/Services/ProviderConversationNavigation") {}

export type {
  ProviderConversationBinding,
  ProviderConversationCheckpoint,
  ProviderConversationCursor,
  ProviderConversationNavigationShape,
} from "./ProviderService.ts";
