// Removes electron-builder intermediates from dist/ so the folder only keeps
// the final artifacts (the portable rbxSWAP.exe + the NSIS installer).
// Everything deleted here (win-unpacked, blockmaps, builder yamls, 7z temp
// archives) is regenerated automatically on the next build.
const fs = require('fs');
const path = require('path');

const dist = path.join(__dirname, '..', 'dist');
if (!fs.existsSync(dist)) {
  console.log('dist/ not found — nothing to clean');
  process.exit(0);
}

let removed = 0;
let kept = 0;
for (const name of fs.readdirSync(dist)) {
  const full = path.join(dist, name);
  if (name.endsWith('.exe')) { kept++; continue; } // keep final artifacts
  fs.rmSync(full, { recursive: true, force: true });
  removed++;
}
console.log(`Cleaned ${removed} intermediate(s) from dist/ (kept ${kept} executable(s))`);
