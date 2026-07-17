import * as Effect from "effect/Effect";
import * as Layer from "effect/Layer";

import { ProviderService } from "../Services/ProviderService.ts";
import { ProviderConversationNavigation } from "../Services/ProviderConversationNavigation.ts";

const makeProviderConversationNavigation = Effect.gen(function* () {
  const providerService = yield* ProviderService;
  if (providerService.conversationNavigation === undefined) {
    return yield* Effect.die(
      new Error("ProviderService does not expose provider conversation navigation."),
    );
  }
  return providerService.conversationNavigation;
});

export const ProviderConversationNavigationLive = Layer.effect(
  ProviderConversationNavigation,
  makeProviderConversationNavigation,
);
