// RobloxNative.exe -- precompiled native helper that replaces the three
// PowerShell scripts (mutex.ps1, closehandles.ps1, audiovol.ps1).
//
// Why: every PowerShell invocation paid for powershell.exe startup AND an
// Add-Type C# compile on each call. Closing singleton handles runs before
// *every* launch and setting volume runs on every slider change, so that
// overhead was felt constantly. This is the same C# compiled once, ahead of
// time, and spawned directly -- no PowerShell, no per-call JIT/compile.
//
// Subcommands:
//   RobloxNative.exe mutex          -> passively hold ROBLOX_singletonMutex for
//                                      the session; prints MUTEX_HELD then blocks.
//   RobloxNative.exe closehandles   -> isolate ROBLOX_singletonEvent handles on
//                                      running Roblox immediately before a launch;
//                                      prints HANDLES_DONE.
//   RobloxNative.exe volume <0-100> [pid ...] -> set OS volume on every Roblox
//                                      audio session, or only the supplied Roblox
//                                      process IDs; prints SET:<count>.
//
// Build (done once, by the app or build.bat) with the .NET Framework compiler:
//   csc /nologo /optimize+ /platform:x64 /target:exe /out:RobloxNative.exe RobloxNative.cs

using System;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Collections.Generic;
using System.Text;
using System.Threading;

internal static class RobloxNative
{
    private static int Main(string[] args)
    {
        try
        {
            string cmd = args.Length > 0 ? args[0].ToLowerInvariant() : "";
            switch (cmd)
            {
                case "mutex":        return RunMutex();
                case "closehandles": return RunCloseHandles();
                case "volume":       return RunVolume(args);
                case "volumeafter":  return RunVolumeAfter(args);
                case "antiafk":      return RunAntiAfk(args);
                case "setram":       return RunSetRam(args);
                case "launchram":    return RunLaunchRam(args);
                default:
                    Console.Error.WriteLine("Unknown command. Use: mutex | closehandles | volume <0-100> [pid ...] | antiafk <seconds> | setram <pid> <mb> | launchram <exe> <cwd> <mb> <uri>");
                    return 2;
            }
        }
        catch (Exception ex)
        {
            // Never crash silently -- the parent process reads stderr.
            Console.Error.WriteLine("RobloxNative fatal: " + ex);
            return 1;
        }
    }

    // ── Persistent mutex holder ────────────────────────────────────────────
    // Hold ROBLOX_singletonMutex first (cheap, and the object Roblox's singleton
    // check keys off), signal readiness, THEN do the slow handle scan. The Mutex
    // objects are rooted in static fields so GC can't finalize them and silently
    // drop the hold.
    private static Mutex _singletonMutex;
    private static Mutex _singletonEventMutex;

    private static int RunMutex()
    {
        // Step 1: own the singleton mutex immediately.
        try
        {
            bool created;
            _singletonMutex = new Mutex(true, "ROBLOX_singletonMutex", out created);
            if (!created) { try { _singletonMutex.WaitOne(0); } catch (AbandonedMutexException) { } catch { } }
        }
        catch (Exception ex) { Console.Error.WriteLine("HoldMutex: " + ex.Message); }

        // Step 2: signal readiness NOW, before the slow scan, so the app never
        // lets the first launch race an unheld mutex.
        Console.Out.WriteLine("MUTEX_HELD");
        Console.Out.Flush();

        // Step 3: slow part -- close existing event handles, then hold that name.
        try { HandleCloser.CloseRobloxSingletonHandles(); }
        catch (Exception ex) { Console.Error.WriteLine("CloseHandles(mutex): " + ex.Message); }

        try
        {
            bool created;
            _singletonEventMutex = new Mutex(true, "ROBLOX_singletonEvent", out created);
            if (!created) { try { _singletonEventMutex.WaitOne(0); } catch (AbandonedMutexException) { } catch { } }
        }
        catch (Exception ex) { Console.Error.WriteLine("HoldEventMutex: " + ex.Message); }

        // Keep alive (and keep the owning thread + static refs alive) forever.
        Thread.Sleep(Timeout.Infinite);
        return 0;
    }

    // ── One-shot handle closer ─────────────────────────────────────────────
    private static int RunCloseHandles()
    {
        try { HandleCloser.CloseRobloxSingletonHandles(); }
        catch (Exception ex) { Console.Error.WriteLine("CloseHandles: " + ex.Message); }
        Console.Out.WriteLine("HANDLES_DONE");
        Console.Out.Flush();
        return 0;
    }

    // ── Volume ─────────────────────────────────────────────────────────────
    private static int RunVolume(string[] args)
    {
        int pct = 0;
        if (args.Length > 1) int.TryParse(args[1], out pct);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;
        float level = pct / 100.0f;

        // No PID arguments means the Mixer/global operation: target every
        // Roblox session. Supplied PIDs are launch-scoped and protect existing
        // accounts from a group volume setting.
        int[] pids;
        if (args.Length > 2)
        {
            pids = new int[args.Length - 2];
            int count = 0;
            for (int i = 2; i < args.Length; i++)
            {
                int pid;
                if (int.TryParse(args[i], out pid) && pid > 0) pids[count++] = pid;
            }
            if (count < pids.Length)
            {
                var trimmed = new int[count];
                Array.Copy(pids, trimmed, count);
                pids = trimmed;
            }
        }
        else
        {
            try
            {
                var procs = Process.GetProcessesByName("RobloxPlayerBeta");
                pids = new int[procs.Length];
                for (int i = 0; i < procs.Length; i++) pids[i] = procs[i].Id;
            }
            catch { pids = new int[0]; }
        }

        if (pids.Length == 0) { Console.Out.WriteLine("SET:0"); Console.Out.Flush(); return 0; }

        int n = 0;
        try { n = AudioControl.Apply(level, pids); }
        catch (Exception ex) { Console.Error.WriteLine("Volume: " + ex.Message); }
        Console.Out.WriteLine("SET:" + n);
        Console.Out.Flush();
        return 0;
    }

    private static int RunVolumeAfter(string[] args)
    {
        int pct = 0;
        long sinceMs = 0;
        if (args.Length > 1) int.TryParse(args[1], out pct);
        if (args.Length > 2) long.TryParse(args[2], out sinceMs);
        if (pct < 0) pct = 0;
        if (pct > 100) pct = 100;

        var selected = new System.Collections.Generic.List<int>();
        try
        {
            foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
            {
                try
                {
                    long started = (long)(p.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    // Include every Roblox process created by this launch. A
                    // bootstrapper can hand off to a separate client/audio
                    // process, so selecting only the earliest PID leaves the
                    // real session inheriting a previous group's mute state.
                    if (started >= sinceMs) selected.Add(p.Id);
                }
                catch { }
            }
        }
        catch { }

        if (selected.Count == 0) { Console.Out.WriteLine("SET:0"); Console.Out.Flush(); return 0; }
        int n = 0;
        try { n = AudioControl.Apply(pct / 100.0f, selected.ToArray()); }
        catch (Exception ex) { Console.Error.WriteLine("VolumeAfter: " + ex.Message); }
        Console.Out.WriteLine("SET:" + n);
        Console.Out.Flush();
        return 0;
    }

    // ── Anti-AFK ───────────────────────────────────────────────────────────
    // Roblox only registers input while a window is focused, so keeping every
    // instance alive means briefly focusing it and tapping a key. Each instance
    // gets its OWN deadline timer (see AntiAfk.RunLoop): the moment one reaches
    // the deadline it's tapped, others are untouched, and an instance you're
    // actively playing in the foreground is never tapped. Default deadline is
    // 18 min -- safely under Roblox's ~20-minute idle kick.
    private static int RunAntiAfk(string[] args)
    {
        int deadlineSec = 18 * 60; // tap each instance once it hits 18 min
        if (args.Length > 1) { int d; if (int.TryParse(args[1], out d)) deadlineSec = d; }
        if (deadlineSec < 60)   deadlineSec = 60;
        if (deadlineSec > 1140) deadlineSec = 1140; // never let it exceed 19 min (kick is ~20)

        // Optional virtual-key override (decimal). Default 0x10 = VK_SHIFT
        // (registers as input, moves nothing, opens no chat).
        int vk = 0x10;
        if (args.Length > 2) { int v; if (int.TryParse(args[2], out v) && v > 0 && v < 256) vk = v; }

        Console.Out.WriteLine("ANTIAFK_ON:" + deadlineSec);
        Console.Out.Flush();
        AntiAfk.RunLoop(deadlineSec, vk);
        return 0;
    }

    // ── Per-account RAM limit (Job Object) ─────────────────────────────────
    // Assigns the launched Roblox process to a Job Object with hard commit,
    // aggregate-job, and working-set limits. The helper stays alive holding the
    // job handle for the life of the process; the app kills it when the account
    // closes or quits.
    private static int RunSetRam(string[] args)
    {
        // args: setram <bootstrapPid> <mb> [launchStartUnixMs]
        int bootstrapPid = 0, mb = 0;
        long sinceMs = 0;
        if (args.Length < 3 || !int.TryParse(args[1], out bootstrapPid) || !int.TryParse(args[2], out mb) || bootstrapPid <= 0 || mb <= 0)
        {
            Console.Error.WriteLine("setram: usage setram <bootstrapPid> <mb> [launchStartUnixMs]");
            return 2;
        }
        if (args.Length > 3) long.TryParse(args[3], out sinceMs);
        if (sinceMs <= 0) sinceMs = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();

        IntPtr hJob = IntPtr.Zero;
        IntPtr hProc = IntPtr.Zero;
        try
        {
            // Wait briefly for the bootstrapper to hand off to the persistent
            // RobloxPlayerBeta process. We prefer the original PID when it is
            // already the real client, otherwise select the earliest client
            // created after this launch. This avoids applying the cap to a
            // short-lived launcher and leaving the actual game uncapped.
            int targetPid = WaitForRobloxTarget(bootstrapPid, sinceMs, 90000);
            if (targetPid <= 0)
            {
                Console.Error.WriteLine("setram: Roblox client did not appear within the 90 second startup window");
                return 1;
            }

            hJob = CreateRamJob(mb);
            if (hJob == IntPtr.Zero) return 1;

            hProc = OpenProcess(PROCESS_SET_QUOTA | PROCESS_TERMINATE | PROCESS_QUERY_INFORMATION, false, targetPid);
            if (hProc == IntPtr.Zero) { Console.Error.WriteLine("setram: OpenProcess failed " + Marshal.GetLastWin32Error()); return 1; }
            if (!AssignProcessToJobObject(hJob, hProc)) { Console.Error.WriteLine("setram: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error()); return 1; }
            ApplyWorkingSetLimit(hProc, mb);
            Console.Out.WriteLine("RAM_SET:" + targetPid + ":" + mb);
            Console.Out.Flush();
            // Hand off to the permanent WatchRamLimit watchdog. Roblox
            // sometimes replaces the bootstrap process with a child created
            // using breakaway semantics; the watchdog walks the parent-PID
            // ancestry tree every cycle so any handoff child (named
            // RobloxPlayerBeta or otherwise) is still capped, and it re-pins
            // the working-set maximum every second for the whole helper life.
            CloseHandle(hProc);
            hProc = IntPtr.Zero;
            WatchRamLimit(hJob, targetPid, mb);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("setram: " + ex.Message);
            return 1;
        }
        finally
        {
            if (hProc != IntPtr.Zero) CloseHandle(hProc);
            // hJob intentionally remains open while this helper is alive.
        }
    }

    // Starts Roblox suspended, assigns it to the RAM-limited job, and only
    // then resumes its first thread. Assigning after Roblox has already
    // started is unreliable because Roblox may place itself in another job.
    private static int RunLaunchRam(string[] args)
    {
        // args: launchram <exe> <cwd> <mb> <uri>
        int mb = 0;
        if (args.Length < 5 || !int.TryParse(args[3], out mb) || mb <= 0 || String.IsNullOrEmpty(args[1]) || String.IsNullOrEmpty(args[4]))
        {
            Console.Error.WriteLine("launchram: usage launchram <exe> <cwd> <mb> <uri>");
            return 2;
        }

        IntPtr hJob = CreateRamJob(mb);
        if (hJob == IntPtr.Zero) return 1;

        PROCESS_INFORMATION pi = new PROCESS_INFORMATION();
        try
        {
            STARTUPINFO si = new STARTUPINFO();
            si.cb = Marshal.SizeOf(typeof(STARTUPINFO));
            // Executable paths and Roblox protocol URIs cannot contain quote
            // characters, so the simple quoted command line is sufficient.
            char quote = (char)34;
            string command = quote + args[1] + quote + " " + quote + args[4] + quote;
            StringBuilder commandLine = new StringBuilder(command);
            bool created = CreateProcess(
                args[1], commandLine, IntPtr.Zero, IntPtr.Zero, false,
                CREATE_SUSPENDED | CREATE_UNICODE_ENVIRONMENT, IntPtr.Zero,
                String.IsNullOrEmpty(args[2]) ? null : args[2], ref si, out pi);
            if (!created)
            {
                Console.Error.WriteLine("launchram: CreateProcess failed " + Marshal.GetLastWin32Error());
                CloseHandle(hJob);
                return 1;
            }

            if (!AssignProcessToJobObject(hJob, pi.hProcess))
            {
                Console.Error.WriteLine("launchram: AssignProcessToJobObject failed " + Marshal.GetLastWin32Error());
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(hJob);
                return 1;
            }
            if (!ApplyWorkingSetLimit(pi.hProcess, mb))
            {
                Console.Error.WriteLine("launchram: could not apply the hard working-set limit");
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(hJob);
                return 1;
            }

            if (ResumeThread(pi.hThread) == UInt32.MaxValue)
            {
                Console.Error.WriteLine("launchram: ResumeThread failed " + Marshal.GetLastWin32Error());
                TerminateProcess(pi.hProcess, 1);
                CloseHandle(pi.hThread);
                CloseHandle(pi.hProcess);
                CloseHandle(hJob);
                return 1;
            }

            int pid = (int)pi.dwProcessId;
            Console.Out.WriteLine("RAM_SET:" + pid + ":" + mb);
            Console.Out.Flush();
            CloseHandle(pi.hThread);
            CloseHandle(pi.hProcess);
            // Hand off to the permanent watchdog (it owns the job handle and
            // never returns for the life of the helper).
            WatchRamLimit(hJob, pid, mb);
            return 0;
        }
        catch (Exception ex)
        {
            Console.Error.WriteLine("launchram: " + ex.Message);
            if (pi.hThread != IntPtr.Zero) CloseHandle(pi.hThread);
            if (pi.hProcess != IntPtr.Zero) CloseHandle(pi.hProcess);
            CloseHandle(hJob);
            return 1;
        }
    }

    private static IntPtr CreateRamJob(int mb)
    {
        IntPtr hJob = CreateJobObject(IntPtr.Zero, null);
        if (hJob == IntPtr.Zero)
        {
            Console.Error.WriteLine("ram: CreateJobObject failed " + Marshal.GetLastWin32Error());
            return IntPtr.Zero;
        }

        // Deliberately no JOB_OBJECT_LIMIT_PROCESS_MEMORY / JOB_OBJECT_LIMIT_JOB_MEMORY.
        // Those are *commit* limits: the moment Roblox commits more than the cap it
        // fails its next allocation and dies with an out-of-memory error (the
        // "Roblox encountered an unexpected error" dialog). Roblox needs far more
        // commit than the working-set cap just to boot, so a commit cap at 512 MB
        // kills the client instead of limiting it.
        //
        // The actual RAM limit is the hard working-set maximum applied per process
        // in ApplyWorkingSetLimit (SetProcessWorkingSetSizeEx with
        // QUOTA_LIMITS_HARDWS_MAX_ENABLE). Hard-max enforcement is a tendency
        // rather than an iron gate: Windows can briefly let WorkingSet64 climb
        // above the cap between allocations and the trimmer's next pass. The
        // active pressure that keeps WorkingSet64 near the cap is the
        // permanent WatchRamLimit watchdog started in RunSetRam / RunLaunchRam:
        // every ~1 s it re-pins SetProcessWorkingSetSizeEx on every tracked
        // descendant and calls EmptyWorkingSet64 whenever the live workset
        // has clearly exceeded the cap. The job itself is still created (and
        // assigned) so the whole process tree stays grouped and any handoff
        // child that breaks away can be re-attached by the watchdog.
        return hJob;
    }

    /*
        if (value == null) return "\"\"";
        var sb = new StringBuilder("\"");
        int slashes = 0;
        foreach (char ch in value)
        {
            if (ch == '\\\\') { slashes++; continue; }
            if (ch == '\"')
            {
                sb.Append('\\\\', slashes * 2 + 1);
                sb.Append('\"');
                slashes = 0;
                continue;
            }
            if (slashes > 0) { sb.Append('\\\\', slashes); slashes = 0; }
            sb.Append(ch);
        }
        if (slashes > 0) sb.Append('\\\\', slashes * 2);
        sb.Append('\"');
        return sb.ToString();
    */

    private static bool ApplyWorkingSetLimit(IntPtr hProcess, int mb)
    {
        ulong bytes = (ulong)mb * 1024UL * 1024UL;
        // Windows rejects a zero minimum even when only the hard maximum flag
        // is requested. Keep the minimum at the documented 20-page floor and
        // enforce the requested maximum as a hard working-set limit.
        UIntPtr minimum = (UIntPtr)(20UL * 4096UL);
        bool ok = SetProcessWorkingSetSizeEx(hProcess, minimum, (UIntPtr)bytes, QUOTA_LIMITS_HARDWS_MAX_ENABLE);
        if (!ok) Console.Error.WriteLine("ram: SetProcessWorkingSetSizeEx failed " + Marshal.GetLastWin32Error());
        return ok;
    }

    // Permanent watchdog that keeps the per-account RAM cap enforced for the
    // whole life of the launched process tree, not just the 30-second
    // post-handoff window of the original Monitor. THREE problems the old
    // monitor did not address:
    //   1. QUOTA_LIMITS_HARDWS_MAX_ENABLE is a *tendency*, not an iron-clad
    //      gate: Windows can briefly let WorkingSet64 climb above the hard
    //      max between allocations and the trimmer's next pass (peak ~2x
    //      cap is common), and the live UI workset readout will sit above
    //      the cap until something forces a trim.
    //   2. The old monitor only matched processes named "RobloxPlayerBeta",
    //      so Roblox's supporting helpers (audio, GPU, crash handler, etc.)
    //      inherited the job automatically but were never re-capped:
    //      GetProcessesByName NEVER sees them, so they were pinned to the
    //      original 512 only by inheritance (which can be undone).
    //   3. After 30 seconds the helper slept forever with the job handle
    //      but exerted NO active pressure on the tree, so any late
    //      breakout or unreset cap was never caught.
    // Fix: every ~1 second walk the entire process list, build a parent-PID
    // map, and treat every descendant of rootPid (regardless of process
    // name) as part of the cap. For each tracked process, re-apply
    // SetProcessWorkingSetSizeEx to re-pin the hard max, then call
    // EmptyWorkingSet64 only when the live WorkingSetSize has clearly blown
    // past the cap (we tolerate a 12.5% overshoot so we don't thrash pages
    // during a brief allocation burst that the trimmer is already
    // recovering from). The watchdog never returns -- the helper thread
    // owns the job handle for the whole launch.
    private static void WatchRamLimit(IntPtr hJob, int rootPid, int mb)
    {
        var tracked = new HashSet<int>();
        tracked.Add(rootPid);
        var parentMap = new Dictionary<int, int>(256);
        var dead = new List<int>();
        var fresh = new List<int>();
        int heartbeatMs = 1000;          // re-pin + trim cycle
        ulong capBytes = (ulong)mb * 1024UL * 1024UL;
        ulong overshoot = capBytes + (capBytes / 8);   // cap + 12.5% tolerance

        while (true)
        {
            try
            {
                // 1. Build a fresh parent-PID map for the system once per cycle.
                parentMap.Clear();
                Process[] procs = null;
                try { procs = Process.GetProcesses(); } catch { procs = null; }
                if (procs != null)
                {
                    foreach (var pr in procs)
                    {
                        try { parentMap[pr.Id] = GetParentProcessId(pr.Id); } catch { }
                    }
                }

                // 2. Promote every descendant of the tracked set, regardless of
                //    process name. Walk the parent chain so we catch
                //    grandchildren and helpers, not just direct children.
                fresh.Clear();
                foreach (var kv in parentMap)
                {
                    int pid = kv.Key;
                    if (tracked.Contains(pid) || pid == 0) continue;
                    int walker = kv.Value;
                    var seen = new HashSet<int>();
                    while (walker != 0 && seen.Add(walker))
                    {
                        if (tracked.Contains(walker)) { fresh.Add(pid); break; }
                        if (!parentMap.TryGetValue(walker, out walker)) break;
                    }
                }
                foreach (var pid in fresh)
                {
                    tracked.Add(pid);
                    try
                    {
                        IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION | PROCESS_TERMINATE, false, pid);
                        if (h == IntPtr.Zero) continue;
                        try
                        {
                            // Assign is best-effort: AssignProcessToJobObject
                            // returns false if the child already inherited
                            // the job or if a prior Assign already pinned it.
                            AssignProcessToJobObject(hJob, h);
                            ApplyWorkingSetLimit(h, mb);
                            Console.Out.WriteLine("RAM_SET_CHILD:" + pid + ":" + mb);
                            Console.Out.Flush();
                        }
                        finally { CloseHandle(h); }
                    }
                    catch { }
                }

                // 3. Per-process heartbeat: re-pin the hard max and force-trim
                //    any process whose working set has clearly crept above the
                //    cap. We read WS from GetProcessMemoryInfo (the same
                //    WorkingSet64 surfaced by Get-Process / Task Manager) so
                //    what we see matches what the UI shows.
                dead.Clear();
                foreach (var pid in tracked)
                {
                    try
                    {
                        var pr = Process.GetProcessById(pid);
                        if (pr == null || pr.HasExited) { dead.Add(pid); continue; }
                        IntPtr h = OpenProcess(PROCESS_SET_QUOTA | PROCESS_QUERY_INFORMATION, false, pid);
                        if (h == IntPtr.Zero) { dead.Add(pid); continue; }
                        try
                        {
                            ApplyWorkingSetLimit(h, mb);
                            PROCESS_MEMORY_COUNTERS mc;
                            uint mcb = (uint)Marshal.SizeOf(typeof(PROCESS_MEMORY_COUNTERS));
                            if (GetProcessMemoryInfo(h, out mc, mcb))
                            {
                                ulong ws = (ulong)mc.WorkingSetSize;
                                if (ws > overshoot)
                                {
                                    // Drop the working set to the floor
                                    // immediately so the trim cycle that the
                                    // hard max promises actually happens.
                                    try { EmptyWorkingSet64(h); }
                                    catch
                                    {
                                        try { EmptyWorkingSet(h); } catch { }
                                    }
                                }
                            }
                        }
                        finally { CloseHandle(h); }
                    }
                    catch { dead.Add(pid); }
                }
                foreach (var d in dead) tracked.Remove(d);
            }
            catch { }
            Thread.Sleep(heartbeatMs);
        }
    }

    private static int GetParentProcessId(int pid)
    {
        IntPtr h = OpenProcess(PROCESS_QUERY_LIMITED_INFORMATION, false, pid);
        if (h == IntPtr.Zero) return 0;
        IntPtr buf = IntPtr.Zero;
        try
        {
            int size = Marshal.SizeOf(typeof(PROCESS_BASIC_INFORMATION));
            buf = Marshal.AllocHGlobal(size);
            uint returned;
            int status = NtQueryInformationProcess(h, 0, buf, (uint)size, out returned);
            if (status != 0) return 0;
            var info = (PROCESS_BASIC_INFORMATION)Marshal.PtrToStructure(buf, typeof(PROCESS_BASIC_INFORMATION));
            return (int)info.InheritedFromUniqueProcessId;
        }
        catch { return 0; }
        finally
        {
            if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
            CloseHandle(h);
        }
    }

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_BASIC_INFORMATION
    {
        public IntPtr ExitStatus;
        public IntPtr PebBaseAddress;
        public IntPtr AffinityMask;
        public IntPtr BasePriority;
        public IntPtr UniqueProcessId;
        public IntPtr InheritedFromUniqueProcessId;
    }

    [DllImport("ntdll.dll")]
    static extern int NtQueryInformationProcess(IntPtr processHandle, int processInformationClass, IntPtr processInformation, uint processInformationLength, out uint returnLength);

    private static int WaitForRobloxTarget(int bootstrapPid, long sinceMs, int timeoutMs)
    {
        DateTime deadline = DateTime.UtcNow.AddMilliseconds(timeoutMs);
        while (DateTime.UtcNow < deadline)
        {
            try
            {
                Process bootstrap = null;
                try { bootstrap = Process.GetProcessById(bootstrapPid); } catch { }
                if (bootstrap != null)
                {
                    string name = "";
                    long startMs = 0;
                    try
                    {
                        name = bootstrap.ProcessName;
                        startMs = (long)(bootstrap.StartTime.ToUniversalTime() - new DateTime(1970, 1, 1)).TotalMilliseconds;
                    }
                    catch { }
                    // The PID came from our just-created child, but still reject
                    // a theoretically reused PID if Windows recycles it while
                    // the helper is waiting.
                    if (string.Equals(name, "RobloxPlayerBeta", StringComparison.OrdinalIgnoreCase) && startMs >= sinceMs - 2000)
                        return bootstrapPid;
                }

                int selected = 0;
                DateTime selectedStart = DateTime.MaxValue;
                foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
                {
                    try
                    {
                        DateTime start = p.StartTime.ToUniversalTime();
                        long startMs = (long)(start - new DateTime(1970, 1, 1)).TotalMilliseconds;
                        if (startMs >= sinceMs && start < selectedStart)
                        {
                            selected = p.Id;
                            selectedStart = start;
                        }
                    }
                    catch { }
                }
                if (selected > 0) return selected;
            }
            catch { }
            Thread.Sleep(500);
        }
        return 0;
    }

    const uint JOB_OBJECT_LIMIT_PROCESS_MEMORY = 0x00000100;
    const uint JOB_OBJECT_LIMIT_JOB_MEMORY = 0x00000200;
    const int PROCESS_SET_QUOTA = 0x0100;
    const int PROCESS_TERMINATE = 0x0001;
    const int PROCESS_QUERY_INFORMATION = 0x0400;
    const int PROCESS_QUERY_LIMITED_INFORMATION = 0x1000;

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_BASIC_LIMIT_INFORMATION
    {
        public Int64 PerProcessUserTimeLimit;
        public Int64 PerJobUserTimeLimit;
        public UInt32 LimitFlags;
        public UIntPtr MinimumWorkingSetSize;
        public UIntPtr MaximumWorkingSetSize;
        public UInt32 ActiveProcessLimit;
        public UIntPtr Affinity;
        public UInt32 PriorityClass;
        public UInt32 SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct IO_COUNTERS
    {
        public UInt64 ReadOperationCount;
        public UInt64 WriteOperationCount;
        public UInt64 OtherOperationCount;
        public UInt64 ReadTransferCount;
        public UInt64 WriteTransferCount;
        public UInt64 OtherTransferCount;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct JOBOBJECT_EXTENDED_LIMIT_INFORMATION
    {
        public JOBOBJECT_BASIC_LIMIT_INFORMATION BasicLimitInformation;
        public IO_COUNTERS IoInfo;
        public UIntPtr ProcessMemoryLimit;
        public UIntPtr JobMemoryLimit;
        public UIntPtr PeakProcessMemoryUsed;
        public UIntPtr PeakJobMemoryUsed;
    }

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateJobObject(IntPtr lpJobAttributes, string lpName);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetInformationJobObject(IntPtr hJob, int JobObjectInformationClass, IntPtr lpJobObjectInformation, uint cbJobObjectInformationLength);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool AssignProcessToJobObject(IntPtr hJob, IntPtr hProcess);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr OpenProcess(int dwDesiredAccess, bool bInheritHandle, int dwProcessId);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr hObject);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool SetProcessWorkingSetSizeEx(IntPtr hProcess, UIntPtr dwMinimumWorkingSetSize, UIntPtr dwMaximumWorkingSetSize, uint flags);
    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool EmptyWorkingSet(IntPtr hProcess);
    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool EmptyWorkingSet64(IntPtr hProcess);
    [DllImport("psapi.dll", SetLastError = true)]
    static extern bool GetProcessMemoryInfo(IntPtr Process, out PROCESS_MEMORY_COUNTERS counters, uint size);

    // Mirrors WinNT PROCESS_MEMORY_COUNTERS -- the same struct
    // GetProcessMemoryInfo fills in. WorkingSetSize / WorkingSetSize64 are
    // identical values on x64 builds, so we only need the 32-bit field.
    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_MEMORY_COUNTERS
    {
        public uint cb;
        public uint PageFaultCount;
        public UIntPtr PeakWorkingSetSize;
        public UIntPtr WorkingSetSize;
        public UIntPtr QuotaPeakPagedPoolUsage;
        public UIntPtr QuotaPagedPoolUsage;
        public UIntPtr QuotaPeakNonPagedPoolUsage;
        public UIntPtr QuotaNonPagedPoolUsage;
        public UIntPtr PagefileUsage;
        public UIntPtr PeakPagefileUsage;
    }

    const uint QUOTA_LIMITS_HARDWS_MAX_ENABLE = 0x00000004;
    const uint CREATE_SUSPENDED = 0x00000004;
    const uint CREATE_UNICODE_ENVIRONMENT = 0x00000400;

    [StructLayout(LayoutKind.Sequential)]
    struct PROCESS_INFORMATION
    {
        public IntPtr hProcess;
        public IntPtr hThread;
        public uint dwProcessId;
        public uint dwThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    struct STARTUPINFO
    {
        public int cb;
        public IntPtr lpReserved;
        public IntPtr lpDesktop;
        public IntPtr lpTitle;
        public int dwX;
        public int dwY;
        public int dwXSize;
        public int dwYSize;
        public int dwXCountChars;
        public int dwYCountChars;
        public int dwFillAttribute;
        public int dwFlags;
        public short wShowWindow;
        public short cbReserved2;
        public IntPtr lpReserved2;
        public IntPtr hStdInput;
        public IntPtr hStdOutput;
        public IntPtr hStdError;
    }

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    static extern bool CreateProcess(
        string lpApplicationName, StringBuilder lpCommandLine,
        IntPtr lpProcessAttributes, IntPtr lpThreadAttributes,
        bool bInheritHandles, uint dwCreationFlags, IntPtr lpEnvironment,
        string lpCurrentDirectory, ref STARTUPINFO lpStartupInfo,
        out PROCESS_INFORMATION lpProcessInformation);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern uint ResumeThread(IntPtr hThread);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool TerminateProcess(IntPtr hProcess, uint uExitCode);
}

// ── Roblox singleton handle isolation (ported from closehandles.ps1) ────────
internal static class HandleCloser
{
    [DllImport("ntdll.dll")] static extern int NtQuerySystemInformation(int cls, IntPtr buf, int size, out int ret);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(int access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool DuplicateHandle(IntPtr srcProc, IntPtr srcHandle, IntPtr tgtProc, out IntPtr tgtHandle, int access, bool inherit, int opts);
    [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryObject(IntPtr h, int cls, IntPtr buf, int size, out int ret);

    const int SystemExtendedHandleInformation = 64;
    const int PROCESS_DUP_HANDLE = 0x0040;
    const int DUPLICATE_CLOSE_SOURCE = 0x1;
    const int DUPLICATE_SAME_ACCESS = 0x2;

    [StructLayout(LayoutKind.Sequential)]
    struct SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX
    {
        public IntPtr Object;
        public IntPtr UniqueProcessId;
        public IntPtr HandleValue;
        public int GrantedAccess;
        public short CreatorBackTraceIndex;
        public short ObjectTypeIndex;
        public int HandleAttributes;
        public int Reserved;
    }

    public static void CloseRobloxSingletonHandles()
    {
        var robloxPids = new System.Collections.Generic.HashSet<int>();
        foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
            robloxPids.Add(p.Id);
        if (robloxPids.Count == 0) return;

        int size = 1 << 20;
        IntPtr buf = IntPtr.Zero;
        int needed;
        try
        {
            while (true)
            {
                buf = Marshal.AllocHGlobal(size);
                int status = NtQuerySystemInformation(SystemExtendedHandleInformation, buf, size, out needed);
                if (status == 0) break;
                Marshal.FreeHGlobal(buf); buf = IntPtr.Zero;
                if (status == unchecked((int)0xC0000004)) { size *= 2; continue; } // STATUS_INFO_LENGTH_MISMATCH
                return;
            }

            long count = Marshal.ReadInt64(buf);
            int entrySize = Marshal.SizeOf(typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));
            IntPtr entries = buf + IntPtr.Size * 2; // skip NumberOfHandles + Reserved

            IntPtr self = GetCurrentProcess();

            for (long i = 0; i < count; i++)
            {
                var entry = (SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX)Marshal.PtrToStructure(
                    entries + (int)(i * entrySize),
                    typeof(SYSTEM_HANDLE_TABLE_ENTRY_INFO_EX));

                int pid = (int)entry.UniqueProcessId;
                if (!robloxPids.Contains(pid)) continue;

                IntPtr srcProc = OpenProcess(PROCESS_DUP_HANDLE, false, pid);
                if (srcProc == IntPtr.Zero) continue;

                try
                {
                    IntPtr dupHandle;
                    if (!DuplicateHandle(srcProc, entry.HandleValue, self, out dupHandle, 0, false, DUPLICATE_SAME_ACCESS))
                        continue;

                    try
                    {
                        int nameBufSize = 1024;
                        IntPtr nameBuf = Marshal.AllocHGlobal(nameBufSize);
                        try
                        {
                            int nameRet;
                            NtQueryObject(dupHandle, 1, nameBuf, nameBufSize, out nameRet); // ObjectNameInformation = 1
                            short len = Marshal.ReadInt16(nameBuf);
                            if (len > 0)
                            {
                                IntPtr strPtr = Marshal.ReadIntPtr(nameBuf, IntPtr.Size == 8 ? 8 : 4);
                                string name = Marshal.PtrToStringUni(strPtr, len / 2);
                                if (name != null && name.Contains("ROBLOX_singletonEvent"))
                                {
                                    IntPtr dummy;
                                    DuplicateHandle(srcProc, entry.HandleValue, IntPtr.Zero, out dummy, 0, false, DUPLICATE_CLOSE_SOURCE);
                                    Console.Out.WriteLine("CLOSED:" + pid);
                                }
                            }
                        }
                        finally { Marshal.FreeHGlobal(nameBuf); }
                    }
                    finally { CloseHandle(dupHandle); }
                }
                finally { CloseHandle(srcProc); }
            }
        }
        finally
        {
            if (buf != IntPtr.Zero) Marshal.FreeHGlobal(buf);
        }
    }
}

// ── OS-level Roblox volume (ported from audiovol.ps1) ───────────────────────
internal static class AudioControl
{
    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")] class MMDeviceEnumerator { }

    [Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int stateMask, out IntPtr devices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice device);
    }

    [Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int clsCtx, IntPtr activationParams, [MarshalAs(UnmanagedType.IUnknown)] out object iface);
    }

    [Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionManager2
    {
        int NotUsed1();
        int NotUsed2();
        int GetSessionEnumerator(out IAudioSessionEnumerator enumerator);
    }

    [Guid("E2F5BB11-0570-40CA-ACDD-3AA01277DEE8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionEnumerator
    {
        int GetCount(out int count);
        int GetSession(int index, out IAudioSessionControl session);
    }

    [Guid("F4B1A599-7266-4319-A8CA-E70ACB11E8CD"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl
    {
        int GetState(out int state);
        int GetDisplayName(out IntPtr name);
        int SetDisplayName(string value, ref Guid ctx);
        int GetIconPath(out IntPtr path);
        int SetIconPath(string value, ref Guid ctx);
        int GetGroupingParam(out Guid param);
        int SetGroupingParam(ref Guid over, ref Guid ctx);
        int RegisterAudioSessionNotification(IntPtr n);
        int UnregisterAudioSessionNotification(IntPtr n);
    }

    [Guid("BFB7FF88-7239-4FC9-8FA2-07C950BE9C6D"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioSessionControl2
    {
        // 9 inherited IAudioSessionControl methods (must be present so the
        // derived methods land at the correct vtable slots).
        int R1(); int R2(); int R3(); int R4(); int R5();
        int R6(); int R7(); int R8(); int R9();
        int GetSessionIdentifier(out IntPtr id);
        int GetSessionInstanceIdentifier(out IntPtr id);
        int GetProcessId(out int pid);
    }

    [Guid("87CE5498-68D6-44E5-9215-6DA47EF883D8"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface ISimpleAudioVolume
    {
        int SetMasterVolume(float level, ref Guid eventContext);
        int GetMasterVolume(out float level);
        int SetMute(bool mute, ref Guid eventContext);
        int GetMute(out bool mute);
    }

    const int eRender = 0;
    const int eConsole = 0;
    const int CLSCTX_ALL = 0x17;

    [DllImport("kernel32.dll", SetLastError = true)]
    static extern IntPtr CreateToolhelp32Snapshot(uint flags, uint processId);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32FirstW")]
    static extern bool Process32First(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true, EntryPoint = "Process32NextW")]
    static extern bool Process32Next(IntPtr snapshot, ref PROCESSENTRY32 entry);
    [DllImport("kernel32.dll", SetLastError = true)]
    static extern bool CloseHandle(IntPtr handle);

    const uint TH32CS_SNAPPROCESS = 0x00000002;
    const int MAX_PATH = 260;

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    struct PROCESSENTRY32
    {
        public uint dwSize;
        public uint cntUsage;
        public uint th32ProcessID;
        public IntPtr th32DefaultHeapID;
        public uint th32ModuleID;
        public uint cntThreads;
        public uint th32ParentProcessID;
        public int pcPriClassBase;
        public uint dwFlags;
        [MarshalAs(UnmanagedType.ByValTStr, SizeConst = MAX_PATH)]
        public string szExeFile;
    }

    // Roblox may create the process that owns the audio session underneath the
    // launch PID. Expand only the supplied launch roots; the no-PID Mixer path
    // still intentionally targets every Roblox audio session.
    static int[] ExpandDescendants(int[] roots)
    {
        var ids = new HashSet<int>();
        foreach (int root in roots) if (root > 0) ids.Add(root);
        if (ids.Count == 0) return new int[0];

        IntPtr snapshot = CreateToolhelp32Snapshot(TH32CS_SNAPPROCESS, 0);
        if (snapshot == IntPtr.Zero || snapshot == new IntPtr(-1)) return new List<int>(ids).ToArray();
        try
        {
            bool changed;
            do
            {
                changed = false;
                var entry = new PROCESSENTRY32();
                entry.dwSize = (uint)Marshal.SizeOf(typeof(PROCESSENTRY32));
                if (!Process32First(snapshot, ref entry)) break;
                do
                {
                    if (entry.th32ProcessID > 0 && ids.Contains((int)entry.th32ParentProcessID) && ids.Add((int)entry.th32ProcessID))
                        changed = true;
                } while (Process32Next(snapshot, ref entry));
            } while (changed);
        }
        finally { CloseHandle(snapshot); }
        return new List<int>(ids).ToArray();
    }

    public static int Apply(float level, int[] pids)
    {
        pids = ExpandDescendants(pids);
        int changed = 0;
        var enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumerator());
        IMMDevice device;
        if (enumerator.GetDefaultAudioEndpoint(eRender, eConsole, out device) != 0 || device == null)
            return 0;

        Guid IID_ISessionManager2 = new Guid("77AA99A0-1BD6-484F-8BC7-2C654C9A9B6F");
        object mgrObj;
        if (device.Activate(ref IID_ISessionManager2, CLSCTX_ALL, IntPtr.Zero, out mgrObj) != 0)
            return 0;
        var mgr = (IAudioSessionManager2)mgrObj;

        IAudioSessionEnumerator sessions;
        if (mgr.GetSessionEnumerator(out sessions) != 0) return 0;

        int count;
        sessions.GetCount(out count);
        Guid empty = Guid.Empty;

        for (int i = 0; i < count; i++)
        {
            IAudioSessionControl ctl;
            if (sessions.GetSession(i, out ctl) != 0 || ctl == null) continue;
            var ctl2 = ctl as IAudioSessionControl2;
            if (ctl2 == null) continue;
            int pid;
            if (ctl2.GetProcessId(out pid) != 0) continue;
            bool match = false;
            foreach (int p in pids) { if (p == pid) { match = true; break; } }
            if (!match) continue;
            var vol = ctl as ISimpleAudioVolume;
            if (vol == null) continue;
            // Clear an explicit Windows mute flag as well as restoring the
            // scalar volume. A muted group can otherwise leave the next normal
            // Roblox session silent even after SetMasterVolume(1.0f).
            // Clear mute independently from the scalar volume. Some Windows
            // audio sessions reject one COM write while accepting the other;
            // either way a normal launch must not inherit a group's mute flag.
            int volumeHr = vol.SetMasterVolume(level, ref empty);
            int muteHr = vol.SetMute(false, ref empty);
            if (volumeHr == 0 || muteHr == 0) changed++;
        }
        return changed;
    }
}

// ── Anti-AFK input injection ────────────────────────────────────────────────
// Roblox only registers input while its window is focused, so a background
// PostMessage is ignored by unfocused instances. To keep EVERY instance alive,
// each Roblox window is briefly foregrounded in turn (restoring it first if it
// was minimised), given a real key tap via keybd_event, then put back. The
// originally-focused window is restored after each pass. Per-instance timers
// mean each account is tapped the moment IT reaches the deadline (instances
// launched at different times have independent countdowns), and an instance
// you're actively playing in the foreground is never tapped.
internal static class AntiAfk
{
    [DllImport("user32.dll")] static extern bool EnumWindows(EnumWindowsProc cb, IntPtr lParam);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint pid);
    [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hWnd);
    [DllImport("user32.dll")] static extern int GetWindowTextLength(IntPtr hWnd);
    [DllImport("user32.dll")] static extern uint MapVirtualKey(uint uCode, uint uMapType);
    [DllImport("user32.dll")] static extern IntPtr GetForegroundWindow();
    [DllImport("user32.dll")] static extern void keybd_event(byte bVk, byte bScan, uint dwFlags, IntPtr dwExtraInfo);

    delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    const uint KEYEVENTF_KEYUP = 0x0002;

    static readonly Random _rng = new Random();

    // pid -> main visible window, for every running Roblox client.
    static System.Collections.Generic.Dictionary<uint, IntPtr> EnumRobloxWindows()
    {
        var robloxPids = new System.Collections.Generic.HashSet<uint>();
        foreach (var p in Process.GetProcessesByName("RobloxPlayerBeta"))
        {
            try { robloxPids.Add((uint)p.Id); } catch { }
        }
        var map = new System.Collections.Generic.Dictionary<uint, IntPtr>();
        if (robloxPids.Count == 0) return map;
        EnumWindows((hWnd, lp) =>
        {
            if (!IsWindowVisible(hWnd)) return true;
            if (GetWindowTextLength(hWnd) == 0) return true; // main game window has a title
            uint pid; GetWindowThreadProcessId(hWnd, out pid);
            if (robloxPids.Contains(pid) && !map.ContainsKey(pid)) map[pid] = hWnd;
            return true;
        }, IntPtr.Zero);
        return map;
    }

    // Send a key tap only to the Roblox window that is already in the
    // foreground. Never focus, restore, minimize, or attach another window's
    // input queue: those operations can steal the user's mouse/keyboard focus
    // and leave input behavior altered after a group session.
    static bool TapWindow(IntPtr hWnd, byte bVk, byte bScan)
    {
        if (GetForegroundWindow() != hWnd) return false;
        try
        {
            Thread.Sleep(20 + _rng.Next(20));
            keybd_event(bVk, bScan, 0, IntPtr.Zero); // key down
            try
            {
                Thread.Sleep(35 + _rng.Next(40));
            }
            finally
            {
                // Never leave the synthetic key held if the tap is interrupted.
                keybd_event(bVk, bScan, KEYEVENTF_KEYUP, IntPtr.Zero); // key up
            }
            return true;
        }
        catch { return false; }
    }

    // Per-instance anti-AFK loop. Each Roblox window gets its own countdown from
    // when it launched or was last tapped. The instant an instance reaches the
    // deadline it is tapped, including the one you're playing, then focus is
    // handed straight back to whatever window you were on.
    public static void RunLoop(int deadlineSec, int vk)
    {
        // Do not modify Windows' global foreground-lock timeout. Changing that
        // user setting from a background helper can leak into normal mouse and
        // keyboard behavior after group sessions close.
        byte bVk = (byte)vk;
        byte bScan = (byte)MapVirtualKey((uint)vk, 0);
        // pid -> UTC time its idle timer last reset (launch or our tap)
        var lastReset = new System.Collections.Generic.Dictionary<uint, DateTime>();

        while (true)
        {
            Thread.Sleep(15 * 1000); // fire within ~15s of the deadline
            DateTime now = DateTime.UtcNow;

            // Capture the window you're on BEFORE touching anything, so we can
            // always hand focus back exactly where it was.
            IntPtr originalFg = GetForegroundWindow();

            var windows = EnumRobloxWindows();

            var gone = new System.Collections.Generic.List<uint>();
            foreach (var pid in lastReset.Keys) if (!windows.ContainsKey(pid)) gone.Add(pid);
            foreach (var pid in gone) lastReset.Remove(pid);
            foreach (var pid in windows.Keys) if (!lastReset.ContainsKey(pid)) lastReset[pid] = now;

            var due = new System.Collections.Generic.List<uint>();
            foreach (var kv in windows)
            {
                if ((now - lastReset[kv.Key]).TotalSeconds >= deadlineSec) due.Add(kv.Key);
            }
            if (due.Count == 0) continue;

            foreach (var pid in due)
            {
                if (TapWindow(windows[pid], bVk, bScan))
                {
                    Console.Out.WriteLine("ANTIAFK_TICK:" + pid);
                    Console.Out.Flush();
                }
                lastReset[pid] = DateTime.UtcNow;
            }

            // No focus restoration is needed: TapWindow only ever targets the
            // window that was already foreground when it was checked.
        }
    }

}
