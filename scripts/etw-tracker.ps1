#Requires -Version 5.1
# DBD Server Blocker - live game server tracker (ETW, Microsoft-Windows-Kernel-Network).
#
# Listens to the kernel UDP events of the Dead by Daylight process (IPv4 + IPv6), aggregates the remote
# endpoints in a rolling window and prints one JSON line per tick on stdout. Diagnostics go to stderr.
#
# Lifecycle: the real-time ETW session only exists while the game runs. "stop" on stdin or a normal exit
# stops it; if the app crashes, a guardian process (see below) stops it, so no kernel session is left behind.
param(
    [string[]]$ProcessNames = @('DeadByDaylight-Win64-Shipping', 'DeadByDaylight-WinGDK-Shipping'),
    [ValidateRange(100, 5000)]
    [int]$PollMs = 500,
    [ValidateRange(1, 60)]
    [int]$WindowSecs = 5
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.Encoding]::UTF8

function Log([string]$msg) { [Console]::Error.WriteLine("[ETW-Tracker] $msg") }

# With -File, "a,b" arrives as a single string: split it ourselves.
$ProcessNames = @($ProcessNames | ForEach-Object { $_ -split ',' } | ForEach-Object { $_.Trim() -replace '\.exe$', '' } | Where-Object { $_ })

if (-not [Environment]::Is64BitProcess) {
    Log '64-bit PowerShell is required.'
    exit 1
}

if (-not ([System.Management.Automation.PSTypeName]'DbdEtw.Tracker').Type) {
    try {
        Add-Type -Language CSharp -TypeDefinition @'
using System;
using System.Collections.Generic;
using System.Globalization;
using System.Linq;
using System.Net;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

namespace DbdEtw {

public static class Tracker {
    public const string SessionName = "DBD-Blocker-ETW";

    static readonly Guid KERNEL_NETWORK = new Guid("7dd42a49-5329-4832-8dfd-43d979153a88");
    const ulong KEYWORD_IPV4 = 0x10;
    const ulong KEYWORD_IPV6 = 0x20;
    const byte TRACE_LEVEL_INFORMATION = 4;

    // Microsoft-Windows-Kernel-Network event ids (see Get-WinEvent -ListProvider Microsoft-Windows-Kernel-Network)
    const ushort UDP4_SEND = 42, UDP4_RECV = 43, UDP6_SEND = 58, UDP6_RECV = 59;

    const uint EVENT_TRACE_REAL_TIME_MODE = 0x00000100;
    const uint PROCESS_TRACE_MODE_REAL_TIME = 0x00000100;
    const uint PROCESS_TRACE_MODE_EVENT_RECORD = 0x10000000;
    const uint WNODE_FLAG_TRACED_GUID = 0x00020000;
    const int EVENT_TRACE_CONTROL_STOP = 1;
    const int EVENT_CONTROL_CODE_ENABLE_PROVIDER = 1;
    const int ERROR_WMI_INSTANCE_NOT_FOUND = 4201;
    const long INVALID_PROCESSTRACE_HANDLE = -1;

    // ---- native structures ---------------------------------------------------------------------
    [StructLayout(LayoutKind.Sequential)]
    struct WNODE_HEADER {
        public uint BufferSize; public uint ProviderId; public ulong HistoricalContext; public long TimeStamp;
        public Guid Guid; public uint ClientContext; public uint Flags;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE_PROPERTIES {
        public WNODE_HEADER Wnode;
        public uint BufferSize, MinimumBuffers, MaximumBuffers, MaximumFileSize, LogFileMode, FlushTimer, EnableFlags;
        public int AgeLimit;
        public uint NumberOfBuffers, FreeBuffers, EventsLost, BuffersWritten, LogBuffersLost, RealTimeBuffersLost;
        public IntPtr LoggerThreadId;
        public uint LogFileNameOffset, LoggerNameOffset;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_DESCRIPTOR { public ushort Id; public byte Version, Channel, Level, Opcode; public ushort Task; public ulong Keyword; }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_HEADER {
        public ushort Size, HeaderType, Flags, EventProperty; public uint ThreadId, ProcessId; public long TimeStamp;
        public Guid ProviderId; public EVENT_DESCRIPTOR EventDescriptor; public ulong ProcessorTime; public Guid ActivityId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_RECORD {
        public EVENT_HEADER EventHeader; public uint BufferContext; public ushort ExtendedDataCount, UserDataLength;
        public IntPtr ExtendedData, UserData, UserContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE_HEADER {
        public ushort Size, FieldTypeFlags; public uint Version, ThreadId, ProcessId; public long TimeStamp; public Guid Guid; public ulong ProcessorTime;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE {
        public EVENT_TRACE_HEADER Header; public uint InstanceId, ParentInstanceId; public Guid ParentGuid;
        public IntPtr MofData; public uint MofLength, ClientContext;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct TRACE_LOGFILE_HEADER {
        public uint BufferSize, Version, ProviderVersion, NumberOfProcessors; public long EndTime;
        public uint TimerResolution, MaximumFileSize, LogFileMode, BuffersWritten;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 16)] public byte[] LogInstanceOrData;
        public IntPtr LoggerName, LogFileName;
        [MarshalAs(UnmanagedType.ByValArray, SizeConst = 172)] public byte[] TimeZoneInformation;
        public long BootTime, PerfFreq, StartTime; public uint ReservedFlags, BuffersLost;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct EVENT_TRACE_LOGFILEW {
        public IntPtr LogFileName, LoggerName; public long CurrentTime; public uint BuffersRead, ProcessTraceMode;
        public EVENT_TRACE CurrentEvent; public TRACE_LOGFILE_HEADER LogfileHeader; public IntPtr BufferCallback;
        public uint BufferSize, Filled, EventsLost; public IntPtr EventRecordCallback; public uint IsKernelTrace; public IntPtr Context;
    }

    [UnmanagedFunctionPointer(CallingConvention.StdCall)]
    delegate void EventRecordCallback(IntPtr eventRecord);

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int StartTraceW(out long sessionHandle, string sessionName, IntPtr properties);
    [DllImport("advapi32.dll")] static extern int EnableTraceEx2(long sessionHandle, ref Guid providerId, int controlCode, byte level, ulong matchAnyKeyword, ulong matchAllKeyword, int timeout, IntPtr enableParameters);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)] static extern long OpenTraceW(IntPtr logfile);
    [DllImport("advapi32.dll")] static extern int ProcessTrace([In] long[] handleArray, int handleCount, IntPtr startTime, IntPtr endTime);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode)] static extern int ControlTraceW(long sessionHandle, string sessionName, IntPtr properties, int controlCode);
    [DllImport("advapi32.dll")] static extern int CloseTrace(long traceHandle);

    // ---- endpoint aggregation ------------------------------------------------------------------
    sealed class Endpoint {
        public string Ip; public int Port; public bool V6;
        public long FirstSeen, LastSeen, Packets, Bytes;
        public long[] Buckets = new long[64];   // packets per 1s bucket (rolling)
        public long BucketBase;
    }

    static readonly object Gate = new object();
    static readonly Dictionary<string, Endpoint> Endpoints = new Dictionary<string, Endpoint>();
    static readonly HashSet<int> LocalPorts = new HashSet<int>();
    static volatile int _pid;
    static long _events, _matched;

    static long _sessionHandle;
    static long _traceHandle = INVALID_PROCESSTRACE_HANDLE;
    static Thread _consumer;
    static EventRecordCallback _callback;   // keep the delegate alive while ETW holds the pointer
    static IntPtr _loggerName = IntPtr.Zero;
    static volatile bool _stopRequested;

    public static bool StopRequested { get { return _stopRequested; } }
    public static bool Running { get { return _traceHandle != INVALID_PROCESSTRACE_HANDLE; } }
    public static long EventCount { get { return Interlocked.Read(ref _events); } }
    public static long MatchedCount { get { return Interlocked.Read(ref _matched); } }

    static long NowMs() { return DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(); }
    static int Port(ushort networkOrder) { return ((networkOrder & 0xFF) << 8) | (networkOrder >> 8); }

    static bool IsPublicV4(byte[] b) {
        if (b[0] == 0 || b[0] == 10 || b[0] == 127) return false;
        if (b[0] == 100 && b[1] >= 64 && b[1] <= 127) return false;    // CGNAT
        if (b[0] == 169 && b[1] == 254) return false;
        if (b[0] == 172 && b[1] >= 16 && b[1] <= 31) return false;
        if (b[0] == 192 && b[1] == 168) return false;
        if (b[0] >= 224) return false;                                  // multicast / reserved
        return true;
    }

    static bool IsPublicV6(byte[] b) {
        if ((b[0] & 0xE0) != 0x20) return false;                        // only 2000::/3 is global unicast
        return true;
    }

    static bool IsIgnoredPort(int port) {
        return port == 53 || port == 123 || port == 443 || port == 80 || port == 3478 || port == 3479 || port == 5353 || port == 1900;
    }

    static void OnEvent(IntPtr recordPtr) {
        try {
            Interlocked.Increment(ref _events);
            var rec = (EVENT_RECORD)Marshal.PtrToStructure(recordPtr, typeof(EVENT_RECORD));
            ushort id = rec.EventHeader.EventDescriptor.Id;
            bool v4 = id == UDP4_SEND || id == UDP4_RECV;
            bool v6 = id == UDP6_SEND || id == UDP6_RECV;
            if (!v4 && !v6) return;
            int addrLen = v4 ? 4 : 16;
            int minLen = 8 + addrLen * 2 + 4;
            if (rec.UserData == IntPtr.Zero || rec.UserDataLength < minLen) return;

            int pid = Marshal.ReadInt32(rec.UserData, 0);
            int filter = _pid;
            if (filter == 0 || pid != filter) return;

            int size = Marshal.ReadInt32(rec.UserData, 4);
            byte[] daddr = new byte[addrLen], saddr = new byte[addrLen];
            Marshal.Copy(IntPtr.Add(rec.UserData, 8), daddr, 0, addrLen);
            Marshal.Copy(IntPtr.Add(rec.UserData, 8 + addrLen), saddr, 0, addrLen);
            int dport = Port((ushort)Marshal.ReadInt16(rec.UserData, 8 + addrLen * 2));
            int sport = Port((ushort)Marshal.ReadInt16(rec.UserData, 8 + addrLen * 2 + 2));

            // "transmitted from saddr:sport to daddr:dport" / "received from saddr:sport to daddr:dport"
            bool recv = id == UDP4_RECV || id == UDP6_RECV;
            byte[] remote = recv ? saddr : daddr;
            int remotePort = recv ? sport : dport;
            int localPort = recv ? dport : sport;

            if (v4 ? !IsPublicV4(remote) : !IsPublicV6(remote)) return;
            if (IsIgnoredPort(remotePort)) return;

            string ip = new IPAddress(remote).ToString();
            string key = (v6 ? "[" + ip + "]" : ip) + ":" + remotePort;
            long now = NowMs();
            long sec = now / 1000;
            lock (Gate) {
                Endpoint e;
                if (!Endpoints.TryGetValue(key, out e)) {
                    e = new Endpoint { Ip = ip, Port = remotePort, V6 = v6, FirstSeen = now, BucketBase = sec };
                    Endpoints[key] = e;
                }
                Advance(e, sec);
                e.Buckets[sec % e.Buckets.Length]++;
                e.LastSeen = now;
                e.Packets++;
                e.Bytes += size;
                if (localPort > 0 && LocalPorts.Count < 64) LocalPorts.Add(localPort);
            }
            Interlocked.Increment(ref _matched);
        } catch {
            // never let an exception escape into the ETW callback
        }
    }

    static void Advance(Endpoint e, long sec) {
        if (sec <= e.BucketBase) return;
        long gap = Math.Min(sec - e.BucketBase, e.Buckets.Length);
        for (long i = 1; i <= gap; i++) e.Buckets[(e.BucketBase + i) % e.Buckets.Length] = 0;
        e.BucketBase = sec;
    }

    static long PacketsInWindow(Endpoint e, long sec, int windowSecs) {
        Advance(e, sec);
        long total = 0;
        for (int i = 0; i < windowSecs && i < e.Buckets.Length; i++) total += e.Buckets[(sec - i + e.Buckets.Length * 4) % e.Buckets.Length];
        return total;
    }

    public static void SetPid(int pid) {
        if (pid == _pid) return;
        _pid = pid;
        Reset();
    }

    public static void Reset() {
        lock (Gate) { Endpoints.Clear(); LocalPorts.Clear(); }
    }

    // Serializes the current state. Scoring: 70% share of packets in the window, 30% recency.
    public static string Snapshot(int windowSecs, bool exitlag) {
        long now = NowMs();
        long sec = now / 1000;
        long windowMs = windowSecs * 1000L;
        var rows = new List<KeyValuePair<Endpoint, long>>();
        int[] ports;
        lock (Gate) {
            foreach (var key in Endpoints.Keys.ToList()) {
                var e = Endpoints[key];
                if (now - e.LastSeen > windowMs) { Endpoints.Remove(key); continue; }
                rows.Add(new KeyValuePair<Endpoint, long>(e, PacketsInWindow(e, sec, windowSecs)));
            }
            ports = LocalPorts.OrderBy(p => p).ToArray();
            LocalPorts.Clear();
        }

        long max = 1;
        foreach (var r in rows) if (r.Value > max) max = r.Value;
        var scored = rows.Select(r => {
            double freq = (double)r.Value / max;
            double recency = Math.Max(0.0, 1.0 - (double)(now - r.Key.LastSeen) / windowMs);
            return new { E = r.Key, Count = r.Value, Score = Math.Round(Math.Min(1.0, freq * 0.7 + recency * 0.3), 4) };
        }).OrderByDescending(x => x.Score).ThenByDescending(x => x.Count).Take(20).ToList();

        var inv = CultureInfo.InvariantCulture;
        var sb = new StringBuilder(512);
        sb.Append("{\"dbdRunning\":true,\"dbdPid\":").Append(_pid);
        if (scored.Count > 0) {
            var top = scored[0];
            double confidence = scored.Count == 1 ? top.Score : Math.Min(1.0, top.Score + (top.Score - scored[1].Score) * 0.5);
            sb.Append(",\"current_server\":\"").Append(top.E.V6 ? "[" + top.E.Ip + "]" : top.E.Ip).Append(':').Append(top.E.Port).Append('"');
            sb.Append(",\"currentIp\":\"").Append(top.E.Ip).Append('"');
            sb.Append(",\"confidence\":").Append(Math.Round(confidence, 4).ToString(inv));
        } else {
            sb.Append(",\"current_server\":null,\"currentIp\":null,\"confidence\":0");
        }
        sb.Append(",\"candidates\":[");
        for (int i = 0; i < scored.Count; i++) {
            var s = scored[i];
            if (i > 0) sb.Append(',');
            sb.Append("{\"ip\":\"").Append(s.E.Ip).Append("\",\"port\":").Append(s.E.Port)
              .Append(",\"score\":").Append(s.Score.ToString(inv))
              .Append(",\"lastSeen\":").Append(s.E.LastSeen)
              .Append(",\"count\":").Append(s.Count)
              .Append(",\"bytes\":").Append(s.E.Bytes)
              .Append(",\"v6\":").Append(s.E.V6 ? "true" : "false").Append('}');
        }
        sb.Append("],\"udpPorts\":[").Append(string.Join(",", ports)).Append(']');
        sb.Append(",\"exitlagRunning\":").Append(exitlag ? "true" : "false");
        sb.Append(",\"t\":").Append(now).Append('}');
        return sb.ToString();
    }

    // ---- session management --------------------------------------------------------------------
    static IntPtr AllocProperties() {
        int propsSize = Marshal.SizeOf(typeof(EVENT_TRACE_PROPERTIES));
        byte[] name = Encoding.Unicode.GetBytes(SessionName + "\0");
        int total = propsSize + name.Length;
        IntPtr buffer = Marshal.AllocHGlobal(total);
        for (int i = 0; i < total; i++) Marshal.WriteByte(buffer, i, 0);
        var props = new EVENT_TRACE_PROPERTIES();
        props.Wnode.BufferSize = (uint)total;
        props.Wnode.Flags = WNODE_FLAG_TRACED_GUID;
        props.Wnode.ClientContext = 1;          // QPC timestamps
        props.BufferSize = 64;                  // KB
        props.MinimumBuffers = 4;
        props.MaximumBuffers = 32;
        props.LogFileMode = EVENT_TRACE_REAL_TIME_MODE;
        props.FlushTimer = 1;
        props.LoggerNameOffset = (uint)propsSize;
        Marshal.StructureToPtr(props, buffer, false);
        Marshal.Copy(name, 0, IntPtr.Add(buffer, propsSize), name.Length);
        return buffer;
    }

    // Stops the named session whoever created it (previous crashed run included). Returns true if one was running.
    public static bool StopSession() {
        IntPtr props = AllocProperties();
        try { return ControlTraceW(0, SessionName, props, EVENT_TRACE_CONTROL_STOP) == 0; }
        finally { Marshal.FreeHGlobal(props); }
    }

    public static string Start(int pid) {
        if (Running) { SetPid(pid); return "ok"; }
        _pid = pid;
        Reset();
        StopSession();

        IntPtr props = AllocProperties();
        long session;
        int err;
        try { err = StartTraceW(out session, SessionName, props); }
        finally { Marshal.FreeHGlobal(props); }
        if (err != 0) return "StartTrace failed (" + err + ")";
        _sessionHandle = session;

        Guid provider = KERNEL_NETWORK;
        err = EnableTraceEx2(session, ref provider, EVENT_CONTROL_CODE_ENABLE_PROVIDER, TRACE_LEVEL_INFORMATION, KEYWORD_IPV4 | KEYWORD_IPV6, 0, 0, IntPtr.Zero);
        if (err != 0) { StopSession(); return "EnableTraceEx2 failed (" + err + ")"; }

        var logfile = new EVENT_TRACE_LOGFILEW();
        logfile.LogfileHeader.LogInstanceOrData = new byte[16];
        logfile.LogfileHeader.TimeZoneInformation = new byte[172];
        _loggerName = Marshal.StringToHGlobalUni(SessionName);
        logfile.LoggerName = _loggerName;
        logfile.ProcessTraceMode = PROCESS_TRACE_MODE_REAL_TIME | PROCESS_TRACE_MODE_EVENT_RECORD;
        _callback = new EventRecordCallback(OnEvent);
        logfile.EventRecordCallback = Marshal.GetFunctionPointerForDelegate(_callback);

        int size = Marshal.SizeOf(typeof(EVENT_TRACE_LOGFILEW));
        IntPtr logfilePtr = Marshal.AllocHGlobal(size);
        long handle;
        try {
            Marshal.StructureToPtr(logfile, logfilePtr, false);
            handle = OpenTraceW(logfilePtr);
        } finally {
            Marshal.FreeHGlobal(logfilePtr);
        }
        if (handle == INVALID_PROCESSTRACE_HANDLE) {
            int last = Marshal.GetLastWin32Error();
            StopSession();
            FreeLoggerName();
            return "OpenTrace failed (" + last + ")";
        }

        _traceHandle = handle;
        _consumer = new Thread(() => { ProcessTrace(new long[] { handle }, 1, IntPtr.Zero, IntPtr.Zero); });
        _consumer.IsBackground = true;
        _consumer.Name = "DBD-ETW-Consumer";
        _consumer.Start();
        return "ok";
    }

    static readonly object StopGate = new object();

    public static void Stop() {
        lock (StopGate) {
            // Stopping the session first makes ProcessTrace return; then release the consumer handle.
            StopSession();
            if (_traceHandle != INVALID_PROCESSTRACE_HANDLE) {
                CloseTrace(_traceHandle);
                _traceHandle = INVALID_PROCESSTRACE_HANDLE;
            }
            if (_consumer != null && _consumer.IsAlive) _consumer.Join(3000);
            _consumer = null;
            FreeLoggerName();
            Reset();
        }
    }

    static void FreeLoggerName() {
        if (_loggerName != IntPtr.Zero) { Marshal.FreeHGlobal(_loggerName); _loggerName = IntPtr.Zero; }
    }

    // Watches stdin: "stop" or EOF requests a clean shutdown.
    public static void WatchStdin() {
        var t = new Thread(() => {
            try {
                string line;
                while ((line = Console.In.ReadLine()) != null) {
                    if (line.Trim().Equals("stop", StringComparison.OrdinalIgnoreCase)) break;
                }
            } catch { }
            _stopRequested = true;
        });
        t.IsBackground = true;
        t.Name = "DBD-ETW-Stdin";
        t.Start();
        AppDomain.CurrentDomain.ProcessExit += (s, e) => { try { Stop(); } catch { } };
    }
}

}
'@
    } catch {
        Log "C# compile error: $_"
        exit 1
    }
}

function Get-DbdPid {
    foreach ($name in $ProcessNames) {
        $p = Get-Process -Name $name -ErrorAction SilentlyContinue | Select-Object -First 1
        if ($p) { return [int]$p.Id }
    }
    return 0
}

function Test-ExitLag {
    return $null -ne (Get-Process -Name 'ExitLag' -ErrorAction SilentlyContinue | Select-Object -First 1)
}

function Emit([string]$line) {
    [Console]::Out.WriteLine($line)
    [Console]::Out.Flush()
}

[DbdEtw.Tracker]::WatchStdin()

# Guardian: Node/Electron put their children in a KILL_ON_JOB_CLOSE job, so if the app crashes this process
# is terminated without running any cleanup and the kernel ETW session would outlive it. Grandchildren
# silently break away from that job: this tiny watcher waits for the tracker to end (for any reason) and
# stops the session. It lives exactly as long as the tracker.
try {
    $logman = Join-Path $env:SystemRoot 'System32\logman.exe'
    $guard = "Wait-Process -Id $PID -ErrorAction SilentlyContinue; & '$logman' stop $([DbdEtw.Tracker]::SessionName) -ets *> `$null"
    $psi = New-Object System.Diagnostics.ProcessStartInfo
    $psi.FileName = Join-Path $env:SystemRoot 'System32\WindowsPowerShell\v1.0\powershell.exe'
    $psi.Arguments = '-NoLogo -NoProfile -NonInteractive -EncodedCommand ' + [Convert]::ToBase64String([System.Text.Encoding]::Unicode.GetBytes($guard))
    $psi.UseShellExecute = $false
    $psi.CreateNoWindow = $true
    $psi.RedirectStandardInput = $true
    $psi.RedirectStandardOutput = $true
    $psi.RedirectStandardError = $true
    [void][System.Diagnostics.Process]::Start($psi)
} catch {
    Log "Guardian not started: $($_.Exception.Message)"
}
Log ("Started (poll={0}ms, window={1}s, processes={2})" -f $PollMs, $WindowSecs, ($ProcessNames -join ','))

$lastPid = 0
$lastPidCheck = 0
$cachedPid = 0
$exitlag = $false
$tick = 0

try {
    while (-not [DbdEtw.Tracker]::StopRequested) {
        $now = [DateTimeOffset]::UtcNow.ToUnixTimeMilliseconds()
        $tick++

        if (($now - $lastPidCheck) -ge 2000) {
            $cachedPid = Get-DbdPid
            $exitlag = Test-ExitLag
            $lastPidCheck = $now
        }

        if ($cachedPid -ne $lastPid) {
            if ($cachedPid -eq 0) {
                Log 'Dead by Daylight closed - stopping ETW session'
                [DbdEtw.Tracker]::Stop()
            } else {
                Log "Dead by Daylight detected (PID $cachedPid)"
                $res = [DbdEtw.Tracker]::Start($cachedPid)
                if ($res -eq 'ok') { Log 'ETW session running' } else { Log "ETW start failed: $res" }
            }
            $lastPid = $cachedPid
        }

        if ($cachedPid -eq 0) {
            Emit ('{{"dbdRunning":false,"dbdPid":0,"current_server":null,"currentIp":null,"confidence":0,"candidates":[],"udpPorts":[],"exitlagRunning":{0},"t":{1}}}' -f $exitlag.ToString().ToLowerInvariant(), $now)
        } else {
            Emit ([DbdEtw.Tracker]::Snapshot($WindowSecs, $exitlag))
            if ($tick % 40 -eq 0) {
                Log ("events={0} matched={1}" -f [DbdEtw.Tracker]::EventCount, [DbdEtw.Tracker]::MatchedCount)
            }
        }

        Start-Sleep -Milliseconds $PollMs
    }
    Log 'Stop requested'
} finally {
    [DbdEtw.Tracker]::Stop()
    Log 'Stopped'
}
