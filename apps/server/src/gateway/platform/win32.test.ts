import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Console from "effect/Console";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as PlatformError from "effect/PlatformError";
import * as Result from "effect/Result";
import { ExitCode } from "effect/process/ChildProcessSpawner";
import * as TestClock from "effect/testing/TestClock";

import * as ProcessRunner from "../../processRunner.ts";
import { emptyGatewayConfig } from "../GatewayConfig.ts";
import {
  GatewayPlatformError,
  type GatewayActivation,
  type GatewayUserRecord,
} from "./GatewayPlatform.ts";
import {
  aclProblem,
  connectionPid,
  isElevatedAdministrator,
  makeWin32GatewayPlatform,
  MANAGED_MARKER,
  parseNetstat,
  parseTasklistAccount,
  parseWhoamiUser,
  psLiteral,
  renderTaskXml,
  taskXmlVersion,
  type AclEntry,
  type Win32GatewayPaths,
} from "./win32.ts";
import { makeTestGatewayRoot } from "./testing.ts";

const output = (stdout = "", code = 0, stderr = "") => ({
  stdout,
  stderr,
  code: ExitCode(code),
  timedOut: false,
  stdoutTruncated: false,
  stderrTruncated: false,
  stdoutInvalidUtf8: false,
  stderrInvalidUtf8: false,
});

const alice = "S-1-5-21-1111-2222-3333-1001";
const bob = "S-1-5-21-1111-2222-3333-1002";
const port = emptyGatewayConfig.listen.port;
const adminOnly = (path: string, owner = "S-1-5-32-544"): AclEntry => ({
  path,
  owner,
  rules: [
    { sid: "S-1-5-18", rights: 0x1f01ff, allow: true, inheritOnly: false },
    { sid: "S-1-5-32-544", rights: 0x1f01ff, allow: true, inheritOnly: false },
    { sid: "S-1-5-32-545", rights: 0x1200a9, allow: true, inheritOnly: false },
  ],
});
const withRule = (acl: AclEntry, sid: string, rights: number): AclEntry => ({
  ...acl,
  rules: [...acl.rules, { sid, rights, allow: true, inheritOnly: false }],
});

const unquote = (literal: string) => literal.slice(1, -1).replaceAll("''", "'");
const literal = "('(?:[^']|'')*')";
// Windows PowerShell 5.1's built-in aliases of up to two letters. An alias outranks a function of
// the same name, so a helper named `R` runs Invoke-History instead.
const shortPowerShellAliases = new Set(
  "% ? ac cd cp fc fl ft fw gc gi gl gm gp gu gv h ii lp ls md mi mp mv ni nv oh ps r rd ri rm rp rv sc si sl sp sv".split(
    " ",
  ),
);

const fixture = Effect.fn("win32GatewayTest.fixture")(function* () {
  const fs = yield* FileSystem.FileSystem;
  const path = yield* Path.Path;
  const root = yield* makeTestGatewayRoot("t3-gateway-win32-");
  const at = (...parts: ReadonlyArray<string>) => path.join(root, ...parts);
  const paths: Win32GatewayPaths = {
    systemRoot: "C:\\Windows",
    programFiles: at("pf"),
    programData: at("pd"),
    installRoot: at("pf", "T3Code"),
    launcher: at("pf", "T3Code", "bin", "t3.exe"),
    configPath: at("pd", "T3Code", "gateway.json"),
    pairingDir: at("pd", "T3Code", "pairing"),
    logDir: at("pd", "T3Code", "logs"),
    runningExecutable: at("pf", "T3Code", "0.1.9", "t3.exe"),
    tempDir: at("temp"),
  };
  const state = {
    // The password the next prompt returns; undefined fails the prompt.
    password: undefined as string | undefined,
    prompts: [] as Array<string>,
    stdins: [] as Array<string>,
    tasks: new Map<
      string,
      { readonly description: string | null; readonly xml: string; running: boolean }
    >(),
    registered: [] as Array<
      readonly [name: string, xml: string, logonType: string, user: string | undefined]
    >,
    sddl: new Map<string, string>(),
    listeners: new Map<number, number>(),
    netstatExtra: [] as Array<string>,
    owners: new Map<number, string>(),
    accountNames: new Map<string, string>([
      ["S-1-5-18", "NT AUTHORITY\\SYSTEM"],
      [alice, "DESKTOP-1\\alice"],
      [bob, "DESKTOP-1\\bob"],
    ]),
    gatewayRuns: 0,
    // The owner of the gateway's listener after each start; undefined leaves the port closed.
    gatewayOwner: (_run: number): string | undefined => "S-1-5-18",
    failScripts: [] as Array<string>,
    failStderr: "Access is denied.",
    acls: new Map<string, AclEntry>(),
    accounts: new Map<string, { readonly sid: string | null; readonly profile: string | null }>(),
    whoamiUser: `"desktop-1\\admin","S-1-5-21-1111-2222-3333-1000"\r\n`,
    whoamiGroups: [
      `"Everyone","Well-known group","S-1-1-0","Mandatory group, Enabled by default, Enabled group"`,
      `"BUILTIN\\Administrators","Alias","S-1-5-32-544","Mandatory group, Enabled by default, Enabled group, Group owner"`,
      `"Mandatory Label\\High Mandatory Level","Label","S-1-16-12288",""`,
    ].join("\r\n"),
    failNetstat: false,
    publicNetworks: [] as Array<string>,
  };
  const platform = makeWin32GatewayPlatform(paths, (prompt) => {
    state.prompts.push(prompt);
    return state.password === undefined
      ? Effect.fail(new GatewayPlatformError({ message: "No password was given." }))
      : Effect.succeed(state.password);
  });
  const calls: Array<string> = [];
  const powershellRuns: Array<string> = [];
  const gatewayStarted = yield* Deferred.make<void>();

  const netstat = () =>
    [
      "",
      "Active Connections",
      "",
      "  Proto  Local Address          Foreign Address        State           PID",
      ...[...state.listeners].map(
        ([listenPort, pid]) =>
          `  TCP    0.0.0.0:${listenPort}           0.0.0.0:0              LISTENING       ${pid}`,
      ),
      ...state.netstatExtra,
      "  UDP    0.0.0.0:5353           *:*                                    2044",
      "",
    ].join("\r\n");

  const taskScript = (script: string) => {
    const match = (pattern: string) => new RegExp(`;${pattern}$`, "s").exec(script);
    const register = match(
      `T3Register ${literal} ${literal} (\\d+) (?:\\$null|${literal}) ${literal}`,
    );
    if (register) {
      const name = unquote(register[1]!);
      const xml = unquote(register[2]!);
      state.registered.push([
        name,
        xml,
        register[3]!,
        register[4] === undefined ? undefined : unquote(register[4]),
      ]);
      state.sddl.set(name, unquote(register[5]!));
      state.tasks.set(name, { description: MANAGED_MARKER, xml, running: false });
      return output();
    }
    const stop = match(`T3Stop ${literal}`);
    if (stop) {
      const name = unquote(stop[1]!);
      const task = state.tasks.get(name);
      if (task) task.running = false;
      if (name === "Gateway") state.listeners.delete(port);
      return output();
    }
    const start = match(`\\(T3Task ${literal}\\)\\.Run\\(\\$null\\)\\|Out-Null`);
    if (start) {
      const name = unquote(start[1]!);
      const task = state.tasks.get(name);
      if (task) task.running = true;
      if (name === "Gateway") {
        const owner = state.gatewayOwner(++state.gatewayRuns);
        const pid = 900 + state.gatewayRuns;
        if (owner !== undefined) {
          state.listeners.set(port, pid);
          state.owners.set(pid, owner);
        }
      }
      return output();
    }
    const version = match(`T3Version ${literal}`);
    if (version) {
      const task = state.tasks.get(unquote(version[1]!));
      if (!task) return output("absent\r\n");
      if (task.description !== MANAGED_MARKER) return output("unmanaged\r\n");
      return output(`managed ${taskXmlVersion(task.xml) ?? ""}\r\n`);
    }
    const unregister = match(`T3Unregister ${literal}(\\|Out-Null)?`);
    if (unregister) {
      const name = unquote(unregister[1]!);
      const task = state.tasks.get(name);
      if (!task) return output("absent\r\n");
      if (task.description !== MANAGED_MARKER) return output("unmanaged\r\n");
      state.tasks.delete(name);
      return output("removed\r\n");
    }
    const query = new RegExp(`\\$t=T3Task ${literal};if`).exec(script);
    if (query) {
      const task = state.tasks.get(unquote(query[1]!));
      return output(
        task === undefined ? "unavailable\r\n" : task.running ? "running\r\n" : "stopped\r\n",
      );
    }
    if (script.includes("$skipped=@()")) {
      const skipped = [...state.tasks].filter(([, task]) => task.description !== MANAGED_MARKER);
      for (const [name, task] of state.tasks) {
        if (task.description === MANAGED_MARKER) state.tasks.delete(name);
      }
      return output(JSON.stringify(skipped.map(([name]) => name)));
    }
    if (script.includes("GetTasks(1))){[pscustomobject]")) {
      return output(
        JSON.stringify(
          [...state.tasks].map(([name, task]) => ({
            name,
            description: task.description,
            state: task.running ? 4 : 3,
            xml: task.xml,
          })),
        ),
      );
    }
    return undefined;
  };

  const powershell = (script: string) => {
    if (state.failScripts.some((fragment) => script.includes(fragment))) {
      return output("", 1, state.failStderr);
    }
    if (script.includes("Schedule.Service")) return taskScript(script);
    if (script.includes("GetOwnerSid")) {
      const pids = Array.from(script.matchAll(/ProcessId=(\d+)/g), (match) => Number(match[1]));
      const owners = Object.fromEntries(
        pids.flatMap((pid) => {
          const sid = state.owners.get(pid);
          const name = sid === undefined ? undefined : (state.accountNames.get(sid) ?? null);
          return sid === undefined ? [] : [[String(pid), { sid, name }]];
        }),
      );
      return Deferred.succeed(gatewayStarted, undefined).pipe(
        Effect.when(Effect.succeed(state.gatewayRuns > 0)),
        Effect.as(output(JSON.stringify(owners))),
      );
    }
    if (script.includes("NTAccount")) {
      if (script.includes("$s.Translate")) {
        const sid = unquote(new RegExp(`SecurityIdentifier\\(${literal}`).exec(script)?.[1] ?? "");
        const name = state.accountNames.get(sid)?.split("\\").at(-1) ?? "";
        return output(JSON.stringify(name));
      }
      const name = unquote(new RegExp(`\\$n=${literal}`).exec(script)![1]!);
      return output(JSON.stringify(state.accounts.get(name) ?? { sid: null, profile: null }));
    }
    if (script.includes("function W(")) {
      const directory = unquote(new RegExp(`Get-Item -LiteralPath ${literal}`).exec(script)![1]!);
      return Effect.gen(function* () {
        const names = yield* fs.readDirectory(directory, { recursive: true });
        const entries = [directory, ...names.map((name) => path.join(directory, name))];
        return output(
          JSON.stringify(entries.map((file) => state.acls.get(file) ?? adminOnly(file))),
        );
      });
    }
    if (script.includes("New-NetFirewallRule")) return output(JSON.stringify(state.publicNetworks));
    if (script.includes("J @(A (Get-Item")) {
      const file = unquote(new RegExp(`Get-Item -LiteralPath ${literal}`).exec(script)![1]!);
      return output(JSON.stringify([state.acls.get(file) ?? adminOnly(file)]));
    }
    return output();
  };

  const run: ProcessRunner.ProcessRunner["Service"]["run"] = ({ command, args, env, stdin }) =>
    Effect.gen(function* () {
      assert.equal(env?.SystemRoot, "C:\\Windows");
      if (command.endsWith("\\powershell.exe")) {
        assert.deepEqual(args.slice(0, 5), [
          "-NoProfile",
          "-NonInteractive",
          "-ExecutionPolicy",
          "Bypass",
          "-EncodedCommand",
        ]);
        const script = Buffer.from(args[5]!, "base64").toString("utf16le");
        powershellRuns.push(script);
        if (stdin !== undefined) state.stdins.push(stdin);
        const result = powershell(script) ?? output("", 1, "unexpected script");
        return Effect.isEffect(result) ? yield* result : result;
      }
      const name = command.slice(command.lastIndexOf("\\") + 1);
      calls.push([name, ...args].join(" "));
      switch (name) {
        case "netstat.exe":
          return state.failNetstat ? output("", 1) : output(netstat());
        case "tasklist.exe": {
          const pid = Number(/^PID eq (\d+)$/.exec(args[2] ?? "")?.[1]);
          const sid = state.owners.get(pid);
          return output(
            sid === undefined
              ? "INFO: No tasks are running which match the specified criteria.\r\n"
              : `"t3.exe","${pid}","Services","0","81,220 K","Unknown","${state.accountNames.get(sid) ?? "N/A"}","0:00:01","N/A"\r\n`,
          );
        }
        case "whoami.exe":
          return output(args[0] === "/user" ? state.whoamiUser : state.whoamiGroups);
        default:
          return output();
      }
    }).pipe(Effect.orDie);

  const provide = <A, E>(
    effect: Effect.Effect<A, E, FileSystem.FileSystem | Path.Path | ProcessRunner.ProcessRunner>,
  ) =>
    effect.pipe(
      Effect.provideService(ProcessRunner.ProcessRunner, { run }),
      // A running backend's cmd.exe holds its log open, so Windows refuses to open it for writing.
      Effect.updateService(FileSystem.FileSystem, (fs) => ({
        ...fs,
        writeFileString: (file, data, options) => {
          const user = /backend-([^\\/]+)\.log$/.exec(file)?.[1];
          return state.tasks.get(`Backend-${user}`)?.running
            ? Effect.fail(
                PlatformError.systemError({
                  _tag: "Busy",
                  module: "FileSystem",
                  method: "writeFile",
                  pathOrDescriptor: file,
                }),
              )
            : fs.writeFileString(file, data, options);
        },
      })),
    );
  const activation = (
    users: ReadonlyArray<GatewayUserRecord> = [],
    restorePreviousRuntime?: GatewayActivation["restorePreviousRuntime"],
  ): GatewayActivation => ({
    executable: at("pf", "T3Code", "current", "t3.exe"),
    config: emptyGatewayConfig,
    gatewayAccount: "S-1-5-18",
    users,
    restorePreviousRuntime,
  });
  const scriptsWith = (fragment: string) =>
    powershellRuns.filter((script) => script.includes(fragment));
  return {
    at,
    paths,
    platform,
    state,
    calls,
    powershellRuns,
    scriptsWith,
    gatewayStarted,
    provide,
    activate: (
      users?: ReadonlyArray<GatewayUserRecord>,
      restore?: GatewayActivation["restorePreviousRuntime"],
    ) => provide(platform.services.activate(activation(users, restore))),
  };
});

const capture = (field: "log" | "warn", reports: Array<string>) =>
  Effect.updateService(Console.Console, (console) => ({
    ...console,
    [field]: (...args: ReadonlyArray<unknown>) => {
      reports.push(args.join(" "));
    },
  }));

describe("win32 parsers", () => {
  it("parses netstat TCP rows whatever the language of the state column", () => {
    const rows = parseNetstat(
      [
        "Aktive Verbindungen",
        "  Proto  Lokale Adresse         Remoteadresse          Status           PID",
        "  TCP    0.0.0.0:3773           0.0.0.0:0              ABHÖREN          4120",
        "  TCP    127.0.0.1:3801         127.0.0.1:50211        HERGESTELLT      5000",
        "  TCP    127.0.0.1:50211        127.0.0.1:3801         HERGESTELLT      4120",
        "  TCP    [::]:3802              [::]:0                 EN ÉCOUTE        6000",
        "  TCP    [::ffff:127.0.0.1]:3802  [::ffff:127.0.0.1]:50300  ESTABLISHED  6000",
        "  TCP    [fe80::1%4]:139        [::]:0                 LISTENING        4",
        "  TCP    127.0.0.1:3801         127.0.0.1:49999        TIME_WAIT        0",
        "  UDP    0.0.0.0:5353           *:*                                    2044",
        "  TCP    bad row",
      ].join("\r\n"),
    );
    assert.deepEqual(rows, [
      {
        local: { address: "0.0.0.0", port: 3773 },
        remote: { address: "0.0.0.0", port: 0 },
        pid: 4120,
      },
      {
        local: { address: "127.0.0.1", port: 3801 },
        remote: { address: "127.0.0.1", port: 50211 },
        pid: 5000,
      },
      {
        local: { address: "127.0.0.1", port: 50211 },
        remote: { address: "127.0.0.1", port: 3801 },
        pid: 4120,
      },
      { local: { address: "::", port: 3802 }, remote: { address: "::", port: 0 }, pid: 6000 },
      {
        local: { address: "::ffff:127.0.0.1", port: 3802 },
        remote: { address: "::ffff:127.0.0.1", port: 50300 },
        pid: 6000,
      },
      { local: { address: "fe80::1", port: 139 }, remote: { address: "::", port: 0 }, pid: 4 },
      {
        local: { address: "127.0.0.1", port: 3801 },
        remote: { address: "127.0.0.1", port: 49999 },
        pid: 0,
      },
    ]);
  });

  it("finds the accepting process, else the port's only listener, failing closed", () => {
    const rows = (lines: ReadonlyArray<string>) => parseNetstat(lines.join("\n"));
    const listener = (listenPort: number, pid: number, address = "127.0.0.1") =>
      `TCP ${address}:${listenPort} 0.0.0.0:0 LISTENING ${pid}`;
    const cases: ReadonlyArray<readonly [string, ReadonlyArray<string>, number | undefined]> = [
      [
        "accepted row, ignoring the gateway's own end and old TIME_WAIT rows",
        [
          listener(3801, 7),
          "TCP 127.0.0.1:50211 127.0.0.1:3801 ESTABLISHED 4120",
          "TCP 127.0.0.1:3801 127.0.0.1:50211 ESTABLISHED 5000",
          "TCP 127.0.0.1:3801 127.0.0.1:50211 TIME_WAIT 0",
        ],
        5000,
      ],
      [
        "dual-stack accepted row",
        ["TCP [::ffff:127.0.0.1]:3801 [::ffff:127.0.0.1]:50211 X 61"],
        61,
      ],
      ["not yet accepted: the only listener", [listener(3801, 7), listener(3802, 8)], 7],
      ["one process on two addresses", [listener(3801, 7), "TCP [::]:3801 [::]:0 LISTENING 7"], 7],
      ["two listeners", [listener(3801, 7), listener(3801, 9, "0.0.0.0")], undefined],
      [
        "two accepting processes",
        [
          "TCP 127.0.0.1:3801 127.0.0.1:50211 ESTABLISHED 5000",
          "TCP [::ffff:127.0.0.1]:3801 [::ffff:127.0.0.1]:50211 ESTABLISHED 5001",
        ],
        undefined,
      ],
      ["nothing on the port", [listener(3802, 8)], undefined],
    ];
    for (const [name, lines, pid] of cases) {
      assert.equal(connectionPid(rows(lines), 3801, 50211), pid, name);
    }
  });

  it("reads accounts from whoami and tasklist, and elevation from whoami", () => {
    const task = (pid: number, user: string) =>
      `"t3.exe","${pid}","Services","0","81,220 K","Unknown","${user}","0:00:01","N/A"`;
    const tasklist = [
      task(5000, "DESKTOP-1\\alice"),
      task(5001, "N/A"),
      task(5002, "DESKTOP-1\\b\u00f8b"),
    ];
    assert.equal(parseTasklistAccount(tasklist.join("\r\n"), 5000), "DESKTOP-1\\alice");
    for (const pid of [5001, 5002, 5003]) {
      assert.isUndefined(parseTasklistAccount(tasklist.join("\r\n"), pid));
    }
    assert.equal(parseWhoamiUser(`"desktop-1\\aila","${alice}"\r\n`), alice);
    assert.equal(parseWhoamiUser(`"nt authority\\system","S-1-5-18"\r\n`), "S-1-5-18");
    assert.equal(parseWhoamiUser(`"desktop-1\\o""brien, jr","${bob}"\r\n`), bob);
    assert.equal(parseWhoamiUser("ERROR: access denied"), undefined);

    const groups = (...rows: ReadonlyArray<string>) => rows.join("\r\n");
    const admins = (attributes: string) =>
      `"BUILTIN\\Administrators","Alias","S-1-5-32-544","${attributes}"`;
    const label = (level: string, sid: string) => `"Mandatory Label\\${level}","Label","${sid}",""`;
    const cases: ReadonlyArray<readonly [string, string, boolean]> = [
      [
        "elevated",
        groups(admins("Enabled group"), label("High Mandatory Level", "S-1-16-12288")),
        true,
      ],
      [
        "filtered",
        groups(admins("Group used for deny only"), label("Medium", "S-1-16-8192")),
        false,
      ],
      ["LocalSystem", groups(admins("Enabled group"), label("System", "S-1-16-16384")), true],
      ["standard user", groups(label("Medium Mandatory Level", "S-1-16-8192")), false],
    ];
    for (const [name, stdout, expected] of cases) {
      assert.equal(isElevatedAdministrator(stdout), expected, name);
    }
  });

  it("allows writes only by trusted accounts", () => {
    const programData = withRule(
      withRule(adminOnly("C:\\ProgramData", "S-1-5-18"), "S-1-3-0", 0x10000000),
      "S-1-5-32-545",
      0x116,
    );
    const cases: ReadonlyArray<
      readonly [string, AclEntry, Parameters<typeof aclProblem>[1], string | undefined]
    > = [
      ["admin-only", adminOnly("C:\\x"), { allowAddEntries: false }, undefined],
      [
        "user-owned",
        adminOnly("C:\\x", alice),
        { allowAddEntries: false },
        `it is owned by ${alice}`,
      ],
      [
        "trusted invoker",
        adminOnly("C:\\x", alice),
        { trusted: alice, allowAddEntries: false },
        undefined,
      ],
      [
        "users modify",
        withRule(adminOnly("C:\\x"), "S-1-5-32-545", 0x1301bf),
        { allowAddEntries: true },
        "S-1-5-32-545 can modify it",
      ],
      [
        "generic all",
        withRule(adminOnly("C:\\x"), bob, 0x10000000),
        { allowAddEntries: false },
        `${bob} can modify it`,
      ],
      [
        "generic read",
        withRule(adminOnly("C:\\x"), bob, -0x80000000),
        { allowAddEntries: false },
        undefined,
      ],
      ["ProgramData as an ancestor", programData, { allowAddEntries: true }, undefined],
      [
        "ProgramData-like folder we own",
        programData,
        { allowAddEntries: false },
        "S-1-5-32-545 can modify it",
      ],
      [
        "inherit-only and deny entries",
        {
          ...adminOnly("C:\\x"),
          rules: [
            { sid: bob, rights: 0x1f01ff, allow: true, inheritOnly: true },
            { sid: bob, rights: 0x1f01ff, allow: false, inheritOnly: false },
          ],
        },
        { allowAddEntries: false },
        undefined,
      ],
    ];
    for (const [name, acl, options, problem] of cases) {
      assert.equal(aclProblem(acl, options), problem, name);
    }
  });

  it("quotes PowerShell literals, including typographic quotes", () => {
    assert.equal(psLiteral("C:\\Users\\O'Brien"), "'C:\\Users\\O''Brien'");
    assert.equal(psLiteral("a\u2019b$(x)"), "'a\u2019\u2019b$(x)'");
  });

  it("renders escaped Task Scheduler XML with the managed marker", () => {
    const xml = renderTaskXml({
      userId: alice,
      logonType: "S4U",
      runLevel: "LeastPrivilege",
      command: "C:\\Windows\\System32\\cmd.exe",
      arguments: `/d /c ""C:\\T3\\t3.exe" gateway run-backend >> "C:\\logs\\b.log" 2>&1"`,
      workingDirectory: "C:\\Users\\O'Brien & Co",
    });
    assert.isFalse(xml.startsWith("<?xml"));
    for (const fragment of [
      `<Description>${MANAGED_MARKER}</Description>`,
      "<BootTrigger>",
      `<UserId>${alice}</UserId>`,
      "<LogonType>S4U</LogonType>",
      "<RunLevel>LeastPrivilege</RunLevel>",
      "<ExecutionTimeLimit>PT0S</ExecutionTimeLimit>",
      "<MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>",
      "<DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>",
      "<StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>",
      "<TimeTrigger>\r\n      <StartBoundary>2000-01-01T00:00:00</StartBoundary>\r\n      <Repetition>\r\n        <Interval>PT1M</Interval>",
      "<Arguments>/d /c &quot;&quot;C:\\T3\\t3.exe&quot; gateway run-backend &gt;&gt; &quot;C:\\logs\\b.log&quot; 2&gt;&amp;1&quot;</Arguments>",
      "<WorkingDirectory>C:\\Users\\O&apos;Brien &amp; Co</WorkingDirectory>",
    ]) {
      assert.include(xml, fragment);
    }
    const detached = renderTaskXml({
      userId: "S-1-5-18",
      logonType: "ServiceAccount",
      runLevel: "HighestAvailable",
      command: "C:\\T3\\t3.exe",
      arguments: "gateway install",
      workingDirectory: "C:\\T3",
      oneShot: true,
      executionTimeLimit: "PT30M",
    });
    assert.include(detached, "<Triggers />");
    assert.include(detached, "<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>");
    assert.notInclude(detached, "<BootTrigger>");
  });
});

it.layer(NodeServices.layer)("win32 gateway platform", (it) => {
  it.effect("reads the current account and elevation through whoami", () =>
    Effect.gen(function* () {
      const { platform, provide, state } = yield* fixture();
      assert.equal(yield* provide(platform.currentAccount), "S-1-5-21-1111-2222-3333-1000");
      assert.isTrue(yield* provide(platform.isAdmin));
      state.whoamiGroups = `"Mandatory Label\\Medium Mandatory Level","Label","S-1-16-8192",""`;
      assert.isFalse(yield* provide(platform.isAdmin));
    }).pipe(Effect.scoped),
  );

  it.effect("looks users up by SID and profile, refusing system accounts", () =>
    Effect.gen(function* () {
      const { at, platform, provide, state } = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(at("Users", "alice"), { recursive: true });
      state.accounts.set("alice", { sid: alice, profile: at("Users", "alice") });
      state.accounts.set("system", {
        sid: "S-1-5-18",
        profile: "C:\\Windows\\system32\\config\\systemprofile",
      });
      state.accounts.set("administrator", {
        sid: "S-1-5-21-1111-2222-3333-500",
        profile: at("Users"),
      });
      state.accounts.set("guest", { sid: "S-1-5-21-1111-2222-3333-501", profile: null });
      state.accounts.set("bob", { sid: bob, profile: null });
      state.accounts.set("carol", {
        sid: "S-1-5-21-1111-2222-3333-1003",
        profile: at("Users", "carol"),
      });

      assert.deepEqual(yield* provide(platform.lookupUser("alice")), {
        name: "alice",
        accountId: alice,
        home: at("Users", "alice"),
      });
      const failures: ReadonlyArray<readonly [string, string]> = [
        ["nobody", "Windows user nobody was not found."],
        [
          "system",
          "system (S-1-5-18) is not a regular Windows user account and cannot be enrolled.",
        ],
        ["administrator", "is not a regular Windows user account"],
        ["guest", "is not a regular Windows user account"],
        ["bob", "Windows user bob has no profile yet. Sign in to Windows once as bob, then retry."],
        ["carol", `The profile folder ${at("Users", "carol")} for carol does not exist.`],
      ];
      for (const [name, message] of failures) {
        const result = yield* provide(platform.lookupUser(name)).pipe(Effect.result);
        assert.isTrue(Result.isFailure(result) && result.failure.message.includes(message), name);
      }
    }).pipe(Effect.scoped),
  );

  it.effect("resolves a SID to its local account name", () =>
    Effect.gen(function* () {
      const { platform, provide } = yield* fixture();
      assert.equal(yield* provide(platform.accountName(alice)), "alice");
      assert.equal(yield* provide(platform.accountName(alice)), "alice");
    }),
  );

  it.effect("checks admin ownership through SIDs, letting users only add to ancestors", () =>
    Effect.gen(function* () {
      const { at, paths, platform, provide, state } = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(paths.installRoot, { recursive: true });
      yield* fs.writeFileString(at("file"), "");
      const check = (file: string, kind: "File" | "Directory") =>
        provide(platform.checkAdminOwned(file, kind)).pipe(
          Effect.result,
          Effect.map((result) =>
            Result.isSuccess(result) ? result.success : result.failure.message,
          ),
        );

      assert.isFalse(yield* check(at("missing"), "Directory"));
      assert.isTrue(yield* check(paths.installRoot, "Directory"));
      assert.equal(yield* check(at("file"), "Directory"), `Expected a directory at ${at("file")}.`);

      state.acls.set(paths.installRoot, adminOnly(paths.installRoot, alice));
      assert.equal(
        yield* check(paths.installRoot, "Directory"),
        `Expected ${paths.installRoot} to be modifiable only by administrators, but it is owned by ${alice}.`,
      );
      const programFiles = withRule(adminOnly(paths.programFiles), "S-1-5-11", 0x116);
      state.acls.set(paths.installRoot, withRule(adminOnly(paths.installRoot), "S-1-5-11", 0x116));
      state.acls.set(paths.programFiles, programFiles);
      assert.equal(
        yield* check(paths.installRoot, "Directory"),
        `Expected ${paths.installRoot} to be modifiable only by administrators, but S-1-5-11 can modify it.`,
      );
      // An ancestor of the install root may let users add entries, as C:\ and C:\ProgramData do.
      assert.isTrue(yield* check(paths.programFiles, "Directory"));
      state.acls.set(at("file"), withRule(adminOnly(at("file")), "S-1-5-11", 0x116));
      assert.include(yield* check(at("file"), "File"), "S-1-5-11 can modify it");
    }).pipe(Effect.scoped),
  );

  it.effect("reads a runtime archive's ACLs in one pass and trusts the installing admin", () =>
    Effect.gen(function* () {
      const { at, platform, provide, scriptsWith, state } = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(at("archive", "client"), { recursive: true });
      yield* fs.writeFileString(at("archive", "client", "index.html"), "");
      yield* fs.writeFileString(at("archive", "t3.exe"), "");
      const admin = "S-1-5-21-1111-2222-3333-1000";
      state.acls.set(at("archive"), adminOnly(at("archive"), admin));

      yield* provide(platform.checkRuntimeSource(at("archive"), "Directory"));
      yield* provide(platform.checkRuntimeSource(at("archive", "t3.exe"), "File"));
      yield* provide(platform.checkRuntimeSource(at("archive", "client"), "Directory"));
      yield* provide(platform.checkRuntimeSource(at("archive", "client", "index.html"), "File"));
      assert.lengthOf(scriptsWith("function W("), 1);
      assert.lengthOf(scriptsWith("J @(A (Get-Item"), 0);

      // Ancestors are read one at a time and may let users add entries.
      state.acls.set(at(), withRule(adminOnly(at(), "S-1-5-18"), "S-1-5-11", 0x116));
      yield* provide(platform.checkRuntimeSource(at(), "Directory", { ancestor: true }));
      assert.lengthOf(scriptsWith("J @(A (Get-Item"), 1);

      const other = yield* fixture();
      yield* fs.makeDirectory(other.at("archive"));
      yield* fs.writeFileString(other.at("archive", "t3.exe"), "");
      other.state.acls.set(
        other.at("archive", "t3.exe"),
        adminOnly(other.at("archive", "t3.exe"), bob),
      );
      yield* other.provide(other.platform.checkRuntimeSource(other.at("archive"), "Directory"));
      const result = yield* other
        .provide(other.platform.checkRuntimeSource(other.at("archive", "t3.exe"), "File"))
        .pipe(Effect.result);
      assert.isTrue(Result.isFailure(result) && result.failure.message.includes(`owned by ${bob}`));
    }).pipe(Effect.scoped),
  );

  it.effect("secures directories with SID grants, resetting only existing ones", () =>
    Effect.gen(function* () {
      const { at, calls, platform, provide } = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const user = { name: "alice", accountId: alice, home: at("home") };
      yield* provide(platform.secureDirectory(at("pairing", "alice"), user));
      assert.isTrue(yield* fs.exists(at("pairing", "alice")));
      yield* provide(platform.secureDirectory(at("pairing"), "admin"));
      assert.deepEqual(calls, [
        `icacls.exe ${at("pairing", "alice")} /setowner *S-1-5-32-544 /L /Q`,
        `icacls.exe ${at("pairing", "alice")} /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX *${alice}:(OI)(CI)M /L /Q`,
        `icacls.exe ${at("pairing")} /setowner *S-1-5-32-544 /L /Q`,
        `icacls.exe ${at("pairing")} /reset /L /Q`,
        `icacls.exe ${at("pairing")} /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F *S-1-5-32-545:(OI)(CI)RX /L /Q`,
      ]);
      const numeric = yield* provide(
        platform.secureDirectory(at("x"), { name: "alice", accountId: 1001, home: at("home") }),
      ).pipe(Effect.result);
      assert.isTrue(
        Result.isFailure(numeric) && numeric.failure.message.includes("not a Windows SID"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect(
    "removes a pairing folder after taking it back, unlinking links without following them",
    () =>
      Effect.gen(function* () {
        const { at, calls, platform, provide } = yield* fixture();
        const fs = yield* FileSystem.FileSystem;
        yield* fs.makeDirectory(at("outside"));
        yield* fs.writeFileString(at("outside", "secret"), "keep");
        yield* fs.makeDirectory(at("pairing", "alice", "nested"), { recursive: true });
        yield* fs.writeFileString(at("pairing", "alice", "marker.json"), "{}");
        yield* fs.symlink(at("outside"), at("pairing", "alice", "nested", "junction"));
        yield* fs.symlink(at("outside"), at("pairing", "bob"));

        yield* provide(platform.removeTree(at("pairing", "alice")));
        yield* provide(platform.removeTree(at("pairing", "bob")));
        yield* provide(platform.removeTree(at("pairing", "missing")));
        assert.isFalse(yield* fs.exists(at("pairing", "alice")));
        assert.isFalse(yield* fs.exists(at("pairing", "bob")));
        assert.equal(yield* fs.readFileString(at("outside", "secret")), "keep");
        assert.deepEqual(calls, [
          `icacls.exe ${at("pairing", "alice")} /setowner *S-1-5-32-544 /T /L /Q`,
          `icacls.exe ${at("pairing", "alice")} /reset /T /L /Q`,
        ]);
      }).pipe(Effect.scoped),
  );

  it.effect("replaces links, keeping the previous target intact", () =>
    Effect.gen(function* () {
      const { at, platform, provide } = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(at("T3Code", "1.0.0"), { recursive: true });
      yield* fs.makeDirectory(at("T3Code", "1.1.0"));
      yield* fs.makeDirectory(at("T3Code", "bin"));
      yield* fs.writeFileString(at("T3Code", "1.1.0", "t3.exe"), "new");

      yield* provide(platform.replaceLink(at("T3Code", "1.0.0"), at("T3Code", "current")));
      yield* provide(platform.replaceLink(at("T3Code", "1.1.0"), at("T3Code", "current")));
      yield* provide(
        platform.replaceLink(at("T3Code", "current", "t3.exe"), at("T3Code", "bin", "t3.exe")),
      );
      assert.equal(yield* fs.readLink(at("T3Code", "current")), at("T3Code", "1.1.0"));
      assert.equal(yield* fs.readFileString(at("T3Code", "bin", "t3.exe")), "new");
      assert.isTrue(yield* fs.exists(at("T3Code", "1.0.0")));
      assert.deepEqual((yield* fs.readDirectory(at("T3Code"))).sort(), [
        "1.0.0",
        "1.1.0",
        "bin",
        "current",
      ]);

      yield* fs.makeDirectory(at("T3Code", "occupied"));
      const result = yield* provide(
        platform.replaceLink(at("T3Code", "1.1.0"), at("T3Code", "occupied")),
      ).pipe(Effect.result);
      assert.isTrue(
        Result.isFailure(result) && result.failure.message.includes("it is not a link"),
      );
    }).pipe(Effect.scoped),
  );

  it.effect("lists listeners with their owners, unknown owners as the NULL SID", () =>
    Effect.gen(function* () {
      const { platform, provide, state } = yield* fixture();
      state.listeners.set(3773, 900).set(3801, 901).set(445, 4);
      state.owners.set(900, "S-1-5-18").set(901, alice);
      assert.deepEqual(yield* provide(platform.listeners), [
        { port: 3773, owner: "S-1-5-18" },
        { port: 3801, owner: alice },
        { port: 445, owner: "S-1-0-0" },
      ]);
    }).pipe(Effect.scoped),
  );

  it.effect("names a connection's owner, never trusting a PID another account may reuse", () =>
    Effect.gen(function* () {
      const { platform, provide, scriptsWith, state } = yield* fixture();
      const owner = yield* provide(platform.makeConnectionOwner);
      const lookup = (clientPort = 50211) => Effect.promise(() => owner(3801, clientPort));
      const ownerLookups = () => scriptsWith("GetOwnerSid").length;
      state.owners.set(5000, alice).set(5001, bob);
      state.netstatExtra = ["  TCP    127.0.0.1:3801   127.0.0.1:50211   ESTABLISHED   5000"];

      assert.equal(yield* lookup(), alice);
      assert.equal(yield* lookup(), alice);
      assert.equal(ownerLookups(), 1);

      // Not yet accepted: the port's only listener answers.
      state.listeners.set(3801, 5000);
      assert.equal(yield* lookup(50300), alice);
      assert.equal(ownerLookups(), 1);

      // alice's backend died and bob's process got its PID on the same port.
      state.owners.set(5000, bob);
      assert.equal(yield* lookup(50301), bob);
      assert.equal(ownerLookups(), 2);
      state.owners.set(5000, alice);
      assert.equal(yield* lookup(50302), alice);
      assert.equal(ownerLookups(), 2);

      yield* TestClock.adjust("11 minutes");
      assert.equal(yield* lookup(50500), alice);
      assert.equal(ownerLookups(), 3);

      // An administrator enrolled a different account under the cached name: only a fresh lookup sees it.
      state.accountNames.set(bob, "DESKTOP-1\\alice");
      state.owners.set(5000, bob);
      assert.equal(yield* lookup(50510), alice);
      assert.equal(yield* Effect.promise(() => owner(3801, 50511, { fresh: true })), bob);
      state.accountNames.set(bob, "DESKTOP-1\\bob");
      state.owners.set(5000, alice);
      const freshLookups = ownerLookups();

      // A name tasklist may have garbled is never matched against the cache.
      state.accountNames.set(bob, "DESKTOP-1\\b\u00f8b");
      state.owners.set(5000, bob);
      assert.equal(yield* lookup(50501), bob);
      assert.equal(yield* lookup(50502), bob);
      assert.equal(ownerLookups(), freshLookups + 2);

      state.netstatExtra = ["  TCP    0.0.0.0:3801   0.0.0.0:0   LISTENING   5001"];
      assert.isUndefined(yield* lookup(50600));
      state.failNetstat = true;
      assert.isUndefined(yield* lookup());
    }).pipe(Effect.scoped),
  );

  it.effect("refuses to install over unmanaged tasks", () =>
    Effect.gen(function* () {
      const { platform, provide, state } = yield* fixture();
      yield* provide(platform.services.preflight);
      state.tasks.set("Gateway", { description: "Someone else's", xml: "<Task/>", running: true });
      const result = yield* provide(platform.services.preflight).pipe(Effect.result);
      assert.isTrue(
        Result.isFailure(result) &&
          result.failure.message ===
            "Refusing to install: \\T3Code\\Gateway is not managed by t3 gateway. Remove it first.",
      );
    }).pipe(Effect.scoped),
  );

  it.effect("activates a first install: gateway task, firewall, PATH and logs", () =>
    Effect.gen(function* () {
      const { at, calls, paths, activate, powershellRuns, scriptsWith, state } = yield* fixture();
      const path = yield* Path.Path;
      const log = (name: string) => path.join(paths.logDir, name);
      const users = [{ name: "alice", accountId: alice, home: at("Users", "alice") }];
      const reports: Array<string> = [];
      const warnings: Array<string> = [];
      state.publicNetworks = ["Ethernet 2"];
      yield* activate(users).pipe(capture("log", reports), capture("warn", warnings));

      const executable = at("pf", "T3Code", "current", "t3.exe");
      // Only `t3 gateway add` can define a backend: it needs the user's password.
      assert.deepEqual(
        state.registered.map(([name, , logonType, user]) => [name, logonType, user]),
        [["Gateway", "5", undefined]],
      );
      assert.deepEqual(state.prompts, []);
      assert.deepEqual(warnings, [
        `Windows treats network Ethernet 2 as Public, so the firewall keeps port ${port} closed on it. On a trusted network, run: Set-NetConnectionProfile -InterfaceAlias 'Ethernet 2' -NetworkCategory Private`,
        "Backend-alice is missing or out of date. Run `t3 gateway add alice` to register it with alice's Windows password.",
      ]);
      assert.deepEqual(reports, ["Backend-alice: unavailable"]);
      const gatewayXml = state.registered[0]![1];
      assert.include(gatewayXml, "<UserId>S-1-5-18</UserId>");
      // Task Scheduler rejects <LogonType>ServiceAccount</LogonType>.
      assert.notInclude(gatewayXml, "<LogonType>");
      assert.include(
        gatewayXml,
        `<Arguments>/d /c &quot;&quot;${executable}&quot; gateway run &gt;&gt; &quot;${log("gateway.log")}&quot; 2&gt;&amp;1&quot;</Arguments>`,
      );
      assert.isTrue(state.tasks.get("Gateway")?.running);
      const helpers = powershellRuns.flatMap((script) =>
        Array.from(script.matchAll(/function ([^\s({]+)/g), (match) => match[1]!.toLowerCase()),
      );
      assert.include(helpers, "j");
      assert.deepEqual(
        helpers.filter((name) => shortPowerShellAliases.has(name)),
        [],
      );

      assert.lengthOf(scriptsWith(`New-NetFirewallRule -Name 'T3Code-Gateway'`), 1);
      assert.include(
        scriptsWith(`New-NetFirewallRule`)[0]!,
        `-LocalPort ${port} -Profile Domain,Private`,
      );
      const pathScript = scriptsWith("Session Manager\\Environment")[0]!;
      assert.include(pathScript, `$d=${psLiteral(at("pf", "T3Code", "bin"))}`);
      assert.include(pathScript, "if($has){return};$n=($p+$d) -join ';'");
      assert.include(pathScript, "RegistryValueKind]::ExpandString");

      assert.include(
        calls,
        `icacls.exe ${paths.logDir} /inheritance:r /grant:r *S-1-5-18:(OI)(CI)F *S-1-5-32-544:(OI)(CI)F /L /Q`,
      );
    }).pipe(Effect.scoped),
  );

  it.effect("activates an update by replacing the managed gateway task", () =>
    Effect.gen(function* () {
      const { activate, state } = yield* fixture();
      state.tasks.set("Gateway", {
        description: MANAGED_MARKER,
        xml: "<Task>old</Task>",
        running: true,
      });
      state.listeners.set(port, 800);
      state.owners.set(800, "S-1-5-18");
      yield* activate([], Effect.void);
      assert.deepEqual(
        state.registered.map(([name]) => name),
        ["Gateway"],
      );
      assert.notEqual(state.tasks.get("Gateway")?.xml, "<Task>old</Task>");
      assert.equal(state.gatewayRuns, 1);
    }).pipe(Effect.scoped),
  );

  it.effect("rolls the runtime and gateway task back when the gateway does not listen", () =>
    Effect.gen(function* () {
      const { activate, gatewayStarted, state } = yield* fixture();
      state.tasks.set("Gateway", {
        description: MANAGED_MARKER,
        xml: "<Task>old</Task>",
        running: true,
      });
      // The new runtime never listens as LocalSystem; the restored one does.
      state.gatewayOwner = (run) => (run === 1 ? alice : "S-1-5-18");
      let restored = 0;
      const fiber = yield* activate(
        [{ name: "alice", accountId: alice, home: "C:\\Users\\alice" }],
        Effect.sync(() => void restored++),
      ).pipe(Effect.forkChild);
      yield* Deferred.await(gatewayStarted);
      yield* TestClock.adjust("31 seconds");
      const result = yield* Fiber.join(fiber).pipe(Effect.result);

      assert.equal(restored, 1);
      assert.deepEqual(
        state.registered.map(([name, xml]) => [name, xml === "<Task>old</Task>"]),
        [
          ["Gateway", false],
          ["Gateway", true],
        ],
      );
      assert.isTrue(
        Result.isFailure(result) &&
          result.failure.message.startsWith(
            `The gateway did not listen on port ${port} within 30 seconds. Restored the previous runtime and gateway task. The gateway is listening. See Task Scheduler history`,
          ),
      );
      assert.isFalse(state.tasks.has("Backend-alice"));
    }).pipe(Effect.scoped),
  );

  it.effect("restarts backends on install without passwords, warning about stale definitions", () =>
    Effect.gen(function* () {
      const { activate, at, platform, provide, state } = yield* fixture();
      const users = [
        { name: "alice", accountId: alice, home: at("Users", "alice") },
        { name: "bob", accountId: bob, home: at("Users", "bob") },
      ];
      state.password = "pw";
      for (const user of users) {
        yield* provide(platform.services.enableUser(user, at("pf", "T3Code", "current", "t3.exe")));
      }
      state.password = undefined;
      state.registered.length = 0;
      state.tasks.get("Backend-alice")!.running = false;
      state.tasks.set("Backend-bob", {
        ...state.tasks.get("Backend-bob")!,
        xml: "<Task>older definition</Task>",
        running: false,
      });

      const reports: Array<string> = [];
      const warnings: Array<string> = [];
      yield* activate(users).pipe(capture("log", reports), capture("warn", warnings));
      assert.deepEqual(
        state.registered.map(([name]) => name),
        ["Gateway"],
      );
      assert.lengthOf(state.prompts, 2);
      assert.isTrue(state.tasks.get("Backend-alice")?.running);
      // A stale definition still runs the installed runtime; only `add` can redefine it.
      assert.isTrue(state.tasks.get("Backend-bob")?.running);
      assert.equal(state.tasks.get("Backend-bob")?.xml, "<Task>older definition</Task>");
      assert.deepEqual(warnings, [
        "Backend-bob is missing or out of date. Run `t3 gateway add bob` to register it with bob's Windows password.",
      ]);
      assert.deepEqual(reports, ["Backend-alice: running", "Backend-bob: running"]);

      state.failScripts = ["T3Stop 'Backend-alice'"];
      const result = yield* activate(users).pipe(Effect.result);
      assert.isTrue(
        Result.isFailure(result) && result.failure.message.includes("Access is denied."),
      );
      assert.isTrue(state.tasks.get("Gateway")?.running);
    }).pipe(Effect.scoped),
  );

  it.effect("enables, reports and disables one user's backend", () =>
    Effect.gen(function* () {
      const { at, calls, paths, platform, powershellRuns, provide, state } = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const user = { name: "alice", accountId: alice, home: at("Users", "alice") };
      const executable = at("pf", "T3Code", "current", "t3.exe");
      const log = path.join(paths.logDir, "backend-alice.log");
      assert.equal(yield* provide(platform.services.userState("alice")), "unavailable");

      // A log a previous account of the same name left behind holds none of its output afterwards.
      yield* fs.makeDirectory(paths.logDir, { recursive: true });
      yield* fs.writeFileString(log, "previous account's output");
      const refused = yield* provide(platform.services.enableUser(user, executable)).pipe(
        Effect.result,
      );
      assert.isFalse(
        (yield* fs.readFileString(log).pipe(Effect.orElseSucceed(() => ""))).includes("previous"),
      );
      assert.isTrue(Result.isFailure(refused));
      assert.isFalse(state.tasks.has("Backend-alice"));

      state.password = "s3cret'pw";
      yield* provide(platform.services.enableUser(user, executable));
      assert.equal(yield* provide(platform.services.userState("alice")), "running");
      assert.deepEqual(state.prompts, [
        "Windows password for alice (registers their backend task; it is not stored): ",
        "Windows password for alice (registers their backend task; it is not stored): ",
      ]);
      const [[name, backendXml, logonType, principal]] = state.registered as [
        readonly [string, string, string, string | undefined],
      ];
      assert.deepEqual([name, logonType, principal], ["Backend-alice", "2", alice]);
      // Administrators keep full control even of a task the SYSTEM helper registers.
      assert.equal(state.sddl.get("Backend-alice"), `D:(A;;FA;;;BA)(A;;FA;;;SY)(A;;FR;;;${alice})`);
      const grant = powershellRuns.findIndex((script) => script.includes("LsaAddAccountRights"));
      assert.include(powershellRuns[grant], `SecurityIdentifier('${alice}')`);
      assert.include(powershellRuns[grant], "Grant($b,'SeBatchLogonRight')");
      assert.isBelow(
        grant,
        powershellRuns.findIndex((script) => script.includes("T3Register 'Backend-alice'")),
      );
      // The password reaches PowerShell on stdin only, never in a script or an argument.
      assert.deepEqual(state.stdins, ["s3cret'pw\n"]);
      assert.isFalse(powershellRuns.some((script) => script.includes("s3cret")));
      assert.isFalse(calls.some((call) => call.includes("s3cret")));
      assert.include(backendXml, `<UserId>${alice}</UserId>`);
      assert.include(backendXml, "<LogonType>S4U</LogonType>");
      assert.include(backendXml, `<WorkingDirectory>${at("Users", "alice")}</WorkingDirectory>`);
      assert.include(backendXml, `gateway run-backend &gt;&gt; &quot;${log}`);
      assert.isTrue(yield* fs.exists(log));
      // Entries a previous account of the same name kept on its log are dropped before granting.
      assert.isBelow(
        calls.indexOf(`icacls.exe ${log} /reset /L /Q`),
        calls.findIndex((call) => call.startsWith(`icacls.exe ${log} /inheritance:r`)),
      );
      assert.isAtLeast(calls.indexOf(`icacls.exe ${log} /reset /L /Q`), 0);
      assert.include(
        calls,
        `icacls.exe ${log} /inheritance:r /grant:r *S-1-5-18:F *S-1-5-32-544:F *${alice}:(GR,GW) /L /Q`,
      );

      // A current definition only restarts.
      yield* provide(platform.services.enableUser(user, executable));
      assert.lengthOf(state.registered, 1);
      assert.lengthOf(state.prompts, 2);

      yield* provide(platform.services.disableUser("alice"));
      assert.isFalse(state.tasks.has("Backend-alice"));
      // A later account reusing the name must not inherit this one's log or its SID's access.
      assert.isFalse(yield* fs.exists(log));
      yield* provide(platform.services.disableUser("alice"));

      const bobUser = { name: "bob", accountId: bob, home: at("Users", "bob") };
      state.failScripts = ["T3Register 'Backend-bob'"];
      state.failStderr =
        '#< CLIXML <S S="Error">The user name or password is incorrect. (Exception from HRESULT: 0x8007052E)</S>';
      const wrong = yield* Effect.flip(
        provide(platform.services.enableUser(bobUser, executable, { password: "wrong" })),
      );
      assert.equal(wrong.message, "Windows did not accept the password for bob.");
      state.failScripts = [];
      yield* provide(
        platform.services.enableUser(bobUser, executable, { password: "passed-directly" }),
      );
      assert.equal(state.prompts.length, 2);
      assert.equal(state.stdins.at(-1), "passed-directly\n");

      state.tasks.set("Backend-bob", { description: null, xml: "<Task/>", running: true });
      const warnings: Array<string> = [];
      yield* provide(platform.services.disableUser("bob")).pipe(capture("warn", warnings));
      assert.deepEqual(warnings, [
        "Skipping \\T3Code\\Backend-bob: it is not managed by t3 gateway.",
      ]);
      assert.isTrue(state.tasks.has("Backend-bob"));

      state.failScripts = ["Schedule.Service"];
      assert.equal(yield* provide(platform.services.userState("alice")), "unavailable");
    }).pipe(Effect.scoped),
  );

  it.effect("registers and starts a one-shot detached SYSTEM task", () =>
    Effect.gen(function* () {
      const { platform, provide, state } = yield* fixture();
      yield* provide(
        platform.services.runDetached("update", ["C:\\T3 Code\\t3.exe", "gateway", "install"]),
      );
      const task = state.tasks.get("Update");
      assert.isDefined(task);
      assert.include(task!.xml, "<Triggers />");
      assert.include(task!.xml, "<ExecutionTimeLimit>PT30M</ExecutionTimeLimit>");
      assert.isTrue(task!.running);
      assert.isFalse(state.prompts.length > 0);
    }),
  );

  it.effect("uninstalls managed tasks, the firewall rule, the PATH entry and its own exe", () =>
    Effect.gen(function* () {
      const { at, paths, platform, provide, scriptsWith, state } = yield* fixture();
      const fs = yield* FileSystem.FileSystem;
      yield* fs.makeDirectory(at("pf", "T3Code", "0.1.9"), { recursive: true });
      yield* fs.makeDirectory(paths.tempDir);
      yield* fs.writeFileString(paths.runningExecutable, "exe");
      state.tasks
        .set("Gateway", { description: MANAGED_MARKER, xml: "<Task/>", running: true })
        .set("Backend-alice", { description: MANAGED_MARKER, xml: "<Task/>", running: true })
        .set("Other", { description: "Someone else's", xml: "<Task/>", running: false });
      const warnings: Array<string> = [];
      yield* provide(platform.services.uninstall).pipe(capture("warn", warnings));
      assert.deepEqual([...state.tasks.keys()], ["Other"]);
      assert.deepEqual(warnings, ["Skipping \\T3Code\\Other: it is not managed by t3 gateway."]);
      assert.lengthOf(scriptsWith("Remove-NetFirewallRule -Name 'T3Code-Gateway'"), 1);
      const pathScript = scriptsWith("Session Manager\\Environment")[0]!;
      assert.include(pathScript, `$d=${psLiteral(at("pf", "T3Code", "bin"))}`);
      assert.include(pathScript, "if(-not $has){return}");

      // Windows keeps a running exe from being deleted, so it leaves the runtime folder instead.
      assert.isFalse(yield* fs.exists(paths.runningExecutable));
      const aside = at("temp", `t3code-uninstalled-${process.pid}.exe`);
      assert.equal(yield* fs.readFileString(aside), "exe");
      assert.include(
        scriptsWith("MoveFileEx(")[0]!,
        `MoveFileEx(${psLiteral(aside)},[NullString]::Value,4)`,
      );
    }).pipe(Effect.scoped),
  );
});
