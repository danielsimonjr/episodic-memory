/**
 * The seeded generator of the learn feature. Imports nothing.
 *
 * `tasks.ts` splits the tasks of a project with the generator. `validate.ts` picks the validation sample with the generator.
 * The same seed must give the same split and the same sample on every platform and Node version.
 */
/**
 * Return a generator of numbers in [0, 1) for `seed` (mulberry32).
 * The function folds `seed` into 32 bits, so -1 and 4294967295 give the same sequence.
 *
 * @example
 * const next = mulberry32(42);
 * next(); // 0.6011037519201636, on every platform
 */
export function mulberry32(seed) {
    let state = seed >>> 0;
    return () => {
        state = (state + 0x6d2b79f5) >>> 0;
        let t = state;
        t = Math.imul(t ^ (t >>> 15), t | 1);
        t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
        return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
}
