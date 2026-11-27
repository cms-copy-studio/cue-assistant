import {copyFile, mkdir} from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import path from 'node:path';
import {execFileSync} from 'node:child_process';
const root=fileURLToPath(new URL('../',import.meta.url));
const dest=path.join(root,'docs','demo');
await mkdir(dest,{recursive:true});
for(const name of ['panel.mjs','panel-model.mjs','panel.css','planner.mjs']) {
  await copyFile(path.join(root,'extension',name),path.join(dest,name));
}
await copyFile(path.join(root,'demo','source.mjs'),path.join(dest,'source.mjs'));
await copyFile(path.join(root,'extension','panel.html'),path.join(dest,'index.html'));
await mkdir(path.join(root,'docs','downloads'),{recursive:true});
const files=['background.mjs','manifest.json','panel-model.mjs','panel.css','panel.html','panel.mjs','planner.mjs','reader.js','source.mjs'];
// Stable archives keep the downloadable installation and the reviewed sources in sync.
const pack = `from pathlib import Path
from zipfile import ZipFile, ZipInfo, ZIP_DEFLATED
import sys
root=Path(sys.argv[1])
with ZipFile(root/"docs/downloads/cue-assistant.zip","w") as z:
    for n in sys.argv[2:]:
        entry=ZipInfo(n, (2026, 1, 1, 0, 0, 0))
        entry.external_attr=0o100644 << 16
        z.writestr(entry,(root/"extension"/n).read_bytes(),compress_type=ZIP_DEFLATED)
`;
execFileSync('python3',['-c',pack,root,...files]);
