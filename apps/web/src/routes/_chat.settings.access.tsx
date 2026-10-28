import { createFileRoute } from "@tanstack/react-router";
import { ManagementApiKeysSettings } from "../components/settings/ManagementApiKeysSettings";
import { SettingsPageContainer } from "../components/settings/settingsLayout";
import { ConnectionsSettings } from "../components/settings/ConnectionsSettings";

function SettingsAccessRoute() {
  return (
    <>
      <ConnectionsSettings view="access" />
      <SettingsPageContainer>
        <ManagementApiKeysSettings />
      </SettingsPageContainer>
    </>
  );
}

export const Route = createFileRoute("/_chat/settings/access")({
  component: SettingsAccessRoute,
});
