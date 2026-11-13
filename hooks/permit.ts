// Typed-only skills: `skill.prompt` carries no origin, so the `prompt.submit` of a typed
// `/<skill> <args>` grants a permit that the `skill.prompt` right after it takes (measured: about
// 80 ms later, also for a command typed mid-turn, whose `prompt.submit` fires when it is dequeued).
// One permit per skill, the latest typed run's; it lives `ttl` ms, so a typed run whose render never
// came (dropped below this plugin, withdrawn) cannot hand its args to a later run or an untyped render.

export function permits(now: () => number, ttl: number) {
  const held = new Map<string, { args: string; at: number }>()
  return {
    grant: (skill: string, args: string) => void held.set(skill, { args, at: now() }),
    revoke: (skill: string) => void held.delete(skill),
    /** The args of a typed run of `skill` not yet answered, or undefined when the person did not type it. */
    take(skill: string): string | undefined {
      const p = held.get(skill)
      held.delete(skill)
      return p && now() - p.at <= ttl ? p.args : undefined
    },
  }
}
