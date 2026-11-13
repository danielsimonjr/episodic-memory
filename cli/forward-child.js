import { spawn } from 'child_process';

/**
 * The exit code of a forwarding entry point for one child status.
 * A child that exits passes its code through. A child that a signal stops has no code.
 * The entry point then exits 1, as `cli/episodic-memory.js` does.
 * A caller reads exit 0 as success, so a stopped child must not give exit 0.
 */
export function exitCodeFor(code) {
  return code ?? 1;
}

/**
 * Run one Node script as a child with the same terminal. Exit with the status of the child.
 * When the child cannot start, print one line on stderr and exit 1.
 *
 * @param scriptPath - the script that the child runs
 * @param args - the arguments of the child; default: the arguments of this process
 * @param command - the executable that runs the script; default: the Node of this process
 */
export function forward(scriptPath, args = process.argv.slice(2), command = process.execPath) {
  const child = spawn(command, [scriptPath, ...args], { stdio: 'inherit' });
  child.on('error', error => {
    console.error(`episodic-memory: cannot start ${scriptPath}: ${error.message}`);
    process.exit(1);
  });
  child.on('exit', code => process.exit(exitCodeFor(code)));
}
