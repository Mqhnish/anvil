# Demo voiceover: three voices

For `output/video/anvil-demo.mp4` (3:24). Each line is timed to what is on screen. At a relaxed pace, about
two words a second, every line fits its slot with a little room. If you run long, cut words rather than speeding up.

| Voice | Covers | Time |
|---|---|---|
| Mohnish | Intro, Task A, per-hunk review, outro | 0:00-1:11, 3:17-3:24 |
| Arnav | Task B (agent mode), TrueForge session | 1:11-2:17 |
| Anay | Task C (outage), cancel and undo | 2:17-3:17 |

## Mohnish

**0:00-0:08 · intro card**
> Hi, we're team Tokenisers. This is Anvil, a coding agent inside VS Code, with its agent loop running on TrueForge.

**0:08-0:15 · Task A card**
> First, an inline edit. I select one Flask function and give a single instruction.

**0:16-0:22 · instruction typed, turn running**
> The selection and the instruction go to TrueForge as one turn, on Gemini Flash-Lite's free tier.

**0:22-0:28 · diff opens, accepted**
> The answer comes back as a diff, and nothing touches disk until I accept it.

**0:28-0:32 · verification**
> Running it: "off" and "N" now read as false, and "1" is still true.

**0:32-0:39 · per-hunk card**
> Now the same review, one hunk at a time. This edit touches two functions.

**0:39-0:49 · instruction, turn running**
> I select both functions and ask for the same change in each. TrueForge runs it exactly like before.

**0:49-1:00 · three hunks, decided one by one**
> It comes back as three hunks, each with its own Accept and Reject. I keep the first one, for get_debug_flag, and reject the other two.

**1:00-1:11 · verification**
> Then Finish review. The diff shows only the get_debug_flag lines landed. get_load_dotenv is exactly as it was.

## Arnav

**1:11-1:20 · Task B card**
> Now agent mode. The task is a new flask config command, with a test and docs, and it doesn't name a single file.

**1:20-1:33 · context pack on screen**
> The agent's first call is assemble_context. Six files, ranked, each with a reason, inside a four-thousand-token budget. cli.py didn't fit, and the pack says so, so the agent reads it next.

**1:33-1:55 · four reviews; the 429**
> Every change arrives as a diff for review: the command in cli.py, its test, a fix to cli.py, then the docs. Midway, the free tier rate-limits us. Anvil waits out the 429 and continues the same session without resending the task.

**1:55-2:06 · agent runs its tests, reports**
> It runs pytest on its own work through an approved command, then reports back.

**2:06-2:09 · verification**
> Three files, fifty-nine tests passing, secret key masked.

**2:09-2:17 · TrueForge session**
> Here's the same session in TrueForge: every tool call, the deferred call to assemble_context, and that rate limit.

## Anay

**2:17-2:24 · Task C card**
> Next, resilience. Same edit as Task A, but the primary model is down.

**2:25-2:36 · retry, then fallback**
> The primary is a provider that always answers 503. Anvil retries once, then reruns the turn on the fallback model without anyone clicking anything.

**2:36-2:41 · fallback's diff, rejected**
> Here's the fallback's diff. This time I reject it.

**2:41-2:46 · verification**
> Rejected means nothing changed. Git status is clean.

**2:46-2:53 · cancel and undo card**
> Last, control: cancelling mid-generation, and undoing after an apply.

**2:53-3:02 · Esc during generation**
> I start the edit and press Escape while the model is still working. The turn stops, and nothing was written.

**3:02-3:12 · run again, accept, undo**
> Run it again, accept the diff, then Undo Last Applied Change.

**3:12-3:17 · verification**
> helpers.py matches the original, byte for byte.

## Mohnish (outro)

**3:17-3:24 · outro card**
> That's Anvil. Every change gets reviewed before it lands, and the agent loop runs on TrueForge. The code is on GitHub. Thanks for watching.

## Recording

- Record each of your blocks as one file in a quiet room, phone close to your mouth: `vo-mohnish.m4a`, `vo-arnav.m4a`, `vo-anay.m4a`. Mohnish records the outro as a separate file, `vo-mohnish-outro.m4a`.
- Play the video muted while you read, and start each line when its time comes up. Exact sync isn't needed: within half a second is fine. The audio gets placed at each block's start time (0:00, 1:11, 2:17, 3:17) when it's mixed into the video.
- Say the names the way a developer would: "flask config", "pytest", "assemble context", "get debug flag".
