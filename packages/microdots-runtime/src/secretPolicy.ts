/**
 * The attempt policy a person-facing secret gate enforces, and the one sentence
 * that states it to a person.
 *
 * Kept apart from `./secret.ts`, which holds the gate itself, so a browser
 * bundle can show the sentence without importing the gate. A MicroDot front
 * imports it from the bare `@bespokeagentics/microdots-runtime` entry, never
 * from `/secret`: every dot's `vite.config.ts` aliases the bare specifier to
 * `src/index.ts`, and the subpath under that match resolves to
 * `.../src/index.ts/secret`, which fails the build.
 */

/**
 * How many wrong candidates a person-facing gate takes inside a window, and how
 * long it then refuses everything.
 *
 * A PIN gate on a public origin is a guessing oracle unless something slows the
 * guesser down: a six-digit PIN is a million candidates, and a wrong answer
 * used to come back as fast as the right one, forever. Ten wrong candidates
 * within fifteen minutes buy a fifteen-minute pause, so one gate answers at
 * most about 40 wrong guesses an hour.
 *
 * A RIGHT candidate neither counts nor clears the count. It used to clear it,
 * and an unlocked owner dashboard re-sends the right PIN every two seconds, so
 * a guesser who fit nine wrong guesses between two of those polls never started
 * a pause at all. The window is what lets an owner's occasional typo age out
 * instead.
 *
 * During a pause EVERY candidate is refused, the right one too, or the pause
 * would only slow wrong guesses down. Attempts made during a pause neither
 * count nor extend it, so the gate reopens fifteen minutes after the failure
 * that started the pause, however hard it is hammered meanwhile, and the count
 * starts again from zero. Someone who keeps guessing can start a new pause each
 * time one ends, and the owner is refused with them: the gate sees a candidate,
 * never who sent it. The count lives in the process that built the gate, so a
 * restart clears it (the exit the refusal names for that case), and a Worker,
 * which builds its layers per request, gets no pause at all.
 *
 * `secretRefusalSentence` states these numbers to a person, so it reads them
 * from here.
 */
export type SecretAttemptPolicy = {
  readonly failuresBeforePause: number
  readonly failureWindowMillis: number
  readonly pauseMillis: number
}

export const SECRET_ATTEMPT_POLICY: SecretAttemptPolicy = {
  failuresBeforePause: 10,
  failureWindowMillis: 15 * 60 * 1000,
  pauseMillis: 15 * 60 * 1000,
}

/**
 * The refusal a person reads when a gate refuses a secret they typed.
 *
 * One sentence for every refusal (a wrong secret, a near miss, a paused gate)
 * because the gate's answer is the same `false` for all three. It names the
 * exit for each without saying which applies: check and retry, wait out a
 * pause, or restart the service when someone keeps starting new pauses. It says
 * the pause can be someone else's doing, because on a public origin it can.
 * ASCII only, so a compiled panel carries it byte for byte.
 */
export const secretRefusalSentence = (noun: string): string => {
  const failures = SECRET_ATTEMPT_POLICY.failuresBeforePause.toString()
  const window = Math.ceil(
    SECRET_ATTEMPT_POLICY.failureWindowMillis / 60_000,
  ).toString()
  const minutes = Math.ceil(SECRET_ATTEMPT_POLICY.pauseMillis / 60_000).toString()
  return `That ${noun} was not accepted. Check it and try again. If it is right, wait ${minutes} minutes or restart the service: after ${failures} failed tries within ${window} minutes, from anyone, every ${noun} is refused for ${minutes} minutes.`
}
