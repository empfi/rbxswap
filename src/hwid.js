const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFile } = require('child_process');
const { promisify } = require('util');

const execFileAsync = promisify(execFile);
const fsp = fs.promises;

const IDENTIFIERS = {
	machineGuid:   { hive: 'HKLM', key: 'SOFTWARE\\Microsoft\\Cryptography',                                              value: 'MachineGuid',   braces: false, upper: false },
	hwProfileGuid: { hive: 'HKLM', key: 'SYSTEM\\CurrentControlSet\\Control\\IDConfigDB\\Hardware Profiles\\0001',         value: 'HwProfileGuid', braces: true,  upper: true  },
	machineId:     { hive: 'HKLM', key: 'SOFTWARE\\Microsoft\\SQMClient',                                                  value: 'MachineId',     braces: true,  upper: true  }
};
const GUID_RE = /^\{?[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\}?$/;

function getExecutionDir() {
	return process.env.PORTABLE_EXECUTABLE_DIR || path.dirname(process.execPath) || __dirname;
}
function getBackupPath() {
	return path.join(getExecutionDir(), 'backup.json');
}
async function isElevated() {
	try {
		await execFileAsync('net', ['session']);
		return true;
	} catch (e) {
		return false;
	}
}
function backupExists() {
	return fs.existsSync(getBackupPath());
}

//? proper RFC-4122 v4 guid
function generateGuid({ braces = false, upper = false } = {}) {
	const b = crypto.randomBytes(16);
	b[6] = (b[6] & 0x0f) | 0x40; //? version 4
	b[8] = (b[8] & 0x3f) | 0x80; //? variant 1 (10xx)

	const hex = b.toString('hex');
	let guid = `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
	if (upper) guid = guid.toUpperCase();
	return braces ? `{${guid}}` : guid;
}
function isValidGuid(str) {
	return typeof str === 'string' && GUID_RE.test(str.trim());
}

async function regRead(hive, key, value) {
	try {
		const { stdout } = await execFileAsync('reg', ['query', `${hive}\\${key}`, '/v', value]);
		//? line looks like:  MachineGuid    REG_SZ    <data>
		const m = stdout.match(new RegExp(`${value}\\s+REG_\\w+\\s+(.+)`, 'i'));
		return m ? m[1].trim() : null;
	} catch (e) {
		return null;
	}
}
async function regWrite(hive, key, value, data) {
	await execFileAsync('reg', ['add', `${hive}\\${key}`, '/v', value, '/t', 'REG_SZ', '/d', data, '/f']);
}
async function regDeleteKey(hive, key) {
	try {
		await execFileAsync('reg', ['delete', `${hive}\\${key}`, '/f']);
		return true;
	} catch (e) {
		return false;
	}
}

function psEscape(str) {
	return String(str).replace(/'/g, "''");
}

function sha256(buf) {
	return crypto.createHash('sha256').update(buf).digest('hex');
}
async function runPs(script) {
	const { stdout } = await execFileAsync('powershell', ['-NoProfile', '-Command', script]);
	return stdout.trim();
}

async function readAdapters() {
	try {
		const out = await runPs(`
			$class = "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}"
			Get-NetAdapter | Where-Object { $_.MacAddress -and $_.InterfaceDescription -notmatch 'WARP|VPN|Virtual|Tap|Teredo' } | ForEach-Object {
				$desc = $_.InterfaceDescription
				$na = $null
				Get-ChildItem $class -ErrorAction SilentlyContinue | ForEach-Object {
					$p = Get-ItemProperty $_.PSPath -ErrorAction SilentlyContinue
					if ($p.DriverDesc -eq $desc) { $na = $p.NetworkAddress }
				}
				[pscustomobject]@{ Name = $_.Name; Desc = $desc; Mac = $_.MacAddress; NetworkAddress = $na }
			} | ConvertTo-Json -Compress
		`);
		if (!out) return [];
		const parsed = JSON.parse(out);
		return Array.isArray(parsed) ? parsed : [parsed];
	} catch (e) {
		return [];
	}
}

//? we dont want false bans... that very very not good!
//* note: { t } is an instruction line, { c } is a command rendered as a copyable codeblock
const ANTICHEATS = [
	{ name: 'Riot Vanguard', services: ['vgc', 'vgk'], processes: ['vgc', 'vgtray'],
		steps: [
			{ t: '1. Open Command Prompt as Administrator and run these:' },
			{ c: 'sc stop vgc' },
			{ c: 'sc config vgk start= disabled' },
			{ t: '2. Reboot. The vgk kernel driver only unloads on restart' },
			{ t: '3. To play Valorant again later, reenable it & reboot:' },
			{ c: 'sc config vgk start= system' }
		] },
	{ name: 'FACEIT AC', services: ['faceit', 'faceitac'], processes: ['faceitclient', 'faceit'],
		steps: [
			{ t: '1. Right-click the FACEIT AC tray icon and Exit' },
			{ t: 'Or run as Administrator:' },
			{ c: 'sc stop faceit' },
			{ t: '2. Reboot if it keeps running' }
		] },
	{ name: 'EasyAntiCheat', services: ['easyanticheat', 'easyanticheat_eos'], processes: ['easyanticheat'],
		steps: [
			{ t: '1. Open Command Prompt as Administrator' },
			{ c: 'sc stop EasyAntiCheat' },
			{ t: '2. It usually stops on its own once the game is closed' }
		] },
	{ name: 'BattlEye', services: ['beservice', 'bedaisy'], processes: ['beservice'],
		steps: [
			{ t: '1. Open Command Prompt as Administrator' },
			{ c: 'sc stop BEService' },
			{ t: '2. It usually stops once the game is closed' }
		] },
	{ name: 'ESEA', services: ['eseaclient'], processes: ['eseaclient'],
		steps: [
			{ t: '1. Exit the ESEA client from the system tray' },
			{ t: '2. Or run as Administrator:' },
			{ c: 'sc stop ESEAClient' }
		] }
];
async function detectAnticheats() {
	let running = { services: [], processes: [] };
	try {
		const out = await runPs(`
			$svc = @(Get-CimInstance Win32_Service -ErrorAction SilentlyContinue | Where-Object { $_.State -eq 'Running' } | Select-Object -ExpandProperty Name)
			$proc = @(Get-Process -ErrorAction SilentlyContinue | Select-Object -ExpandProperty Name)
			ConvertTo-Json -Compress @{ services = $svc; processes = $proc }
		`);
		if (out) {
			const parsed = JSON.parse(out);
			running.services = (parsed.services || []).map(s => String(s).toLowerCase());
			running.processes = (parsed.processes || []).map(p => String(p).toLowerCase());
		}
	} catch (e) {
		return [];
	}

	const detected = [];
	for (const ac of ANTICHEATS) {
		const hitSvc = ac.services.find(s => running.services.includes(s));
		const hitProc = ac.processes.find(p => running.processes.includes(p));
		if (hitSvc || hitProc) {
			detected.push({ name: ac.name, service: hitSvc || null, steps: ac.steps });
		}
	}
	return detected;
}

//? the VSN in the boot sector is the only disk id reachable from usermode
//? we patch just the serial field n back up the whole original sector
//! locked/denied volumes are skipped
const SYSTEM_DRIVE = (process.env.SystemDrive || 'C:').replace(/[\\/]+$/, '');
function rawVolumePath(drive) {
	return `\\\\.\\${drive}`;
}

//? Node fs can't do raw volume r/w on Windows so we use .NET's FileStream w/ powershell
//! 512-byte aligned at offset 0
async function readSector(drive) {
	//? read in a loop until the full 512 bytes land!!!!
	//!!!! a raw volume Read can return short and a partial/zero read must never be mistaken for real boot-sector data!!!!
	const b64 = await runPs(`
		$fs = New-Object System.IO.FileStream('${rawVolumePath(drive)}', [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::ReadWrite)
		$buf = New-Object byte[] 512
		$total = 0
		while ($total -lt 512) {
			$n = $fs.Read($buf, $total, 512 - $total)
			if ($n -le 0) { break }
			$total += $n
		}
		$fs.Close()
		if ($total -lt 512) { '' } else { [Convert]::ToBase64String($buf) }
	`);
	//? strip ALL whitespace (not just ends) so any console line-wrap can't mangle the bytes
	const buf = Buffer.from(b64.replace(/\s+/g, ''), 'base64');
	if (buf.length !== 512) throw new Error('short read');
	return buf;
}

//? only a genuine boot sector (0x55AA + known FS tag) is ever written or restored
//? so a zero/partial/garbage read can never corrupt actual sector :umm:
function isBootSector(buf) {
	return Buffer.isBuffer(buf) && buf.length === 512 &&
		buf[510] === 0x55 && buf[511] === 0xAA && vsnOffset(buf) !== null;
}

async function writeSector(drive, buffer) {
	//! never write anything that isn't exactly one 512-byte sector
	if (!Buffer.isBuffer(buffer) || buffer.length !== 512) {
		throw new Error('refusing to write a non-512-byte sector');
	}
	const b64 = buffer.toString('base64');
	await runPs(`
		$bytes = [Convert]::FromBase64String('${b64}')
		if ($bytes.Length -ne 512) { throw "decoded sector is not 512 bytes" }
		$fs = New-Object System.IO.FileStream('${rawVolumePath(drive)}', [IO.FileMode]::Open, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
		$fs.Seek(0, [IO.SeekOrigin]::Begin) | Out-Null
		$fs.Write($bytes, 0, 512)
		$fs.Flush()
		$fs.Close()
	`);
}

function generateVolumeSerial() {
	const hex = crypto.randomBytes(4).toString('hex').toUpperCase();
	return `${hex.slice(0, 4)}-${hex.slice(4, 8)}`; //? XXXX-XXXX
}

//? 8 hex digits XXXX-XXXX
async function readVolumeSerial(drive = SYSTEM_DRIVE) {
	try {
		const out = await runPs(`(Get-CimInstance Win32_LogicalDisk -Filter "DeviceID='${psEscape(drive)}'").VolumeSerialNumber`);
		const h = (out || '').trim().toUpperCase();
		if (/^[0-9A-F]{8}$/.test(h)) return `${h.slice(0, 4)}-${h.slice(4, 8)}`;
	} catch (e) {}
	return null;
}

//? 4-byte VSN field
//? we search via the filesystem signature in the boot sector
function vsnOffset(sector) {
	if (sector.toString('ascii', 3, 7) === 'NTFS') return 0x48;        //? NTFS
	if (sector.toString('ascii', 0x52, 0x57) === 'FAT32') return 0x43; //? FAT32
	if (sector.toString('ascii', 0x36, 0x39) === 'FAT') return 0x27;   //? FAT12/16
	return null;
}

//! snapshot drive letter + displayed serial + the raw boot sector (base64) for exact revert!!!
async function readVolumeBackup(drive = SYSTEM_DRIVE) {
	const entry = { drive, serial: await readVolumeSerial(drive), sector: null, sectorHash: null, offset: null };
	try {
		const buf = await readSector(drive);
		if (isBootSector(buf)) { //? only store a sector we can prove is genuine
			entry.sector = buf.toString('base64');
			entry.sectorHash = sha256(buf);
			entry.offset = vsnOffset(buf);
		}
	} catch (e) {}
	return entry;
}

//? patches the VSN field in place (32-bit little-endian) and writes the sector back
//? changes apply on next mount/reboot
async function spoofVolumeSerial(drive = SYSTEM_DRIVE) {
	try {
		const buf = await readSector(drive);
		if (!isBootSector(buf)) return { drive, ok: false, error: 'not a valid boot sector (elevated?)' };

		const serial = generateVolumeSerial();
		buf.writeUInt32LE(parseInt(serial.replace('-', ''), 16) >>> 0, vsnOffset(buf));
		await writeSector(drive, buf);
		return { drive, ok: true, serial, reboot: true };
	} catch (e) {
		return { drive, ok: false, error: e.message };
	}
}

//? writes the original boot sector back — only after proving it survived storage intact
async function restoreVolumeSerial(entry) {
	if (!entry || !entry.sector) return { drive: entry?.drive, restored: false, reason: 'no-sector' };
	const buf = Buffer.from(String(entry.sector).replace(/\s+/g, ''), 'base64');

	//! must decode to a genuine 512-byte boot sector (0x55AA + known FS)
	if (!isBootSector(buf)) return { drive: entry.drive, restored: false, reason: 'backup not a valid boot sector' };

	//! AND bytes must hash-match what we originally read
	//! if it doesn't match, we do NOT write cuz umm... not good
	if (entry.sectorHash && sha256(buf) !== entry.sectorHash) {
		return { drive: entry.drive, restored: false, reason: 'integrity check failed — backup not written' };
	}

	try {
		await writeSector(entry.drive, buf);
		return { drive: entry.drive, restored: true, reboot: true };
	} catch (e) {
		return { drive: entry.drive, restored: false, reason: e.message };
	}
}

//? Windows System Restore point — safety net for the registry spoofs. enables restore on
//? the system drive and clears the 24h throttle so the checkpoint actually creates.
async function createSystemRestorePoint(description = 'rblxswap pre-spoof') {
	try {
		const out = await runPs(`
			try {
				Enable-ComputerRestore -Drive "$env:SystemDrive\\" -ErrorAction SilentlyContinue
				New-ItemProperty -Path "HKLM:\\SOFTWARE\\Microsoft\\Windows NT\\CurrentVersion\\SystemRestore" -Name "SystemRestorePointCreationFrequency" -Value 0 -PropertyType DWord -Force -ErrorAction SilentlyContinue | Out-Null
				Checkpoint-Computer -Description '${psEscape(description)}' -RestorePointType 'MODIFY_SETTINGS' -ErrorAction Stop
				Write-Output 'OK'
			} catch {
				Write-Output ('ERR: ' + $_.Exception.Message)
			}
		`);
		if (out.startsWith('OK')) return { ok: true };
		return { ok: false, message: out.replace(/^ERR:\s*/, '') || 'System Restore unavailable' };
	} catch (e) {
		return { ok: false, message: e.message };
	}
}

//* NOTE: snapshot genuine identifiers exactly once
//* never overwrite originals with spoofed ones
async function createBackup() {
	if (backupExists()) {
		return { created: false, snapshot: readBackup() };
	}

	const snapshot = {
		savedAt: new Date().toISOString(),
		identifiers: {},
		adapters: await readAdapters(),
		volume: await readVolumeBackup() //? system-drive boot sector + serial
	};

	for (const [name, spec] of Object.entries(IDENTIFIERS)) {
		snapshot.identifiers[name] = await regRead(spec.hive, spec.key, spec.value);
	}

	await fsp.writeFile(getBackupPath(), JSON.stringify(snapshot, null, 2), 'utf8');
	return { created: true, snapshot };
}

function readBackup() {
	try {
		return JSON.parse(fs.readFileSync(getBackupPath(), 'utf8'));
	} catch (e) {
		return null;
	}
}

//? back up first (no-op if already done), then write fresh valid values
//? each write is isolated so one denied key doesn't sink the rest
//* opts.guids / opts.volume gate each group
async function spoofIdentifiers(opts = {}) {
	const { guids = true, volume = true } = opts;
	await createBackup();

	const results = [];
	if (guids) {
		for (const [name, spec] of Object.entries(IDENTIFIERS)) {
			const fresh = generateGuid({ braces: spec.braces, upper: spec.upper });
			try {
				await regWrite(spec.hive, spec.key, spec.value, fresh);
				results.push({ name, value: fresh, ok: true });
			} catch (e) {
				results.push({ name, value: fresh, ok: false, error: e.message });
			}
		}
	}

	//? boot-sector VSN
	if (volume) {
		const vol = await spoofVolumeSerial();
		results.push({ name: 'volumeSerial', value: vol.serial || null, ok: vol.ok, error: vol.error, reboot: vol.reboot });
	}

	return results;
}

function backupInfo() {
	const backup = readBackup();
	if (!backup) return { exists: false };
	return {
		exists: true,
		savedAt: backup.savedAt || null,
		has: {
			guids: Object.values(backup.identifiers || {}).some(isValidGuid),
			mac: (backup.adapters || []).length > 0,
			volume: !!(backup.volume && backup.volume.sector)
		},
		serials: {
			machineGuid: backup.identifiers?.machineGuid || null,
			volume: backup.volume?.serial || null
		}
	};
}

//? selective revert (new :steamhappy:)
async function restoreIdentifiers(opts = {}) {
	const backup = readBackup();
	if (!backup) return { ok: false, reason: 'no-backup' };

	const info = backupInfo();
	const { guids = true, mac = true, volume = true } = opts;
	const results = { identifiers: [], adapters: [], errors: [] };

	if (guids) {
		for (const [name, spec] of Object.entries(IDENTIFIERS)) {
			const original = backup.identifiers?.[name];
			if (!isValidGuid(original)) {
				results.identifiers.push({ name, restored: false, reason: 'missing-or-invalid' });
				continue;
			}
			try {
				await regWrite(spec.hive, spec.key, spec.value, original);
				results.identifiers.push({ name, restored: true });
			} catch (e) {
				results.identifiers.push({ name, restored: false, reason: e.message });
				results.errors.push(`${name}: ${e.message}`);
			}
		}
	}

	if (mac) {
		for (const adapter of backup.adapters || []) {
			try {
				if (adapter.NetworkAddress) {
					await setNetworkAddress(adapter.Desc, adapter.NetworkAddress);
				} else {
					await clearNetworkAddress(adapter.Desc);
				}
				await cycleAdapter(adapter.Name);
				results.adapters.push({ name: adapter.Name, restored: true });
			} catch (e) {
				results.adapters.push({ name: adapter.Name, restored: false, reason: e.message });
				results.errors.push(`${adapter.Name}: ${e.message}`);
			}
		}
	}

	if (volume && backup.volume) {
		//? rewrite the original boot sector
		const vol = await restoreVolumeSerial(backup.volume);
		results.volume = vol;
		if (vol.restored === false && vol.reason && vol.reason !== 'no-sector') {
			results.errors.push(`volume ${vol.drive}: ${vol.reason}`);
		}
	}

	//? drop the backup only when every category it holds was selected AND restored cleanly
	//? a partial / failed restore keeps the originals so the user can revert the rest later
	const coveredEverything =
		(guids || !info.has.guids) &&
		(mac || !info.has.mac) &&
		(volume || !info.has.volume);
	const ok = results.errors.length === 0;
	if (ok && coveredEverything) {
		try {
			await fsp.unlink(getBackupPath());
		} catch (e) {}
	}

	return { ok, coveredEverything, ...results };
}

async function setNetworkAddress(adapterDesc, mac) {
	await runPs(`
		$a = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}\\0*" -ErrorAction SilentlyContinue | Where-Object { $_.DriverDesc -eq '${psEscape(adapterDesc)}' }
		if ($a) { Set-ItemProperty -Path $a[0].PSPath -Name "NetworkAddress" -Value "${psEscape(mac).replace(/[-:]/g, '')}" -ErrorAction Stop }
	`);
}

async function clearNetworkAddress(adapterDesc) {
	await runPs(`
		$a = Get-ItemProperty "HKLM:\\SYSTEM\\CurrentControlSet\\Control\\Class\\{4d36e972-e325-11ce-bfc1-08002be10318}\\0*" -ErrorAction SilentlyContinue | Where-Object { $_.DriverDesc -eq '${psEscape(adapterDesc)}' }
		if ($a) { Remove-ItemProperty -Path $a[0].PSPath -Name "NetworkAddress" -ErrorAction SilentlyContinue }
	`);
}

async function cycleAdapter(name) {
	await runPs(`
		Disable-NetAdapter -Name '${psEscape(name)}' -Confirm:$false -ErrorAction Continue
		Enable-NetAdapter -Name '${psEscape(name)}' -Confirm:$false -ErrorAction Continue
	`);
}


async function purgeRobloxTraces() {
	const out = { files: 0, dirs: 0, registry: [], errors: [] };
	const userProfile = process.env.USERPROFILE;
	if (!userProfile) {
		out.errors.push('USERPROFILE missing');
		return out;
	}

	const robloxLocal = path.join(userProfile, 'AppData', 'Local', 'Roblox');
	const targets = [
		path.join(robloxLocal, 'LocalStorage'), //? client auth/cookies are here
		path.join(robloxLocal, 'logs')          //? rather be safe than sorry
	];

	for (const dir of targets) {
		//! every target MUST sit under the Roblox local root before we delete
		if (path.relative(robloxLocal, dir).startsWith('..')) continue;
		const cleared = await clearDirFiles(dir, out);
		out.files += cleared;
	}

	for (const key of ['Software\\Roblox', 'Software\\Roblox Corporation']) {
		const ok = await regDeleteKey('HKCU', key);
		out.registry.push({ key: `HKCU\\${key}`, deleted: ok });
	}

	return out;
}

async function clearDirFiles(dir, out) {
	let count = 0;
	let entries;
	try {
		entries = await fsp.readdir(dir, { withFileTypes: true });
	} catch (e) {
		return 0; //? dir absent / inaccessible
	}

	for (const entry of entries) {
		const full = path.join(dir, entry.name);
		try {
			if (entry.isDirectory()) {
				count += await clearDirFiles(full, out);
			} else {
				await fsp.unlink(full);
				count++;
			}
		} catch (e) {
			out.errors.push(`${full}: ${e.message}`);
		}
	}
	return count;
}

module.exports = {
	getBackupPath,
	backupExists,
	isElevated,
	generateGuid,
	isValidGuid,
	generateVolumeSerial,
	readVolumeSerial,
	spoofVolumeSerial,
	restoreVolumeSerial,
	createBackup,
	createSystemRestorePoint,
	detectAnticheats,
	readBackup,
	backupInfo,
	spoofIdentifiers,
	restoreIdentifiers,
	purgeRobloxTraces,
	IDENTIFIERS
};
