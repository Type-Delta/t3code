# Share T3 Code on a Linux host

The multi-user gateway is available in this fork on Linux with systemd. Each enrolled Linux
account gets its own T3 Code server, projects, settings, and provider credentials. Browsers
and phones connect to a single gateway address.

Use it on a trusted host with trusted Linux users and an IPv4 LAN or tailnet. The gateway
uses HTTP on port 3773 by default. Use one browser profile per person on each gateway,
since everyone on it shares one browser origin. Other services on the same hostname can
receive gateway cookies. Guest links, webhooks, and outside agents connecting over MCP use
each user's T3 Connect address.

## Install and enroll a user

Use a Linux CLI archive you trust, built from this fork. Set `archive` to its path.
Extract it into a private, root-owned directory because the executable loads its bundled
libraries before the installer can check them.

```sh
archive=/path/to/t3-linux-archive.tar.gz
release_dir="$(sudo mktemp -d /root/t3code-release.XXXXXX)"
sudo tar --no-same-owner --no-same-permissions --strip-components=1 -xf "$archive" -C "$release_dir"
sudo "$release_dir/t3" gateway install
sudo t3 gateway add alice
```

Use the person's existing Linux username in place of `alice`. The gateway install puts
`t3` on the system PATH and starts the shared service. Enrolling a user starts their
backend under their account. Their provider CLIs and credentials must be set up under
that account. For a CLI installed in the user's home directory, add it to their login
shell's PATH or configure its full executable path in T3 Code.

The systemd service uses `/etc/t3code/gateway.json` and `/var/lib/t3code/pairing`.
`t3 gateway install` and `t3 gateway uninstall` refuse config or pairing directory path overrides.

If the printed pairing links use the wrong network address, set `publicUrl` in
`/etc/t3code/gateway.json` to the HTTP origin your devices can reach, including the port
if needed.

## Pair a browser or phone

As the enrolled Linux user, run:

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

To update the server, extract a newer archive in a private, root-owned directory and run
the extracted executable with `sudo` as above. The gateway and running backends restart,
stopping any running agent turns. The installer reports the restarted backends' states.
To check them later, run `t3 gateway list`.

Skip the in-app server update and `t3 service install`, which can start a separate server.

To unenroll an account, run `sudo t3 gateway remove alice`. This stops its backend and
leaves the account's T3 Code data in place.

To remove the shared service, run `sudo t3 gateway uninstall`. It removes the system
services and installed runtime and keeps `/etc/t3code`, `/var/lib/t3code`, the `t3code`
service account, and everyone's `~/.t3`. To start the backends again after reinstalling,
run `sudo t3 gateway add` for each account you want to bring back.
