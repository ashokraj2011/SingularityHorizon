/**
 * Minimal `electron` stand-in for tests that exercise main-process modules
 * outside an Electron runtime. Aliased in at build time; never shipped.
 *
 * Only what the modules under test actually touch is implemented — anything
 * else should fail loudly rather than silently returning undefined and letting
 * a test pass for the wrong reason.
 */
export const app = {
  getPath(name: string): string {
    const dir = process.env.EH_TEST_USERDATA
    if (!dir) throw new Error('EH_TEST_USERDATA is not set; refusing to guess a real user path')
    if (name !== 'userData') throw new Error(`electron stub: unhandled getPath(${name})`)
    return dir
  }
}
