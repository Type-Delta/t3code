# Share T3 Code with several users on one computer

The multi-user gateway is available in this fork on Linux with systemd, macOS on Apple
silicon, and Windows.
Each enrolled account gets its own T3 Code server, projects, settings, and provider
credentials. Browsers and phones connect to a single gateway address.

Use it on a trusted computer with trusted users and an IPv4 LAN or tailnet. The gateway
uses HTTP on port 3773 by default. Use one browser profile per person on each gateway,
since everyone on it shares one browser origin. Other services on the same hostname can
receive gateway cookies. Guest links, webhooks, and outside agents connecting over MCP use
each user's T3 Connect address.

Each enrolled user's backend uses their existing T3 Code data, so their projects and
threads carry over. A desktop app built from this fork finds the gateway and uses its
user's shared server instead of starting its own. Other desktop builds start their own
server on the same data, so have those users quit them before they join and not run them
alongside the gateway.

## Install and enroll a user

The simplest install is this fork's command-line installer run as an administrator. On
Linux and macOS:

```sh
curl -fsSL https://raw.githubusercontent.com/Type-Delta/t3code/main/scripts/install.sh | sudo sh
```

On Windows, from an elevated PowerShell:

```powershell
irm https://raw.githubusercontent.com/Type-Delta/t3code/main/scripts/install.ps1 | iex
```

It asks once whether to install
T3 Code for everyone on this computer; answer yes. To answer without the question, set
`T3CODE_INSTALL_MODE=gateway`. After that, users join from the desktop app (see
[Join from the desktop app](#join-from-the-desktop-app)), or an administrator enrolls them
with `t3 gateway add`.

To install from an archive instead, download the CLI archive for your operating system from this fork's GitHub release and check it against the release's `SHA256SUMS`. Extract it
into a private, administrator-owned folder, because the executable loads its bundled
libraries before the installer can check them. Then install the gateway and enroll each
person with their existing account name in place of `alice`.

Enrolling a user starts their backend under their account. Their provider CLIs and
credentials must be set up under that account. For a CLI installed in the user's home
directory, add it to their PATH or configure its full executable path in T3 Code.

If the printed pairing links use the wrong network address, set `publicUrl` in the
gateway config to the HTTP origin your devices can reach, including the port if needed.
The install and uninstall commands refuse config or pairing folder path overrides.

### Linux

```sh
archive=/path/to/t3-linux-archive.tar.gz
release_dir="$(sudo mktemp -d /root/t3code-release.XXXXXX)"
sudo tar --no-same-owner --no-same-permissions --strip-components=1 -xf "$archive" -C "$release_dir"
sudo "$release_dir/t3" gateway install
sudo t3 gateway add alice
```

The config is `/etc/t3code/gateway.json`. Check service logs with
`journalctl -u t3code-gateway.service` and `journalctl -u t3code@alice.service`.

### macOS

```sh
archive=/path/to/t3-darwin-archive.tar.gz
release_dir="$(sudo mktemp -d /var/root/t3code-release.XXXXXX)"
sudo tar -xf "$archive" -C "$release_dir" --strip-components=1
sudo chown -R root:wheel "$release_dir"
sudo chmod -R go-w "$release_dir"
sudo "$release_dir/t3" gateway install
sudo t3 gateway add alice
```

The install needs `/usr/local/bin` to be writable only by administrators. On Macs where
Homebrew owns `/usr/local`, it refuses to install. The config is
`/Library/Application Support/T3Code/gateway.json`, and logs are in `/Library/Logs/T3Code`.

### Windows

In an elevated PowerShell, extract the zip into a folder only administrators can change,
then run:

```powershell
.\t3.exe gateway install
t3 gateway add alice
```

The user must have signed in to Windows at least once. `t3 gateway add` asks once for
that user's Windows password so their backend can start at boot without them signed in.
The password isn't stored, and later password changes don't affect it. Enrolling also
grants the user "Log on as a batch job". The gateway itself runs as the system account.

The install allows port 3773 through Windows Firewall on private and domain networks. If
the computer's network is set to Public, the install warns you and shows how to change it.
The config is `%ProgramData%\T3Code\gateway.json`, and logs are in `%ProgramData%\T3Code\logs`.

## Join from the desktop app

When this computer has shared T3 Code, the desktop app offers to join it the first time it
starts. You can also join or leave later in Settings → Connections, under
**Shared T3 Code on this computer**. Joining starts your own server in the shared service,
which keeps running after you close the app, and the app restarts to use it. Your projects
and history stay. On Windows, joining asks for your Windows password once so your server
can start when you're signed out; T3 Code doesn't store it. Leaving stops your shared
server, keeps your data, and restarts the app with its own server.

When a member's desktop app is newer than the shared T3 Code, it updates the shared
installation to its own version before connecting. That restarts every member's server and
stops their running agent turns.

An administrator can turn off joining, leaving and updating by members by setting
`"selfService": false` in the gateway config. Updates download from this fork's GitHub
releases; to use a mirror, set `"updates": { "baseUrl": "..." }` to a location laid out like
`<baseUrl>/v<version>/<file>`.

## Pair a browser or phone

As the enrolled user, run:

```sh
t3 gateway pair
```

Open the printed pairing URL in your browser. On your phone, scan the terminal QR code
in the T3 Code app. On a computer with the desktop app, you can open the printed app link
instead. A phone app can be paired with one account on each gateway.
Pair phones one account at a time. If two accounts have pending pairings, wait for the
earlier code to expire before trying again.
After scanning another account's code on your phone, pair your own account again to switch back.

## Update or remove the gateway

Members' desktop apps keep the shared installation up to date (see above). To update by
hand, run the installer again as an administrator, or extract a newer archive the same way
and run its `gateway install`. The gateway and running backends restart, stopping any running agent
turns. The installer reports the restarted backends' states. To check them later, run
`t3 gateway list`. On Windows, if the installer names a user, run `t3 gateway add` for them
again.

Skip `t3 service install`, which would start a separate server.

To unenroll an account, run `t3 gateway remove alice` as an administrator. This stops its
backend and leaves the account's T3 Code data in place.
After renaming an enrolled account, remove it under its old name and add it again under the
new one.

To remove the shared service, run `t3 gateway uninstall` as an administrator. It removes
the services and installed runtime and keeps the gateway config, pairing folders, the
gateway's service account, and everyone's T3 Code data. On Windows, the running `t3.exe`
is deleted at the next restart. To start the backends again after reinstalling, run
`t3 gateway add` for each account you want to bring back.
