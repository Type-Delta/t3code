// @effect-diagnostics nodeBuiltinImport:off -- Effect's symlink takes no link type, and Windows links directories with a junction.
import * as NodeCrypto from "node:crypto";
import * as NodeFSP from "node:fs/promises";

import { parseNetstat, type NetstatRow } from "@t3tools/shared/gatewayHost";
import * as Clock from "effect/Clock";
import * as Console from "effect/Console";
import * as Duration from "effect/Duration";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Option from "effect/Option";
import * as Path from "effect/Path";
import * as Result from "effect/Result";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../../processRunner.ts";
import {
  GatewayPlatformError,
  type GatewayAccountId,
  type GatewayActivation,
  type GatewayPlatform,
  type GatewayPlatformServices,
  type GatewayUserRecord,
} from "./GatewayPlatform.ts";

export const GATEWAY_TASK = "Gateway";
export const backendTaskName = (user: string) => `Backend-${user}`;
export const MANAGED_MARKER = "Managed by t3 gateway install";
const firewallRule = "T3Code-Gateway";
const systemSid = "S-1-5-18";
const administratorsSid = "S-1-5-32-544";
const usersSid = "S-1-5-32-545";
// The NULL SID: the owner of a listener whose process could not be read. It matches no account.
const unknownOwner = "S-1-0-0";
const trustedSids = new Set([
  systemSid,
  administratorsSid,
  // NT SERVICE\TrustedInstaller, which owns C:\ and C:\Program Files.
  "S-1-5-80-956008885-3418522649-1831038044-1853292631-2271478464",
]);
// CREATOR OWNER and OWNER RIGHTS grant only to the owner, which is checked separately.
const ownerStandIns = new Set(["S-1-3-0", "S-1-3-4"]);
const sidPattern = /^S-1-\d+(-\d+)+$/;
const ownerCacheMs = 10 * 60 * 1000;
// TASK_LOGON_SERVICE_ACCOUNT and TASK_LOGON_S4U.
const serviceLogon = 5;
const s4uLogon = 2;

export interface Win32GatewayPaths {
  readonly systemRoot: string;
  readonly programFiles: string;
  readonly programData: string;
  readonly installRoot: string;
  /** A file symlink to `<installRoot>\current\t3.exe`; its folder is on the machine PATH. */
  readonly launcher: string;
  readonly configPath: string;
  readonly pairingDir: string;
  readonly logDir: string;
  /** This process's executable, which Windows does not let anyone delete while it runs. */
  readonly runningExecutable: string;
  /** Where uninstall moves a running executable until the next restart deletes it. */
  readonly tempDir: string;
}

// Windows always defines these. The fallbacks only keep the module importable elsewhere, for tests.
const hostEnvironment = process.env;
const systemRoot = hostEnvironment.SystemRoot ?? "C:\\Windows";
const programFiles = hostEnvironment.ProgramFiles ?? "C:\\Program Files";
const programData = hostEnvironment.ProgramData ?? "C:\\ProgramData";
export const win32GatewayPaths: Win32GatewayPaths = {
  systemRoot,
  programFiles,
  programData,
  installRoot: `${programFiles}\\T3Code`,
  launcher: `${programFiles}\\T3Code\\bin\\t3.exe`,
  configPath: `${programData}\\T3Code\\gateway.json`,
  pairingDir: `${programData}\\T3Code\\pairing`,
  logDir: `${programData}\\T3Code\\logs`,
  runningExecutable: process.execPath,
  tempDir: `${systemRoot}\\Temp`,
};

const fail = (message: string) => new GatewayPlatformError({ message });
const asPlatformError = (error: { readonly message: string }) => fail(error.message);

/** A PowerShell single-quoted literal. PowerShell also closes such strings at typographic quotes. */
export const psLiteral = (value: string) =>
  `'${value.replace(/['\u2018\u2019\u201a\u201b]/g, "$&$&")}'`;

// `J` prints ASCII-only JSON, so the console code page cannot garble non-English names.
const psPrelude = [
  "$ErrorActionPreference='Stop'",
  "$ProgressPreference='SilentlyContinue'",
  "function J($v){[regex]::Replace((ConvertTo-Json -InputObject $v -Depth 6 -Compress),'[^\\x00-\\x7F]',{param($m)'\\u{0:x4}' -f [int][char]$m.Value})}",
].join(";");

/** The `-EncodedCommand` value for `script`: UTF-16LE, base64. */
export const encodePowerShell = (script: string) =>
  Buffer.from(`${psPrelude};${script}`, "utf16le").toString("base64");

const xmlEntities: Readonly<Record<string, string>> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&apos;",
};
const xmlText = (value: string) => value.replace(/[&<>"']/g, (char) => xmlEntities[char] ?? char);

export interface TaskDefinition {
  readonly userId: string;
  readonly logonType: "ServiceAccount" | "S4U";
  readonly runLevel: "HighestAvailable" | "LeastPrivilege";
  readonly command: string;
  readonly arguments: string;
  readonly workingDirectory: string;
  readonly oneShot?: boolean;
  readonly executionTimeLimit?: string;
}

/**
 * Task Scheduler XML for one gateway task. No XML declaration: RegisterTask receives a UTF-16
 * string, and a declared encoding that disagrees with it is rejected. `Version` fingerprints the
 * rest, so an install can tell whether a registered task is current without redefining it.
 */
export const renderTaskXml = (task: TaskDefinition) => {
  const render = (version: string) => taskXmlLines(task, version).join("\r\n");
  return render(NodeCrypto.createHash("sha256").update(render("")).digest("hex").slice(0, 16));
};

/** The fingerprint `renderTaskXml` wrote. */
export const taskXmlVersion = (xml: string) => /<Version>([0-9a-f]*)<\/Version>/.exec(xml)?.[1];

const taskXmlLines = (task: TaskDefinition, version: string) => [
  `<Task version="1.2" xmlns="http://schemas.microsoft.com/windows/2004/02/mit/task">`,
  `  <RegistrationInfo>`,
  `    <Version>${version}</Version>`,
  `    <Description>${MANAGED_MARKER}</Description>`,
  `  </RegistrationInfo>`,
  ...(task.oneShot
    ? [`  <Triggers />`]
    : [
        `  <Triggers>`,
        `    <BootTrigger>`,
        `      <Enabled>true</Enabled>`,
        `    </BootTrigger>`,
        // Task Scheduler restarts nothing whose action exits, even with an error. With IgnoreNew,
        // this relaunches a stopped task within a minute and does nothing while it runs.
        `    <TimeTrigger>`,
        `      <StartBoundary>2000-01-01T00:00:00</StartBoundary>`,
        `      <Repetition>`,
        `        <Interval>PT1M</Interval>`,
        `      </Repetition>`,
        `    </TimeTrigger>`,
        `  </Triggers>`,
      ]),
  `  <Principals>`,
  `    <Principal id="Author">`,
  `      <UserId>${xmlText(task.userId)}</UserId>`,
  // The schema has no ServiceAccount value: a service account's SID implies that logon type.
  ...(task.logonType === "S4U" ? [`      <LogonType>S4U</LogonType>`] : []),
  `      <RunLevel>${task.runLevel}</RunLevel>`,
  `    </Principal>`,
  `  </Principals>`,
  `  <Settings>`,
  `    <MultipleInstancesPolicy>IgnoreNew</MultipleInstancesPolicy>`,
  `    <DisallowStartIfOnBatteries>false</DisallowStartIfOnBatteries>`,
  `    <StopIfGoingOnBatteries>false</StopIfGoingOnBatteries>`,
  `    <ExecutionTimeLimit>${task.executionTimeLimit ?? "PT0S"}</ExecutionTimeLimit>`,
  `    <Priority>5</Priority>`,
  `  </Settings>`,
  `  <Actions Context="Author">`,
  `    <Exec>`,
  `      <Command>${xmlText(task.command)}</Command>`,
  `      <Arguments>${xmlText(task.arguments)}</Arguments>`,
  `      <WorkingDirectory>${xmlText(task.workingDirectory)}</WorkingDirectory>`,
  `    </Exec>`,
  `  </Actions>`,
  `</Task>`,
];

// whoami writes quoted CSV; a quote inside a field is doubled.
const csvFields = (line: string) =>
  Array.from(line.matchAll(/"((?:[^"]|"")*)"/g), (match) => (match[1] ?? "").replaceAll('""', '"'));

/** The SID from `whoami /user /fo csv /nh`. */
export const parseWhoamiUser = (stdout: string) => {
  const sid = csvFields(stdout.trim()).at(-1);
  return sid !== undefined && sidPattern.test(sid) ? sid : undefined;
};

/**
 * From `whoami /groups /fo csv /nh`: an elevated administrator, or LocalSystem. A filtered UAC
 * token lists Administrators too (deny-only), but at the Medium label.
 */
export const isElevatedAdministrator = (stdout: string) => {
  const sids = new Set(stdout.split(/\r?\n/).map((line) => csvFields(line)[2]));
  return sids.has(administratorsSid) && (sids.has("S-1-16-12288") || sids.has("S-1-16-16384"));
};

/** Local and domain user accounts; RIDs below 1000 are built-in (Administrator, Guest, ...). */
const isRegularUserSid = (sid: string) => {
  const rid = /^S-1-5-21-\d+-\d+-\d+-(\d+)$/.exec(sid)?.[1];
  return rid !== undefined && Number(rid) >= 1000;
};

const isListening = (row: NetstatRow) => row.remote.port === 0;
const isLoopbackV4 = (address: string) => address === "127.0.0.1" || address === "::ffff:127.0.0.1";
const onlyPid = (rows: ReadonlyArray<NetstatRow>) => {
  const pids = new Set(rows.map((row) => row.pid));
  return pids.size === 1 ? rows[0]?.pid : undefined;
};

/**
 * The process holding the accepting end of 127.0.0.1:clientPort -> 127.0.0.1:backendPort, else
 * the port's only listener. Undefined when no row or several processes match.
 */
export const connectionPid = (
  rows: ReadonlyArray<NetstatRow>,
  backendPort: number,
  clientPort: number,
) => {
  const accepted = rows.filter(
    (row) =>
      row.pid !== 0 &&
      row.local.port === backendPort &&
      row.remote.port === clientPort &&
      isLoopbackV4(row.local.address) &&
      isLoopbackV4(row.remote.address),
  );
  if (accepted.length > 0) return onlyPid(accepted);
  return onlyPid(rows.filter((row) => isListening(row) && row.local.port === backendPort));
};

/**
 * The `DOMAIN\\user` running `pid`, from `tasklist /V /FO CSV /NH`. tasklist writes in the console
 * code page, so only an all-ASCII name is returned: any other could be misread as another account.
 */
export const parseTasklistAccount = (stdout: string, pid: number) => {
  for (const line of stdout.split(/\r?\n/)) {
    const fields = csvFields(line);
    const name = fields[6];
    if (
      fields[1] === String(pid) &&
      name !== undefined &&
      /^[\x21-\x7e][\x20-\x7e]*\\[\x20-\x7e]+$/.test(name)
    ) {
      return name;
    }
  }
  return undefined;
};

const AclEntry = Schema.Struct({
  path: Schema.String,
  owner: Schema.String,
  rules: Schema.Array(
    Schema.Struct({
      sid: Schema.String,
      rights: Schema.Number,
      allow: Schema.Boolean,
      inheritOnly: Schema.Boolean,
    }),
  ),
});
export type AclEntry = typeof AclEntry.Type;
const decodeAclEntries = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(AclEntry)));

// Read data, read (extended) attributes, execute, read control, synchronize, generic read/execute.
const readRights = 0x1 | 0x8 | 0x20 | 0x80 | 0x20000 | 0x100000 | 0x20000000 | 0x80000000;
// Add file, add subfolder, write (extended) attributes: what Users hold on C:\ and C:\ProgramData.
// Without delete rights they cannot replace an entry an administrator created.
const addEntryRights = 0x2 | 0x4 | 0x10 | 0x100;

/** Why someone other than `trusted` and the built-in administrators could modify it, if anyone. */
export const aclProblem = (
  acl: AclEntry,
  options: { readonly trusted?: string | undefined; readonly allowAddEntries: boolean },
) => {
  const isTrusted = (sid: string) => trustedSids.has(sid) || sid === options.trusted;
  if (!isTrusted(acl.owner)) return `it is owned by ${acl.owner}`;
  const allowed = readRights | (options.allowAddEntries ? addEntryRights : 0);
  const writer = acl.rules.find(
    (rule) =>
      rule.allow &&
      !rule.inheritOnly &&
      !isTrusted(rule.sid) &&
      !ownerStandIns.has(rule.sid) &&
      ((rule.rights >>> 0) & ~allowed) !== 0,
  );
  return writer === undefined ? undefined : `${writer.sid} can modify it`;
};

const psAclFunction =
  "function A($i){$a=Get-Acl -LiteralPath $i.FullName;[pscustomobject]@{path=$i.FullName;owner=$a.GetOwner([System.Security.Principal.SecurityIdentifier]).Value;rules=@($a.GetAccessRules($true,$true,[System.Security.Principal.SecurityIdentifier])|ForEach-Object{[pscustomobject]@{sid=$_.IdentityReference.Value;rights=[int64]$_.FileSystemRights;allow=($_.AccessControlType -eq 'Allow');inheritOnly=(($_.PropagationFlags -band 2) -ne 0)}})}}";

const UserLookup = Schema.Struct({
  sid: Schema.NullOr(Schema.String),
  profile: Schema.NullOr(Schema.String),
});
const decodeUserLookup = Schema.decodeEffect(Schema.fromJsonString(UserLookup));
const decodeOwners = Schema.decodeEffect(
  Schema.fromJsonString(
    Schema.Record(
      Schema.String,
      Schema.Struct({ sid: Schema.String, name: Schema.NullOr(Schema.String) }),
    ),
  ),
);
const TaskInfo = Schema.Struct({
  name: Schema.String,
  description: Schema.NullOr(Schema.String),
  state: Schema.Number,
  xml: Schema.String,
});
const decodeTasks = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(TaskInfo)));
const decodeNames = Schema.decodeEffect(Schema.fromJsonString(Schema.Array(Schema.String)));
const decodeAccountName = Schema.decodeEffect(Schema.fromJsonString(Schema.String));

// Task Scheduler's COM API: no module import, and IRunningTask names the action's process.
// S kills the action's process tree: ending a task stops cmd.exe but not the t3.exe it started.
const psTaskFunctions = (taskkill: string) =>
  [
    "$M=" + psLiteral(MANAGED_MARKER),
    "$sched=New-Object -ComObject Schedule.Service",
    "$sched.Connect()",
    "function T3Folder{try{$sched.GetFolder('\\T3Code')}catch{$null}}",
    "function T3Task($n){$f=T3Folder;if(-not $f){return $null};try{$f.GetTask($n)}catch{$null}}",
    `function T3Stop($n){$t=T3Task $n;if(-not $t){return};foreach($i in @($t.GetInstances(0))){if($i.EnginePID){try{& ${psLiteral(taskkill)} /PID $i.EnginePID /T /F|Out-Null}catch{}}};$t.Stop(0)}`,
    // With a user, that user's password arrives as one line on stdin.
    "function T3Register($n,$x,$l,$u){$t=T3Task $n;if($t -and $t.Definition.RegistrationInfo.Description -ne $M){throw \"\\T3Code\\$n is not managed by t3 gateway.\"};$p=$null;if($u){$p=[Console]::In.ReadLine()};T3Stop $n;$f=T3Folder;if(-not $f){$f=$sched.GetFolder('\\').CreateFolder('T3Code')};if($t){$f.DeleteTask($n,0)};$f.RegisterTask($n,$x,2,$u,$p,$l)|Out-Null}",
    "function T3Version($n){$t=T3Task $n;if(-not $t){'absent'}elseif($t.Definition.RegistrationInfo.Description -ne $M){'unmanaged'}else{'managed '+$t.Definition.RegistrationInfo.Version}}",
    "function T3Unregister($n){$t=T3Task $n;if(-not $t){return 'absent'};if($t.Definition.RegistrationInfo.Description -ne $M){return 'unmanaged'};T3Stop $n;(T3Folder).DeleteTask($n,0);'removed'}",
  ].join(";");

// LsaAddAccountRights, which no command-line tool exposes. Granting a held right is a no-op.
const lsaGrant =
  'using System;using System.Runtime.InteropServices;public static class T3Lsa{[StructLayout(LayoutKind.Sequential)]struct U{public ushort L;public ushort M;public IntPtr B;}[StructLayout(LayoutKind.Sequential)]struct A{public int L;public IntPtr R;public IntPtr N;public uint At;public IntPtr S;public IntPtr Q;}[DllImport("advapi32.dll")]static extern uint LsaOpenPolicy(IntPtr s,ref A a,int access,out IntPtr h);[DllImport("advapi32.dll")]static extern uint LsaAddAccountRights(IntPtr h,byte[] sid,U[] rights,int count);[DllImport("advapi32.dll")]static extern uint LsaClose(IntPtr h);[DllImport("advapi32.dll")]static extern int LsaNtStatusToWinError(uint s);public static int Grant(byte[] sid,string right){A a=new A();IntPtr h;uint st=LsaOpenPolicy(IntPtr.Zero,ref a,0x810,out h);if(st!=0)return LsaNtStatusToWinError(st);U u=new U();u.B=Marshal.StringToHGlobalUni(right);u.L=(ushort)(right.Length*2);u.M=(ushort)(u.L+2);try{return LsaNtStatusToWinError(LsaAddAccountRights(h,sid,new U[]{u},1));}finally{Marshal.FreeHGlobal(u.B);LsaClose(h);}}}';

/** S4U tasks log on as a batch job, a right Windows gives administrators but not users. */
const grantBatchLogonScript = (sid: string) =>
  [
    `Add-Type -TypeDefinition ${psLiteral(lsaGrant)}`,
    `$s=New-Object System.Security.Principal.SecurityIdentifier(${psLiteral(sid)})`,
    "$b=New-Object byte[] $s.BinaryLength",
    "$s.GetBinaryForm($b,0)",
    "$e=[T3Lsa]::Grant($b,'SeBatchLogonRight')",
    'if($e -ne 0){throw "Could not grant $($s.Value) the right to log on as a batch job (Windows error $e)."}',
  ].join(";");

// [NullString] passes a null new name, which MoveFileEx reads as "delete"; $null would pass "".
const deleteAtRestartScript = (file: string) =>
  [
    `Add-Type -Namespace T3 -Name Kernel32 -MemberDefinition ${psLiteral('[DllImport("kernel32.dll",CharSet=CharSet.Unicode,SetLastError=true)]public static extern bool MoveFileEx(string from,string to,int flags);')}`,
    // MOVEFILE_DELAY_UNTIL_REBOOT.
    `if(-not [T3.Kernel32]::MoveFileEx(${psLiteral(file)},[NullString]::Value,4)){throw "MoveFileEx failed with Windows error $([Runtime.InteropServices.Marshal]::GetLastWin32Error())."}`,
  ].join(";");

const pathEntryScript = (directory: string, add: boolean) =>
  [
    "$k=[Microsoft.Win32.Registry]::LocalMachine.OpenSubKey('SYSTEM\\CurrentControlSet\\Control\\Session Manager\\Environment',$true)",
    "$v=[string]$k.GetValue('Path','',[Microsoft.Win32.RegistryValueOptions]::DoNotExpandEnvironmentNames)",
    `$d=${psLiteral(directory)}`,
    "$p=@($v -split ';'|Where-Object{$_ -ne ''})",
    "$has=@($p|Where-Object{$_.TrimEnd('\\') -eq $d}).Count -gt 0",
    add
      ? "if($has){return};$n=($p+$d) -join ';'"
      : "if(-not $has){return};$n=@($p|Where-Object{$_.TrimEnd('\\') -ne $d}) -join ';'",
    // Machine PATH holds %SystemRoot% references, so it must stay REG_EXPAND_SZ.
    "$k.SetValue('Path',$n,[Microsoft.Win32.RegistryValueKind]::ExpandString)",
    // .NET broadcasts WM_SETTINGCHANGE after any machine variable change, so new shells see PATH.
    "[Environment]::SetEnvironmentVariable('T3CODE_GATEWAY_PATH_NOTICE',$null,'Machine')",
  ].join(";");

interface ToolOptions {
  readonly timeout?: Duration.Input;
  readonly maxOutputBytes?: number;
  readonly stdin?: string;
}

/** Reads one line without echoing it on a terminal; piped input supplies the first line. */
const readSecretLine = (prompt: string) =>
  Effect.callback<string, GatewayPlatformError>((resume) => {
    const input = process.stdin;
    const tty = input.isTTY === true;
    let line = "";
    const cleanup = () => {
      input.off("data", onData);
      input.off("end", onEnd);
      if (tty) input.setRawMode(false);
      input.pause();
    };
    const finish = (result: Effect.Effect<string, GatewayPlatformError>) => {
      cleanup();
      if (tty) process.stderr.write("\n");
      resume(result);
    };
    const onData = (chunk: string) => {
      for (const char of chunk) {
        if (char === "\r" || char === "\n") return finish(Effect.succeed(line));
        if (char === "\u0003") return finish(Effect.fail(fail("Cancelled.")));
        line =
          char === "\b" || char === "\u007f" ? Array.from(line).slice(0, -1).join("") : line + char;
      }
    };
    const onEnd = () =>
      finish(line === "" ? Effect.fail(fail("No password was given.")) : Effect.succeed(line));
    process.stderr.write(prompt);
    input.setEncoding("utf8");
    if (tty) input.setRawMode(true);
    input.on("data", onData);
    input.once("end", onEnd);
    input.resume();
    return Effect.sync(cleanup);
  });

/**
 * Windows Task Scheduler adapter; `paths` are overridable so tests can point it at a temporary
 * tree. `readPassword` asks for a user's Windows password, which registering their backend needs.
 */
export const makeWin32GatewayPlatform = (
  paths: Win32GatewayPaths,
  readPassword: (prompt: string) => Effect.Effect<string, GatewayPlatformError> = readSecretLine,
): GatewayPlatform => {
  const system32 = `${paths.systemRoot}\\System32`;
  const tool = {
    cmd: `${system32}\\cmd.exe`,
    icacls: `${system32}\\icacls.exe`,
    netstat: `${system32}\\netstat.exe`,
    taskkill: `${system32}\\taskkill.exe`,
    tasklist: `${system32}\\tasklist.exe`,
    whoami: `${system32}\\whoami.exe`,
    powershell: `${system32}\\WindowsPowerShell\\v1.0\\powershell.exe`,
  };
  const toolEnv = {
    SystemRoot: paths.systemRoot,
    PATH: `${system32};${system32}\\WindowsPowerShell\\v1.0`,
    ProgramFiles: paths.programFiles,
    ProgramData: paths.programData,
  };
  const logHint = `Task Scheduler history for \\T3Code\\ and ${paths.logDir}`;

  const exec = Effect.fn("GatewayPlatform.win32.exec")(function* (
    command: string,
    args: ReadonlyArray<string>,
    options?: ToolOptions,
  ) {
    const runner = yield* ProcessRunner.ProcessRunner;
    return yield* runner
      .run({
        command,
        args,
        env: toolEnv,
        timeout: options?.timeout ?? "120 seconds",
        maxOutputBytes: options?.maxOutputBytes,
        stdin: options?.stdin,
      })
      .pipe(Effect.mapError(asPlatformError));
  });

  const runTool = Effect.fn("GatewayPlatform.win32.runTool")(function* (
    command: string,
    args: ReadonlyArray<string>,
  ) {
    const result = yield* exec(command, args);
    if (result.code !== 0) {
      const name = command.slice(command.lastIndexOf("\\") + 1);
      return yield* fail(
        `${name} ${args.join(" ")} failed (exit ${result.code}). ${(result.stderr.trim() || result.stdout.trim()).slice(0, 500)}`.trim(),
      );
    }
    return result.stdout;
  });

  const powershell = Effect.fn("GatewayPlatform.win32.powershell")(function* (
    script: string,
    options?: ToolOptions,
  ) {
    const result = yield* exec(
      tool.powershell,
      [
        "-NoProfile",
        "-NonInteractive",
        "-ExecutionPolicy",
        "Bypass",
        "-EncodedCommand",
        encodePowerShell(script),
      ],
      options,
    );
    if (result.code !== 0) {
      return yield* fail(
        `PowerShell failed (exit ${result.code}). ${result.stderr.trim().slice(0, 500)}`.trim(),
      );
    }
    return result.stdout;
  });

  const entry = Effect.fn("GatewayPlatform.win32.entry")(function* (file: string) {
    const fs = yield* FileSystem.FileSystem;
    return yield* fs.lstat(file).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
  });

  const currentAccount = Effect.gen(function* () {
    const sid = parseWhoamiUser(yield* runTool(tool.whoami, ["/user", "/fo", "csv", "/nh"]));
    if (sid === undefined) return yield* fail("Could not determine the current Windows account.");
    return sid;
  });
  const accountNames = new Map<string, string>();
  const accountName = Effect.fn("GatewayPlatform.win32.accountName")(function* (
    accountId: GatewayAccountId,
  ) {
    if (typeof accountId !== "string" || !sidPattern.test(accountId)) {
      return yield* fail(`Windows account id ${String(accountId)} is not a SID.`);
    }
    const cached = accountNames.get(accountId);
    if (cached !== undefined) return cached;
    const output = yield* powershell(
      [
        `$s=New-Object System.Security.Principal.SecurityIdentifier(${psLiteral(accountId)})`,
        `$n=$s.Translate([System.Security.Principal.NTAccount]).Value`,
        "$n=$n -replace '^[^\\\\]+\\\\',''",
        "J $n",
      ].join(";"),
    ).pipe(Effect.flatMap(decodeAccountName));
    accountNames.set(accountId, output);
    return output;
  }, Effect.mapError(asPlatformError));
  // checkRuntimeSource runs once per archive file; the invoking account does not change.
  let invokingAccount: string | undefined;

  const isAdmin = runTool(tool.whoami, ["/groups", "/fo", "csv", "/nh"]).pipe(
    Effect.map(isElevatedAdministrator),
  );

  const lookupUser = Effect.fn("GatewayPlatform.win32.lookupUser")(function* (name: string) {
    const fs = yield* FileSystem.FileSystem;
    const lookup = yield* powershell(
      [
        `$n=${psLiteral(name)}`,
        "$s=$null",
        "$p=$null",
        "try{$s=(New-Object System.Security.Principal.NTAccount($n)).Translate([System.Security.Principal.SecurityIdentifier]).Value}catch{}",
        "if($s){$k=Get-ItemProperty -LiteralPath ('HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\ProfileList\\'+$s) -ErrorAction SilentlyContinue;if($k -and $k.ProfileImagePath){$p=[string]$k.ProfileImagePath}}",
        "J ([pscustomobject]@{sid=$s;profile=$p})",
      ].join(";"),
    ).pipe(Effect.flatMap(decodeUserLookup));
    if (lookup.sid === null) return yield* fail(`Windows user ${name} was not found.`);
    if (!isRegularUserSid(lookup.sid)) {
      return yield* fail(
        `${name} (${lookup.sid}) is not a regular Windows user account and cannot be enrolled.`,
      );
    }
    if (!lookup.profile) {
      return yield* fail(
        `Windows user ${name} has no profile yet. Sign in to Windows once as ${name}, then retry.`,
      );
    }
    const home = yield* fs.stat(lookup.profile).pipe(
      Effect.catchIf(
        (error) => error.reason._tag === "NotFound",
        () => Effect.undefined,
      ),
    );
    if (home?.type !== "Directory") {
      return yield* fail(`The profile folder ${lookup.profile} for ${name} does not exist.`);
    }
    return { name, accountId: lookup.sid, home: lookup.profile } satisfies GatewayUserRecord;
  }, Effect.mapError(asPlatformError));

  const readAcl = Effect.fn("GatewayPlatform.win32.readAcl")(function* (file: string) {
    const [acl] = yield* powershell(
      `${psAclFunction};J @(A (Get-Item -LiteralPath ${psLiteral(file)} -Force))`,
    ).pipe(Effect.flatMap(decodeAclEntries));
    if (acl === undefined) return yield* fail(`Could not read the permissions of ${file}.`);
    return acl;
  });

  // An archive holds thousands of files, so the first check of its folder reads every ACL below it
  // in one PowerShell run. Everything is keyed by lowercased path, as Windows compares paths.
  const runtimeAcls = new Map<string, AclEntry>();
  const scanRuntimeTree = Effect.fn("GatewayPlatform.win32.scanRuntimeTree")(function* (
    directory: string,
  ) {
    const entries = yield* powershell(
      [
        psAclFunction,
        "$o=New-Object System.Collections.Generic.List[object]",
        "function W($d){foreach($c in @(Get-ChildItem -LiteralPath $d -Force)){$o.Add((A $c));if($c.PSIsContainer -and -not ($c.Attributes -band [System.IO.FileAttributes]::ReparsePoint)){W $c.FullName}}}",
        `$r=Get-Item -LiteralPath ${psLiteral(directory)} -Force`,
        "$o.Add((A $r))",
        "W $r.FullName",
        "J $o.ToArray()",
      ].join(";"),
      { timeout: "10 minutes", maxOutputBytes: 256 * 1024 * 1024 },
    ).pipe(Effect.flatMap(decodeAclEntries));
    for (const acl of entries) runtimeAcls.set(acl.path.toLowerCase(), acl);
  });

  // Users may add entries to C:\ and C:\ProgramData. The trees the gateway owns allow no one else.
  const isManagedAncestor = Effect.fn("GatewayPlatform.win32.isManagedAncestor")(function* (
    file: string,
  ) {
    const path = yield* Path.Path;
    return [paths.installRoot, path.dirname(paths.configPath)].some((root) => {
      const relative = path.relative(file, root);
      return relative !== "" && !relative.startsWith("..") && !path.isAbsolute(relative);
    });
  });

  const checkKind = Effect.fn("GatewayPlatform.win32.checkKind")(function* (
    file: string,
    kind: "File" | "Directory",
    info: FileSystem.File.Info,
  ) {
    if (info.type !== kind) {
      return yield* fail(
        `Expected a ${kind === "Directory" ? "directory" : "regular file"} at ${file}.`,
      );
    }
  });

  const checkAdminOwned = Effect.fn("GatewayPlatform.win32.checkAdminOwned")(function* (
    file: string,
    kind: "File" | "Directory",
    options?: { readonly ancestor?: boolean },
  ) {
    const info = yield* entry(file);
    if (info === undefined) return false;
    yield* checkKind(file, kind, info);
    const lenient = options?.ancestor === true || (yield* isManagedAncestor(file));
    const problem = aclProblem(yield* readAcl(file), {
      allowAddEntries: kind === "Directory" && lenient,
    });
    if (problem !== undefined) {
      return yield* fail(
        `Expected ${file} to be modifiable only by administrators, but ${problem}.`,
      );
    }
    return true;
  }, Effect.mapError(asPlatformError));

  const checkRuntimeSource = Effect.fn("GatewayPlatform.win32.checkRuntimeSource")(function* (
    file: string,
    kind: "File" | "Directory",
    options?: { readonly ancestor?: boolean },
  ) {
    const fs = yield* FileSystem.FileSystem;
    yield* checkKind(file, kind, yield* fs.lstat(file));
    invokingAccount ??= yield* currentAccount;
    const key = file.toLowerCase();
    if (!runtimeAcls.has(key) && kind === "Directory" && options?.ancestor !== true) {
      yield* scanRuntimeTree(file);
    }
    const acl = runtimeAcls.get(key) ?? (yield* readAcl(file));
    const problem = aclProblem(acl, {
      trusted: invokingAccount,
      allowAddEntries: kind === "Directory" && options?.ancestor === true,
    });
    if (problem !== undefined) {
      return yield* fail(
        `Runtime source ${file} must be modifiable only by administrators or you, but ${problem}.`,
      );
    }
  }, Effect.mapError(asPlatformError));

  /**
   * Creates `directory` (and missing parents) and replaces its permissions with `grants`: owned by
   * Administrators, inheriting nothing, passing the grants on to everything created below it.
   */
  const restrictDirectory = Effect.fn("GatewayPlatform.win32.restrictDirectory")(function* (
    directory: string,
    grants: ReadonlyArray<string>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    yield* fs.makeDirectory(path.dirname(directory), { recursive: true });
    const created = yield* fs.makeDirectory(directory).pipe(
      Effect.as(true),
      Effect.catchIf(
        (error) => error.reason._tag === "AlreadyExists",
        () => Effect.succeed(false),
      ),
    );
    if ((yield* fs.lstat(directory)).type !== "Directory") {
      return yield* fail(`Expected a directory at ${directory}.`);
    }
    // `/L` acts on a link swapped in meanwhile, never on its target.
    yield* runTool(tool.icacls, [directory, "/setowner", `*${administratorsSid}`, "/L", "/Q"]);
    // Drops explicit entries left by someone else; a folder created just now has none.
    if (!created) yield* runTool(tool.icacls, [directory, "/reset", "/L", "/Q"]);
    yield* runTool(tool.icacls, [directory, "/inheritance:r", "/grant:r", ...grants, "/L", "/Q"]);
  });

  const accountSid = Effect.fn("GatewayPlatform.win32.accountSid")(function* (
    user: GatewayUserRecord,
  ) {
    if (typeof user.accountId !== "string" || !sidPattern.test(user.accountId)) {
      return yield* fail(`${user.name}'s account id ${user.accountId} is not a Windows SID.`);
    }
    return user.accountId;
  });

  const secureDirectory = Effect.fn("GatewayPlatform.win32.secureDirectory")(function* (
    directory: string,
    owner: "admin" | GatewayUserRecord,
  ) {
    const grants = [
      `*${systemSid}:(OI)(CI)F`,
      `*${administratorsSid}:(OI)(CI)F`,
      `*${usersSid}:(OI)(CI)RX`,
    ];
    if (owner !== "admin") grants.push(`*${yield* accountSid(owner)}:(OI)(CI)M`);
    yield* restrictDirectory(directory, grants);
  }, Effect.mapError(asPlatformError));

  const removeTree = Effect.fn("GatewayPlatform.win32.removeTree")(function* (directory: string) {
    const fs = yield* FileSystem.FileSystem;
    const info = yield* entry(directory);
    if (info === undefined) return;
    // Removing a junction or symlink removes the link only.
    if (info.type === "SymbolicLink") return yield* fs.remove(directory);
    if (info.type !== "Directory") return yield* fail(`Expected a directory at ${directory}.`);
    // Take the folder back first, so its user cannot swap an entry for a junction during removal.
    yield* runTool(tool.icacls, [
      directory,
      "/setowner",
      `*${administratorsSid}`,
      "/T",
      "/L",
      "/Q",
    ]);
    yield* runTool(tool.icacls, [directory, "/reset", "/T", "/L", "/Q"]);
    yield* fs.remove(directory, { recursive: true });
  }, Effect.mapError(asPlatformError));

  const createLink = (target: string, link: string, type: "junction" | "file") =>
    Effect.tryPromise({
      try: () => NodeFSP.symlink(target, link, type),
      catch: (cause) => fail(`Could not link ${link} to ${target}: ${String(cause)}`),
    });

  // Directories link through a junction, which needs no symlink privilege. Windows cannot rename a
  // directory over another, so an existing junction moves aside for a moment first.
  const replaceLink = Effect.fn("GatewayPlatform.win32.replaceLink")(
    function* (target: string, link: string) {
      const fs = yield* FileSystem.FileSystem;
      const path = yield* Path.Path;
      const type = (yield* fs.stat(target)).type === "Directory" ? "junction" : "file";
      const existing = yield* entry(link);
      if (existing !== undefined && existing.type !== "SymbolicLink") {
        return yield* fail(`Refusing to replace ${link}: it is not a link.`);
      }
      const staging = yield* fs.makeTempDirectoryScoped({
        directory: path.dirname(link),
        prefix: ".t3code-",
      });
      const staged = path.join(staging, "link");
      const aside = path.join(staging, "previous");
      yield* Effect.gen(function* () {
        yield* createLink(target, staged, type);
        if (existing === undefined || type === "file") return yield* fs.rename(staged, link);
        yield* fs.rename(link, aside);
        yield* fs
          .rename(staged, link)
          .pipe(Effect.tapError(() => fs.rename(aside, link).pipe(Effect.ignore)));
      }).pipe(
        // Unlink leftover links before the scope removes the staging folder recursively.
        Effect.ensuring(
          Effect.forEach([staged, aside], (file) => fs.remove(file, { force: true }), {
            discard: true,
          }).pipe(Effect.ignore),
        ),
      );
    },
    Effect.scoped,
    Effect.mapError(asPlatformError),
  );

  const netstatRows = runTool(tool.netstat, ["-ano"]).pipe(Effect.map(parseNetstat));

  // Each owner's account name comes from its SID, so a name always maps to the right SID.
  const processOwners = Effect.fn("GatewayPlatform.win32.processOwners")(function* (
    pids: ReadonlyArray<number>,
  ) {
    if (pids.length === 0) return new Map<number, { sid: string; name: string | null }>();
    const filter = pids.map((pid) => `ProcessId=${pid}`).join(" OR ");
    const owners = yield* powershell(
      `$r=@{};foreach($p in @(Get-CimInstance Win32_Process -Filter ${psLiteral(filter)})){try{$s=(Invoke-CimMethod -InputObject $p -MethodName GetOwnerSid).Sid;if($s){$n=$null;try{$n=(New-Object System.Security.Principal.SecurityIdentifier($s)).Translate([System.Security.Principal.NTAccount]).Value}catch{};$r[[string]$p.ProcessId]=[pscustomobject]@{sid=$s;name=$n}}}catch{}};J ([pscustomobject]$r)`,
    ).pipe(Effect.flatMap(decodeOwners), Effect.mapError(asPlatformError));
    return new Map(Object.entries(owners).map(([pid, owner]) => [Number(pid), owner]));
  });

  const listenersOn = Effect.fn("GatewayPlatform.win32.listenersOn")(function* (
    port: number | undefined,
  ) {
    const rows = (yield* netstatRows).filter(
      (row) => isListening(row) && (port === undefined || row.local.port === port),
    );
    const owners = yield* processOwners([...new Set(rows.map((row) => row.pid))]);
    const seen = new Set<string>();
    return rows.flatMap((row) => {
      const owner = owners.get(row.pid)?.sid ?? unknownOwner;
      const key = `${row.local.port}:${owner}`;
      if (seen.has(key)) return [];
      seen.add(key);
      return [{ port: row.local.port, owner }];
    });
  });

  // A PowerShell owner lookup costs most of a second, and every backend connection needs an owner.
  // A PID can be reused by another account, so the cache maps the account name tasklist (~30 ms)
  // reports for the PID right now to that account's SID; the PID itself is never trusted.
  const makeConnectionOwner = Effect.gen(function* () {
    const run = Effect.runPromiseExitWith(yield* Effect.context<GatewayPlatformServices>());
    const accounts = new Map<string, { readonly sid: string; readonly expiresAt: number }>();
    const lookup = Effect.fn("GatewayPlatform.win32.connectionOwner")(function* (
      backendPort: number,
      clientPort: number,
    ) {
      const pid = connectionPid(yield* netstatRows, backendPort, clientPort);
      if (pid === undefined) return undefined;
      const now = yield* Clock.currentTimeMillis;
      const name = parseTasklistAccount(
        yield* runTool(tool.tasklist, ["/V", "/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"]),
        pid,
      )?.toLowerCase();
      const cached = name === undefined ? undefined : accounts.get(name);
      if (cached !== undefined && cached.expiresAt > now) return cached.sid;
      const owner = (yield* processOwners([pid])).get(pid);
      if (owner?.name)
        accounts.set(owner.name.toLowerCase(), { sid: owner.sid, expiresAt: now + ownerCacheMs });
      return owner?.sid;
    });
    return async (backendPort: number, clientPort: number) => {
      const exit = await run(lookup(backendPort, clientPort));
      return Exit.isSuccess(exit) ? exit.value : undefined;
    };
  });

  const tasks = powershell(
    `${psTaskFunctions(tool.taskkill)};$f=T3Folder;J @(if($f){foreach($t in @($f.GetTasks(1))){[pscustomobject]@{name=$t.Name;description=$t.Definition.RegistrationInfo.Description;state=[int]$t.State;xml=$t.Xml}}})`,
  ).pipe(Effect.flatMap(decodeTasks), Effect.mapError(asPlatformError));

  const taskScript = (script: string, options?: ToolOptions) =>
    powershell(`${psTaskFunctions(tool.taskkill)};${script}`, options);
  const registerTask = (name: string, xml: string, logonType: number) =>
    taskScript(`T3Register ${psLiteral(name)} ${psLiteral(xml)} ${logonType}`);
  const stopTask = (name: string) => taskScript(`T3Stop ${psLiteral(name)}`);
  const startTask = (name: string) => taskScript(`(T3Task ${psLiteral(name)}).Run($null)|Out-Null`);

  const taskState = (name: string) =>
    taskScript(
      `$t=T3Task ${psLiteral(name)};if(-not $t){'unavailable'}else{switch([int]$t.State){4{'running'}3{'stopped'}2{'queued'}1{'disabled'}default{'unknown'}}}`,
    ).pipe(
      Effect.map((stdout) => stdout.trim() || "unavailable"),
      Effect.orElseSucceed(() => "unavailable"),
    );

  // cmd.exe expands %VAR% even inside quotes, and a quote would end the path.
  const actionFor = Effect.fn("GatewayPlatform.win32.actionFor")(function* (
    executable: string,
    verb: "run" | "run-backend",
    log: string,
  ) {
    if (/[%"]/.test(executable + log)) {
      return yield* fail(`Gateway paths cannot contain % or ": ${executable}, ${log}.`);
    }
    return {
      command: tool.cmd,
      arguments: `/d /c ""${executable}" gateway ${verb} >> "${log}" 2>&1"`,
    };
  });

  const quoteCommandArgument = (value: string) => {
    if (value !== "" && !/[\s"]/.test(value)) return value;
    return `"${value.replace(/(\\*)"/g, '$1$1\\"').replace(/(\\+)$/g, "$1$1")}"`;
  };

  const detachedTaskXml = Effect.fn("GatewayPlatform.win32.detachedTaskXml")(function* (
    argv: ReadonlyArray<string>,
  ) {
    const path = yield* Path.Path;
    const command = argv[0];
    if (command === undefined) return yield* fail("Detached jobs require a non-empty command.");
    return renderTaskXml({
      userId: systemSid,
      logonType: "ServiceAccount",
      runLevel: "HighestAvailable",
      workingDirectory: path.dirname(paths.configPath),
      command,
      arguments: argv.slice(1).map(quoteCommandArgument).join(" "),
      oneShot: true,
      executionTimeLimit: "PT30M",
    });
  });

  const gatewayTaskXml = Effect.fn("GatewayPlatform.win32.gatewayTaskXml")(function* (
    executable: string,
  ) {
    const path = yield* Path.Path;
    return renderTaskXml({
      userId: systemSid,
      logonType: "ServiceAccount",
      runLevel: "HighestAvailable",
      workingDirectory: path.dirname(paths.configPath),
      ...(yield* actionFor(executable, "run", path.join(paths.logDir, "gateway.log"))),
    });
  });

  const backendLog = (user: string) =>
    Effect.map(Path.Path, (path) => path.join(paths.logDir, `backend-${user}.log`));

  const backendTaskXml = Effect.fn("GatewayPlatform.win32.backendTaskXml")(function* (
    user: GatewayUserRecord,
    executable: string,
  ) {
    return renderTaskXml({
      userId: yield* accountSid(user),
      logonType: "S4U",
      runLevel: "LeastPrivilege",
      workingDirectory: user.home,
      ...(yield* actionFor(executable, "run-backend", yield* backendLog(user.name))),
    });
  });

  // Logs are for administrators. Each backend may append to its own file but not remove it, or
  // cmd.exe could not recreate it and the task would stop starting.
  const secureLogs = Effect.fn("GatewayPlatform.win32.secureLogs")(function* (
    users: ReadonlyArray<GatewayUserRecord>,
  ) {
    const fs = yield* FileSystem.FileSystem;
    yield* restrictDirectory(paths.logDir, [
      `*${systemSid}:(OI)(CI)F`,
      `*${administratorsSid}:(OI)(CI)F`,
    ]);
    for (const user of users) {
      const log = yield* backendLog(user.name);
      // A running backend's cmd.exe holds its log open for writing, so only a new one is created.
      if (!(yield* fs.exists(log))) yield* fs.writeFileString(log, "", { flag: "a" });
      yield* runTool(tool.icacls, [
        log,
        "/inheritance:r",
        "/grant:r",
        `*${systemSid}:F`,
        `*${administratorsSid}:F`,
        `*${yield* accountSid(user)}:(GR,GW)`,
        "/L",
        "/Q",
      ]);
    }
  });

  // An administrator can stop and run another user's S4U task, but defining one needs that
  // user's password: Windows checks it at registration and stores nothing.
  const backendTask = Effect.fn("GatewayPlatform.win32.backendTask")(function* (
    user: GatewayUserRecord,
    executable: string,
  ) {
    const name = backendTaskName(user.name);
    const xml = yield* backendTaskXml(user, executable);
    const registered = (yield* taskScript(`T3Version ${psLiteral(name)}`)).trim();
    return {
      name,
      xml,
      managed: registered.split(" ")[0] === "managed",
      current: registered === `managed ${taskXmlVersion(xml)}`,
    };
  });

  // Every definition runs current\t3.exe, so a restart picks up the installed runtime.
  const restartBackend = Effect.fn("GatewayPlatform.win32.restartBackend")(function* (
    user: GatewayUserRecord,
    name: string,
  ) {
    yield* secureLogs([user]);
    yield* stopTask(name);
    yield* startTask(name);
  });

  const enableUser = Effect.fn("GatewayPlatform.win32.enableUser")(function* (
    user: GatewayUserRecord,
    executable: string,
    options?: { readonly password?: string },
  ) {
    const { name, xml, current } = yield* backendTask(user, executable);
    if (current) return yield* restartBackend(user, name);
    const password =
      options?.password ??
      (yield* readPassword(
        `Windows password for ${user.name} (registers their backend task; it is not stored): `,
      ));
    const sid = yield* accountSid(user);
    yield* secureLogs([user]);
    yield* powershell(grantBatchLogonScript(sid));
    // Registering stops a running instance first.
    yield* taskScript(
      `T3Register ${psLiteral(name)} ${psLiteral(xml)} ${s4uLogon} ${psLiteral(sid)}`,
      { stdin: `${password}\n` },
    );
    yield* startTask(name);
  }, Effect.mapError(asPlatformError));

  const runDetached = Effect.fn("GatewayPlatform.win32.runDetached")(function* (
    label: string,
    argv: ReadonlyArray<string>,
  ) {
    if (!/^[a-z]+$/.test(label) || argv.length === 0) {
      return yield* fail("Detached jobs require a lowercase label and a non-empty command.");
    }
    const name = `${label[0]!.toUpperCase()}${label.slice(1)}`;
    const xml = yield* detachedTaskXml(argv);
    yield* registerTask(name, xml, serviceLogon);
    yield* startTask(name);
  }, Effect.mapError(asPlatformError));

  const waitUntil = Effect.fn("GatewayPlatform.win32.waitUntil")(function* (
    ready: Effect.Effect<boolean, GatewayPlatformError, GatewayPlatformServices>,
    seconds: number,
    message: string,
  ) {
    return yield* Effect.gen(function* () {
      while (!(yield* ready)) yield* Effect.sleep("500 millis");
    }).pipe(
      Effect.timeoutOrElse({ duration: Duration.seconds(seconds), orElse: () => fail(message) }),
    );
  });

  // An orphaned gateway would keep the port and pass the listen check, so the port must free up.
  const restartGateway = Effect.fn("GatewayPlatform.win32.restartGateway")(function* (
    port: number,
    account: GatewayAccountId,
  ) {
    yield* stopTask(GATEWAY_TASK);
    yield* waitUntil(
      Effect.map(
        netstatRows,
        (rows) => !rows.some((row) => isListening(row) && row.local.port === port),
      ),
      10,
      `Port ${port} is still in use after stopping the gateway.`,
    );
    yield* startTask(GATEWAY_TASK);
    yield* waitUntil(
      Effect.map(listenersOn(port), (listening) =>
        listening.some((listener) => listener.owner === account),
      ),
      30,
      `The gateway did not listen on port ${port} within 30 seconds.`,
    );
  });

  const configureHost = Effect.fn("GatewayPlatform.win32.configureHost")(function* (port: number) {
    const path = yield* Path.Path;
    yield* powershell(
      [
        `Remove-NetFirewallRule -Name ${psLiteral(firewallRule)} -ErrorAction SilentlyContinue`,
        `New-NetFirewallRule -Name ${psLiteral(firewallRule)} -DisplayName 'T3 Code gateway' -Description ${psLiteral(MANAGED_MARKER)} -Direction Inbound -Action Allow -Protocol TCP -LocalPort ${port} -Profile Domain,Private|Out-Null`,
        "J @(Get-NetConnectionProfile|Where-Object{[string]$_.NetworkCategory -eq 'Public'}|ForEach-Object{[string]$_.InterfaceAlias})",
      ].join(";"),
    ).pipe(
      Effect.flatMap(decodeNames),
      // The rule leaves Public networks closed, which Windows picks for networks it does not know.
      Effect.flatMap((publicNetworks) =>
        Effect.forEach(publicNetworks, (alias) =>
          Console.warn(
            `Windows treats network ${alias} as Public, so the firewall keeps port ${port} closed on it. On a trusted network, run: Set-NetConnectionProfile -InterfaceAlias ${psLiteral(alias)} -NetworkCategory Private`,
          ),
        ),
      ),
      Effect.catch((error) =>
        Console.warn(`Could not open port ${port} in Windows Firewall: ${error.message}`),
      ),
    );
    yield* powershell(pathEntryScript(path.dirname(paths.launcher), true)).pipe(
      Effect.catch((error) =>
        Console.warn(`Could not add ${path.dirname(paths.launcher)} to PATH: ${error.message}`),
      ),
    );
  });

  const preflight = Effect.gen(function* () {
    const unmanaged = (yield* tasks).filter((task) => task.description !== MANAGED_MARKER);
    if (unmanaged.length > 0) {
      return yield* fail(
        `Refusing to install: ${unmanaged.map((task) => `\\T3Code\\${task.name}`).join(", ")} ${unmanaged.length === 1 ? "is" : "are"} not managed by t3 gateway. Remove ${unmanaged.length === 1 ? "it" : "them"} first.`,
      );
    }
  }).pipe(Effect.mapError(asPlatformError));

  const activate = Effect.fn("GatewayPlatform.win32.activate")(function* (
    activation: GatewayActivation,
  ) {
    const { port } = activation.config.listen;
    const previousXml = (yield* tasks).find((task) => task.name === GATEWAY_TASK)?.xml;
    const xml = yield* gatewayTaskXml(activation.executable);
    const restorePreviousRuntime = activation.restorePreviousRuntime;
    yield* secureLogs([]);
    yield* configureHost(port);
    let rollbackStatus = "";
    yield* Effect.gen(function* () {
      yield* registerTask(GATEWAY_TASK, xml, serviceLogon);
      yield* restartGateway(port, activation.gatewayAccount);
    }).pipe(
      Effect.onExit((exit) => {
        if (Exit.isSuccess(exit) || restorePreviousRuntime === undefined) return Effect.void;
        return Effect.gen(function* () {
          const rollback = yield* Effect.gen(function* () {
            yield* restorePreviousRuntime;
            if (previousXml === undefined) {
              yield* taskScript(`T3Unregister ${psLiteral(GATEWAY_TASK)}|Out-Null`);
              return;
            }
            yield* registerTask(GATEWAY_TASK, previousXml, serviceLogon);
            yield* restartGateway(port, activation.gatewayAccount);
          }).pipe(Effect.result);
          rollbackStatus = Result.isSuccess(rollback)
            ? previousXml === undefined
              ? "Restored the previous runtime."
              : "Restored the previous runtime and gateway task. The gateway is listening."
            : `Rollback failed: ${rollback.failure.message}`;
          if (Exit.hasInterrupts(exit)) yield* Console.warn(`${rollbackStatus} See ${logHint}.`);
        });
      }),
      Effect.mapError((error) =>
        fail([error.message, rollbackStatus, `See ${logHint}.`].filter(Boolean).join(" ")),
      ),
    );

    let failure: { readonly message: string } | undefined;
    for (const user of activation.users) {
      const name = backendTaskName(user.name);
      const started = yield* backendTask(user, activation.executable).pipe(
        Effect.tap((task) => (task.managed ? restartBackend(user, name) : Effect.void)),
        Effect.result,
      );
      if (Result.isFailure(started)) failure ??= started.failure;
      else if (!started.success.current) {
        yield* Console.warn(
          `${name} is missing or out of date. Run \`t3 gateway add ${user.name}\` to register it with ${user.name}'s Windows password.`,
        );
      }
      yield* Console.log(`${name}: ${yield* taskState(name)}`);
    }
    if (failure !== undefined) return yield* fail(failure.message);
  }, Effect.mapError(asPlatformError));

  const uninstall = Effect.gen(function* () {
    const path = yield* Path.Path;
    const skipped = yield* taskScript(
      [
        "$skipped=@()",
        "$f=T3Folder",
        "if($f){foreach($t in @($f.GetTasks(1))){if($t.Definition.RegistrationInfo.Description -eq $M){T3Stop $t.Name;$f.DeleteTask($t.Name,0)}else{$skipped+=$t.Name}};if($skipped.Count -eq 0){$sched.GetFolder('\\').DeleteFolder('T3Code',0)}}",
        "J @($skipped)",
      ].join(";"),
    ).pipe(Effect.flatMap(decodeNames));
    for (const name of skipped) {
      yield* Console.warn(`Skipping \\T3Code\\${name}: it is not managed by t3 gateway.`);
    }
    yield* powershell(
      `Remove-NetFirewallRule -Name ${psLiteral(firewallRule)} -ErrorAction SilentlyContinue`,
    ).pipe(
      Effect.catch((error) => Console.warn(`Could not remove the firewall rule: ${error.message}`)),
    );
    yield* powershell(pathEntryScript(path.dirname(paths.launcher), false)).pipe(
      Effect.catch((error) =>
        Console.warn(
          `Could not remove ${path.dirname(paths.launcher)} from PATH: ${error.message}`,
        ),
      ),
    );
    // `t3 gateway uninstall` usually runs the installed t3.exe. Windows can move a running
    // program but not delete it, so it moves out of the runtime folder that is removed next.
    const fs = yield* FileSystem.FileSystem;
    const running = yield* fs.realPath(paths.runningExecutable).pipe(Effect.option);
    if (Option.isNone(running)) return;
    const relative = path.relative(paths.installRoot.toLowerCase(), running.value.toLowerCase());
    if (relative === "" || relative.startsWith("..") || path.isAbsolute(relative)) return;
    const aside = path.join(paths.tempDir, `t3code-uninstalled-${process.pid}.exe`);
    yield* fs.rename(running.value, aside);
    yield* powershell(deleteAtRestartScript(aside)).pipe(
      Effect.catch((error) =>
        Console.warn(`Could not schedule ${aside} for deletion: ${error.message}`),
      ),
    );
  }).pipe(Effect.mapError(asPlatformError));

  const disableUser = Effect.fn("GatewayPlatform.win32.disableUser")(function* (user: string) {
    const name = backendTaskName(user);
    const outcome = (yield* taskScript(`T3Unregister ${psLiteral(name)}`)).trim();
    if (outcome === "unmanaged") {
      yield* Console.warn(`Skipping \\T3Code\\${name}: it is not managed by t3 gateway.`);
    }
  }, Effect.mapError(asPlatformError));

  return {
    name: "win32",
    layout: {
      installRoot: paths.installRoot,
      launcher: paths.launcher,
      configPath: paths.configPath,
      pairingDir: paths.pairingDir,
      executableName: "t3.exe",
      runtimeEntries: [
        ["client", "Directory"],
        ["node_modules", "Directory"],
        ["resource-monitor", "Directory"],
        ["client/index.html", "File"],
      ],
    },
    currentAccount: currentAccount.pipe(Effect.mapError(asPlatformError)),
    isAdmin: isAdmin.pipe(Effect.mapError(asPlatformError)),
    lookupUser,
    accountName,
    checkAdminOwned,
    checkRuntimeSource,
    secureDirectory,
    // Files created or copied into a secured directory inherit its permissions, which let everyone
    // read (CopyFile does not carry the source's), so there is nothing to change per file.
    secureRuntimeFile: () => Effect.void,
    removeTree,
    replaceLink,
    listeners: listenersOn(undefined).pipe(Effect.mapError(asPlatformError)),
    makeConnectionOwner,
    markerAttribution: "folder",
    helperHost: "gateway",
    joinNeedsPassword: true,
    services: {
      ensureGatewayAccount: Effect.succeed(systemSid),
      preflight,
      activate,
      enableUser,
      disableUser,
      userState: (user) => taskState(backendTaskName(user)),
      runDetached,
      uninstall,
      logHint,
    },
  };
};

export const win32GatewayPlatform = makeWin32GatewayPlatform(win32GatewayPaths);
