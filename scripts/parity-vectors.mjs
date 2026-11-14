#!/usr/bin/env node
// Write the reference vectors of the embedding parity test for the CPU class of this machine.
//
// The script installs @huggingface/transformers 4.2.0 (the embedder before onnxruntime-node ran the
// model directly) into a scratch folder and embeds each text of
// test/fixtures/embedding-parity/cases.json as that embedder did: the first 2000 characters, mean
// pooling, normalization, one text per call. The output is
// test/fixtures/embedding-parity/vectors.<class>.json, with the CPU, the flags, the versions and
// the command. Usage: node scripts/parity-vectors.mjs [scratch folder]
import { execSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { cpus, tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { cpuFlags, GENERATOR_COMMAND, parityClass } from './cpu-class.mjs';

const TRANSFORMERS = '@huggingface/transformers@4.2.0';
const MODEL = 'Xenova/bge-small-en-v1.5';
const DTYPE = 'q8';
const MAX_CHARS = 2000;

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const fixtureDir = join(root, 'test', 'fixtures', 'embedding-parity');
const scratch = resolve(process.argv[2] ?? join(tmpdir(), 'episodic-memory-parity-vectors'));

const flags = cpuFlags();
const cls = parityClass(flags);
if (!cls) {
  process.stderr.write(`parity-vectors: no fixture class for CPU flags ${JSON.stringify(flags)}\n`);
  process.exit(1);
}

mkdirSync(scratch, { recursive: true });
writeFileSync(join(scratch, 'package.json'), '{"name":"parity-vectors-scratch","version":"1.0.0","private":true}\n');
// One fixed command string: npm is a .cmd shim on Windows, and a shim needs a shell.
execSync(`npm install --no-audit --no-fund ${TRANSFORMERS}`, { cwd: scratch, stdio: 'inherit' });

const version = name => JSON.parse(readFileSync(join(scratch, 'node_modules', ...name.split('/'), 'package.json'), 'utf-8')).version;
const { pipeline } = await import(pathToFileURL(createRequire(join(scratch, 'package.json')).resolve('@huggingface/transformers')).href);
const embed = await pipeline('feature-extraction', MODEL, { dtype: DTYPE, progress_callback: () => {} });

const { cases } = JSON.parse(readFileSync(join(fixtureDir, 'cases.json'), 'utf-8'));
const out = [];
for (const c of cases) {
  const tensor = await embed(c.text.substring(0, MAX_CHARS), { pooling: 'mean', normalize: true });
  out.push({ name: c.name, vector: Array.from(tensor.data) });
}

const file = join(fixtureDir, `vectors.${cls}.json`);
writeFileSync(file, JSON.stringify({
  class: cls,
  model: MODEL,
  dtype: DTYPE,
  cpu: (cpus()[0]?.model ?? 'unknown').trim(),
  flags,
  platform: `${process.platform}-${process.arch}`,
  node: process.version,
  transformers: version('@huggingface/transformers'),
  onnxruntimeNode: version('onnxruntime-node'),
  command: GENERATOR_COMMAND,
  cases: out,
}) + '\n');
process.stderr.write(`parity-vectors: wrote ${file} (${out.length} cases, class ${cls})\n`);
