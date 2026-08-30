#!/usr/bin/env node
import { spawnSync } from 'child_process';
import fs from 'fs';
import path from 'path';
import { buildCodexDoctorReport, buildDoctorReport, collectDoctorSnapshot } from './doctor.js';
import { getCodexDir, getDbPath } from './paths.js';
import { getSyncLogPath } from './logging.js';
import { detectCodexHookTrustState } from './codex-hook-trust.js';
function capture(command, args) {
    const result = spawnSync(command, args, {
        encoding: 'utf-8',
        timeout: 10000,
    });
    return `${result.stdout || ''}${result.stderr || ''}`.trim();
}
function showHelp() {
    console.log(`Usage: episodic-memory doctor [--json]
       episodic-memory doctor codex [--json]

Diagnose the local plugin, archive, index, hook, and (with "codex") Codex integration.`);
}
async function main() {
    const args = process.argv.slice(2);
    const json = args.includes('--json');
    const rest = args.filter((arg) => arg !== '--json');
    const target = rest[0];
    if (target === '--help' || target === '-h') {
        showHelp();
        process.exit(0);
    }
    if (target === 'codex') {
        const codexHome = getCodexDir();
        const hookTrustState = await detectCodexHookTrustState(codexHome, process.cwd());
        const report = buildCodexDoctorReport({
            codexVersionOutput: capture('codex', ['--version']),
            featuresOutput: capture('codex', ['features', 'list']),
            mcpListOutput: capture('codex', ['mcp', 'list']),
            codexHome,
            sessionsDirExists: fs.existsSync(path.join(codexHome, 'sessions')),
            logPath: getSyncLogPath(),
            dbPath: getDbPath(),
            hookTrustState,
        });
        if (json) {
            process.stdout.write(JSON.stringify({
                ok: report.ok,
                text: report.text,
            }, null, 2) + '\n');
        }
        else {
            process.stdout.write(report.text);
        }
        process.exit(report.ok ? 0 : 1);
    }
    if (target) {
        showHelp();
        process.exit(1);
    }
    const report = buildDoctorReport(collectDoctorSnapshot());
    if (json) {
        process.stdout.write(JSON.stringify(report.json, null, 2) + '\n');
    }
    else {
        process.stdout.write(report.text);
    }
    process.exit(report.ok ? 0 : 1);
}
main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exit(1);
});
