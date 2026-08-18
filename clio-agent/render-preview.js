// render-preview.js: rasterize a PPTX to per-slide PNGs via LibreOffice + poppler.
const fs = require('fs');
const os = require('os');
const path = require('path');
const { execFile, execFileSync } = require('child_process');
const { promisify } = require('util');

const execFileP = promisify(execFile);

const SOFFICE_APP_PATH = '/Applications/LibreOffice.app/Contents/MacOS/soffice';
const PDFTOPPM_FALLBACKS = ['/opt/homebrew/bin/pdftoppm', '/usr/local/bin/pdftoppm'];

// ── Binary discovery ────────────────────────────────────────
function findSoffice() {
  try {
    const out = execFileSync('which', ['soffice'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (out) return out;
  } catch { /* not on PATH */ }
  if (fs.existsSync(SOFFICE_APP_PATH)) return SOFFICE_APP_PATH;
  return null;
}

function findPdftoppm() {
  try {
    const out = execFileSync('which', ['pdftoppm'], { stdio: ['ignore', 'pipe', 'ignore'] })
      .toString().trim();
    if (out) return out;
  } catch { /* not on PATH */ }
  for (const p of PDFTOPPM_FALLBACKS) {
    if (fs.existsSync(p)) return p;
  }
  return null;
}

// ── Render ──────────────────────────────────────────────────
// Converts pptxPath to PDF via headless LibreOffice, then rasterizes each
// page to <outDir>/slide-NN.png at 96 dpi. Returns sorted absolute PNG paths.
// Throws { code: 'SOFFICE_UNAVAILABLE' } when the toolchain is missing.
async function renderDeckToImages(pptxPath, outDir) {
  const soffice = findSoffice();
  const pdftoppm = findPdftoppm();
  if (!soffice || !pdftoppm) {
    const err = new Error('rendering toolchain not installed (needs LibreOffice + poppler)');
    err.code = 'SOFFICE_UNAVAILABLE';
    throw err;
  }
  if (!fs.existsSync(pptxPath)) {
    throw new Error(`deck not found: ${pptxPath}`);
  }

  // PNGs land in a sibling staging dir and are promoted to outDir only after
  // a full successful render, so a crashed pdftoppm can never leave a partial
  // set behind that the cache would treat as complete.
  const stageDir = outDir + '.tmp';
  const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'clio-render-'));
  try {
    fs.rmSync(stageDir, { recursive: true, force: true });
    fs.mkdirSync(stageDir, { recursive: true });
    // Isolated profile per invocation: concurrent soffice processes otherwise
    // contend on the shared user profile lock and hang until timeout.
    const profileDir = path.join(tmpDir, 'lo-profile');
    await execFileP(
      soffice,
      [`-env:UserInstallation=file://${profileDir}`, '--headless', '--convert-to', 'pdf', '--outdir', tmpDir, pptxPath],
      { timeout: 120000 }
    );
    const pdfPath = path.join(tmpDir, path.basename(pptxPath).replace(/\.pptx$/i, '.pdf'));
    if (!fs.existsSync(pdfPath)) {
      throw new Error('LibreOffice produced no PDF output');
    }
    await execFileP(
      pdftoppm,
      ['-png', '-r', '96', pdfPath, path.join(stageDir, 'slide')],
      { timeout: 120000 }
    );
    // Swap via a backup rename so outDir never has a missing-window for
    // concurrent readers; delete-then-rename would briefly 404 them.
    const oldDir = outDir + '.old';
    fs.rmSync(oldDir, { recursive: true, force: true });
    if (fs.existsSync(outDir)) fs.renameSync(outDir, oldDir);
    fs.renameSync(stageDir, outDir);
    fs.rmSync(oldDir, { recursive: true, force: true });
    return fs.readdirSync(outDir)
      .filter(f => /^slide.*\.png$/.test(f))
      .sort()
      .map(f => path.join(outDir, f));
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
    fs.rmSync(stageDir, { recursive: true, force: true });
  }
}

module.exports = { findSoffice, findPdftoppm, renderDeckToImages };
