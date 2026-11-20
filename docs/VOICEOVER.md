# Demo voiceover: three voices

For `output/video/anvil-demo.mp4` (3:59). Each line is timed to what is on screen. At a relaxed pace, about
two words a second, every line fits its slot with a little room. If you run long, cut words rather than speeding up.

| Voice | Covers | Time |
|---|---|---|
| Mohnish | Intro, Task A, per-hunk review, outro | 0:00-1:10, 3:52-3:59 |
| Arnav | Task B (agent mode), TrueForge session | 1:10-2:46 |
| Anay | Task C (outage), cancel and undo | 2:46-3:51 |

## Mohnish

**0:00-0:08 · intro card, Task A card**
> Hi, we're team Tokenisers. This is Anvil, a coding agent in VS Code. Its agent loop runs on TrueForge.

**0:08-0:15 · instruction typed**
> First, an inline edit. I select one Flask function and give it a single instruction.

**0:15-0:21 · turn running (2×)**
> That goes to TrueForge as one turn, on MiniMax through NVIDIA's free API.

**0:21-0:29 · diff opens, accepted**
> It comes back as a diff. Nothing touches disk until I accept it.

**0:29-0:36 · verification**
> Running it: "off" and "N" now read as false, and "1" is still true.

**0:36-0:46 · two functions selected, turn running (4×)**
> Now the same review, one hunk at a time. I select two functions and ask for the change in both.

**0:46-1:01 · three hunks decided one by one**
> Three hunks, each with its own Accept and Reject. I keep the first, for get_debug_flag, and reject the other two.

**1:01-1:10 · verification**
> Only the get_debug_flag lines landed. get_load_dotenv is exactly as it was.

## Arnav

**1:10-1:19 · Task B card, instruction typed**
> Now agent mode. A new flask config command, with a test and docs. The task doesn't name a single file.

**1:19-1:27 · context pack, zoomed**
> The first thing it gets is a context pack: four files ranked from a hundred and twenty-eight, each with a reason, inside a four-thousand-token budget.

**1:27-1:43 · agent reads Flask (20×)**
> Then it searches and reads on its own through MCP tools. When the free API rate-limits it, Anvil waits and carries on in the same session.

**1:43-1:57 · four reviews (5×)**
> Four files: the command, its test, and two docs pages. Each one arrives as a diff to review.

**1:57-2:13 · tool loaded on demand, Allow**
> To run tests, it loads the command tool on demand, then asks to run pytest. Commands always wait for approval.

**2:13-2:31 · done, verification**
> Done. Four files changed, sixty-two tests passing, the secret key masked, and config listed in flask help.

**2:31-2:46 · TrueForge session**
> Here's the same session in TrueForge: the context pack, every tool call, the rate limit, and the final report.

## Anay

**2:46-2:55 · Task C card, instruction typed**
> Next, resilience. Same edit as Task A, but the primary model is offline.

**2:55-3:02 · fallback notice**
> The primary fails, so Anvil reruns the turn on the fallback model. Nobody clicks anything.

**3:02-3:15 · fallback's diff rejected, verification**
> Here's the fallback's diff. This time I reject it, and git status stays clean.

**3:15-3:27 · cancel and undo card, Esc**
> Last, control. I start the edit and press Escape mid-generation. The turn stops, and nothing was written.

**3:27-3:39 · run again (10×)**
> Then I run it again and let it finish.

**3:39-3:51 · accept, undo, verification** (finish by 3:51; the outro voice starts at 3:52)
> I accept the diff, then Undo Last Applied Change. helpers.py matches the original, byte for byte.

## Mohnish (outro)

**3:52-3:59 · end of Task D, outro card**
> That's Anvil. Every change is reviewed before it lands. The code's on GitHub. Thanks for watching.

## Recording

- Record each of your blocks as one file in a quiet room, with your phone close to your mouth: `vo-mohnish.m4a`, `vo-arnav.m4a`, `vo-anay.m4a`. Mohnish records the outro as a separate file, `vo-mohnish-outro.m4a`.
- Read at your own pace with a short pause between lines. `tmp/film/mix.py` cuts each recording at those pauses and places every sentence at its slot, so a fast read gets its gaps back and sync doesn't depend on timing yourself to the video.
- The voiced cut is `output/video/anvil-demo-vo.mp4`; `anvil-demo.mp4` stays silent.
- Say the names the way a developer would: "flask config", "pytest", "get debug flag", "MiniMax".
