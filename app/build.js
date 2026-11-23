// Build dist/SlideX.app (`npm run package`), or with SLIDEX_DEV=1 a separate
// "SlideX Dev.app" with its own bundle ID (`npm run package:dev`), so a
// development build can sit next to the installed SlideX without replacing it.
//
// Assembles the bundle from the Electron already in node_modules (no second
// download): copy Electron.app, drop our code into Contents/Resources/app,
// rename, set icon and Info.plist, and sign ad hoc for this machine.
'use strict';
const { execFileSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const run = (cmd, args) => execFileSync(cmd, args, { stdio: 'inherit' });
const plist = (file, ...cmds) => execFileSync('/usr/libexec/PlistBuddy',
  [...cmds.flatMap((c) => ['-c', c]), file], { stdio: ['ignore', 'ignore', 'pipe'] });

const here = __dirname;
const icon = path.join(here, 'icon.icns');
if (!fs.existsSync(icon)) run('python3', [path.join(here, 'make_icon.py'), icon]);

const src = path.join(here, 'node_modules', 'electron', 'dist', 'Electron.app');
if (!fs.existsSync(src)) {
  console.error('Electron is not installed: run  node node_modules/electron/install.js');
  process.exit(1);
}
const dist = path.join(here, 'dist');
const DEV = !!process.env.SLIDEX_DEV;
const NAME = DEV ? 'SlideX Dev' : 'SlideX';
const appPath = path.join(dist, `${NAME}.app`);
fs.rmSync(appPath, { recursive: true, force: true });
fs.mkdirSync(dist, { recursive: true });
run('ditto', [src, appPath]);           // keeps symlinks and framework layout

// Our code
const res = path.join(appPath, 'Contents', 'Resources');
const appDir = path.join(res, 'app');
fs.mkdirSync(appDir);
for (const f of ['main.js', 'preload.js', 'editor.js', 'synctex.js']) fs.copyFileSync(path.join(here, f), path.join(appDir, f));
run('ditto', [path.join(here, 'viewer'), path.join(appDir, 'viewer')]);
{ // runtime package.json: no scripts or dev dependencies
  const pkg = require('./package.json');
  fs.writeFileSync(path.join(appDir, 'package.json'), JSON.stringify(
    { name: pkg.name, productName: pkg.productName, version: pkg.version, main: pkg.main }, null, 2));
}
fs.rmSync(path.join(res, 'default_app.asar'), { force: true });

// Icon and names
fs.copyFileSync(icon, path.join(res, 'SlideX.icns'));
fs.rmSync(path.join(res, 'electron.icns'), { force: true });
const macos = path.join(appPath, 'Contents', 'MacOS');
fs.renameSync(path.join(macos, 'Electron'), path.join(macos, NAME));

const info = path.join(appPath, 'Contents', 'Info.plist');
function setKey(key, type, value) {
  try { plist(info, `Delete :${key}`); } catch { /* not there */ }
  plist(info, `Add :${key} ${type} ${value}`);
}
setKey('CFBundleExecutable', 'string', NAME);
setKey('CFBundleName', 'string', NAME);
setKey('CFBundleDisplayName', 'string', NAME);
setKey('CFBundleIdentifier', 'string', DEV ? 'org.slidex.app.dev' : 'org.slidex.app');
setKey('CFBundleIconFile', 'string', 'SlideX.icns');
setKey('CFBundleShortVersionString', 'string', require('./package.json').version);
setKey('LSApplicationCategoryType', 'string', 'public.app-category.productivity');
try { plist(info, 'Delete :CFBundleDocumentTypes'); } catch { /* not there */ }
plist(info,
  'Add :CFBundleDocumentTypes array',
  'Add :CFBundleDocumentTypes:0 dict',
  'Add :CFBundleDocumentTypes:0:CFBundleTypeName string PDF slide deck',
  'Add :CFBundleDocumentTypes:0:CFBundleTypeRole string Viewer',
  'Add :CFBundleDocumentTypes:0:LSHandlerRank string Alternate',   // in "Open With", never the default
  'Add :CFBundleDocumentTypes:0:LSItemContentTypes array',
  'Add :CFBundleDocumentTypes:0:LSItemContentTypes:0 string com.adobe.pdf');

// Ad-hoc signature so Apple Silicon runs the edited bundle.
run('codesign', ['--force', '--deep', '--sign', '-', appPath]);
console.log('built', appPath);
