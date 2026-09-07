'use strict';
// electron-builder afterPack hook. macOS only: ad-hoc sign the packed .app.
//
// The macOS build is unsigned (no Apple Developer ID), so package.json sets `mac.identity: null` and
// electron-builder skips its own signing step. Apple Silicon refuses to launch native code that carries
// no signature at all, and the bundle edits electron-builder makes (asar, Info.plist, renames) break the
// seal on Electron's pre-signed frameworks — so re-sign the whole bundle with the ad-hoc identity ("-").
// The result launches after the user clears Gatekeeper's quarantine once (see README → macOS install).
const path = require('path');
const fs = require('fs');
const { execFileSync } = require('child_process');

exports.default = async function afterPack(context) {
  if (context.electronPlatformName !== 'darwin') return;
  const appName = `${context.packager.appInfo.productFilename}.app`;
  const appPath = path.join(context.appOutDir, appName);
  if (!fs.existsSync(appPath)) {
    console.warn(`[after-pack] ${appPath} not found; skipping ad-hoc signing`);
    return;
  }
  console.log(`[after-pack] ad-hoc signing ${appPath}`);
  execFileSync('codesign', ['--force', '--deep', '--sign', '-', '--timestamp=none', appPath], { stdio: 'inherit' });
  execFileSync('codesign', ['--verify', '--deep', '--strict', '--verbose=1', appPath], { stdio: 'inherit' });
};
