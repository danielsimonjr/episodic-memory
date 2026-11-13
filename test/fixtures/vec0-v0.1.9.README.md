# vec0-v0.1.9.sqlite

The sqlite-vec extension 0.1.9 wrote this file, through better-sqlite3 13.0.3. The file has an `exchanges` table and a `vec_exchanges` vec0 table with `chunk_size=8`, so it is small. The table holds three 384-wide vectors, `fx0`, `fx1` and `fx2`. Element `i` of vector `fxK` is `(K + 1) * 0.001 * (i + 1)`, stored as a 32-bit float.

`test/exchange-vectors.test.ts` reads the file. The test proves that the migration reads the shadow-table layout that the real extension writes.

To write the file again, check out a version of the repository that still depends on better-sqlite3 and sqlite-vec. Then run this script from the repository root with the output path as the argument:

```js
const Database = require(process.cwd() + '/node_modules/better-sqlite3');
const sqliteVec = require(process.cwd() + '/node_modules/sqlite-vec');
const fs = require('fs');
const out = process.argv[2];
fs.rmSync(out, { force: true });
const db = new Database(out);
sqliteVec.load(db);
db.pragma('journal_mode = DELETE');
db.exec(`CREATE TABLE exchanges (id TEXT PRIMARY KEY, embedding_version INTEGER NOT NULL DEFAULT 0);
CREATE VIRTUAL TABLE vec_exchanges USING vec0(id TEXT PRIMARY KEY, embedding FLOAT[384], chunk_size=8);`);
const ins = db.prepare('INSERT INTO vec_exchanges (id, embedding) VALUES (?, ?)');
for (let k = 0; k < 3; k++) {
  const v = new Float32Array(384);
  for (let i = 0; i < 384; i++) v[i] = (k + 1) * 0.001 * (i + 1);
  db.prepare('INSERT INTO exchanges (id, embedding_version) VALUES (?, 1)').run('fx' + k);
  ins.run('fx' + k, Buffer.from(v.buffer));
}
db.exec('VACUUM');
db.close();
```
