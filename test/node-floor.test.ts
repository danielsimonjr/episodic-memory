import { describe, it, expect } from 'vitest';
import { NODE_FLOOR, assertNodeFloor } from '../src/node-floor.js';

// better-sqlite3 13 declares Node >= 22. `engines` is advisory only: npm warns and continues, so a
// machine on Node 20 starts the wrapper, installs 200 packages and then dies inside a dependency
// with a syntax/runtime error that names nothing useful. The floor is therefore checked in the entry
// points themselves, through this dependency-free helper.
//
// The helper takes the version as an ARGUMENT so these tests never touch process.versions.node:
// stubbing it on a live process proves nothing about a child process, and the wrappers load this
// module before anything else.
describe('assertNodeFloor', () => {
  it('names the floor for a version below it', () => {
    const message = assertNodeFloor('20.0.0');
    expect(message).not.toBeNull();
    expect(message).toContain(NODE_FLOOR);
  });

  it('passes the floor itself', () => {
    expect(assertNodeFloor('22.0.0')).toBeNull();
  });

  it('passes anything above the floor', () => {
    expect(assertNodeFloor('22.0.1')).toBeNull();
    expect(assertNodeFloor('22.12.0')).toBeNull();
    expect(assertNodeFloor('23.0.0')).toBeNull();
    expect(assertNodeFloor('24.7.0')).toBeNull();
  });

  it('fails just below the floor on either component', () => {
    expect(assertNodeFloor('21.99.99')).not.toBeNull();
    expect(assertNodeFloor('20.19.0')).not.toBeNull();
  });

  it('reads the version Node actually reports when no argument is given', () => {
    // The suite runs on a supported Node (CI is 24); this is the only place the default is used.
    expect(assertNodeFloor()).toBeNull();
  });

  it('fails closed on a version string it cannot parse', () => {
    expect(assertNodeFloor('not-a-version')).not.toBeNull();
  });
});
