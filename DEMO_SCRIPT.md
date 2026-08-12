# Olex - demo video script

A ~3 minute recording plan. Every number and every line of tool output below was
captured from a real run against the live chain - testnet unless a block says
mainnet - not written by hand. Block heights and proof targets change, so
re-read anything time-sensitive off your own screen rather than reciting the
figures here.

**Before you record, check the hackathon's required video length and trim to fit.**
A full run including the network switch is ~3:10. Dropping section 5 (view keys)
gets you to ~2:40; dropping sections 5 and 6 gets you to ~2:20. Keep the switch -
it is ten seconds and it closes a question judges will otherwise ask.

---

## Setup checklist

Do all of this before hitting record.

- [ ] `npm run build` - clean
- [ ] `npm run smoke` - passes (proves the network is reachable right now)
- [ ] If you plan to show the network switch, open the dashboard and click to
      Mainnet once before recording. The first mainnet call is cold and can take
      ~19s; the second is fast. Warming it is the difference between a crisp cut
      and twenty seconds of dead air.
- [ ] Editor font at 16pt or larger. Judges watch on laptops, sometimes phones.
- [ ] Dark theme on both editor and the Olex site, so the cuts don't flash white.
- [ ] Close Slack, mail, notifications. A popup mid-demo costs you a retake.
- [ ] Browser zoom ~110% on the dashboard, window at 1440px wide.
- [ ] Have `credits.aleo` ready to paste - don't type long strings on camera.
- [ ] Record at 1080p minimum. 1440p if your machine allows.
- [ ] **Do a 20-second test recording and play it back.** Check the mic actually
      captured audio. This is the single most common way a demo video is lost.

One judgment call worth making up front: record the screen and audio in one
pass, or narrate over silent screen capture afterwards? Narrating afterwards is
far more forgiving - you can redo a sentence without redoing the demo. Recommended
unless you're comfortable on camera.

---

## Section 1 - The problem (0:00 - 0:25)

**Screen:** Your editor, Olex not yet connected. Or a plain title card reading
"Olex - AI agents meet Aleo".

**Say:**

> Aleo is a privacy blockchain. Every value in a program is either public -
> readable by anyone - or private, encrypted so only the key holder can see it.
>
> That distinction is the whole point of Aleo. And it's the one thing that's
> genuinely hard to check. To find out what a program actually exposes, you read
> its compiled instructions, parameter by parameter, and reason about visibility
> yourself.
>
> I wanted to just ask.

**Why this open:** it states the problem in the domain's own terms before naming
the product. Judges see a lot of demos that open with "Introducing X" and never
establish why X should exist.

---

## Section 2 - What Olex is (0:25 - 0:45)

**Screen:** Open on the landing page so the live block height is ticking, then
click through to `/tools` and scroll slowly so the 13 cards register. Stop on the
view-key group - it is the one the next line is about.

**Say:**

> Olex is a Model Context Protocol server for Aleo. It gives any MCP client -
> Claude Code, Cursor, VS Code, Zed - thirteen tools for reading the chain and
> reasoning about privacy.
>
> It's not a wrapper around a block explorer. Three of these tools answer
> questions an explorer structurally cannot.

**Shot note:** Don't read the tool names aloud. The cards are on screen; let them
do the work while you talk about what the set means.

---

## Section 3 - Live chain, from the editor (0:45 - 1:20)

**Screen:** Your editor with Olex connected. Type the question live.

**Prompt to type:**

```
What's the latest Aleo block height?
```

**Real output shape** (your height will differ - read yours off the screen):

```
**Aleo testnet - online**

- Latest block: **18,584,250**
- Block hash: `ab1n99evy62p5tdqe9lxvqsxgfe8l5yluskc895ekknytq6wenacg9suzm4yt`
- Round: 38,449,204
- Block time: 2026-08-09T07:40:54Z
- Proof target: 134,217,728
- Transactions in block: 0
```

**Say:**

> This is live testnet, right now. The assistant called `olex_network_status`
> and got real chain state - no mock, no cached fixture.

**Then, without a cut, ask the second question:**

```
What's the public balance of aleo1rhgdu77hgyqd3xjj8ucu3jj9r2krwz6mnzyd80gncr5fxcwlh5rsvzp9px?
```

**Say, over the result:**

> And note what it says about that number: it's a floor, not a total. This
> address holds about half a credit publicly - but it could hold any amount in
> private records, and nobody can tell without the view key. Every balance tool
> in Olex says so, so the assistant reports a floor instead of a misleading
> total.

**Accuracy note:** at capture time this address returned **0.538849 credits**
public. It is a live value and may differ when you record - read what's on your
screen. Don't say "zero"; this address is not empty.

**Why this beat matters:** it's a small detail that signals you understand the
chain rather than just calling its API. Judges notice that.

---

## Section 3b - the network switch (1:20 - 1:30)

Record this immediately after section 3, while the dashboard and live chain
state are already on screen. That adjacency is what makes it a ten-second beat
instead of a scene change.

Not optional any more. Both networks are live and verified, and "does this only
work on testnet?" is a question a judge will otherwise carry to the end of the
video. Ten seconds spent here is cheaper than leaving it open.

Budget note: this is what pushes a full run to ~3:10. If you are capped at 3:00,
take the ten seconds out of section 5, which is the most compressible - the
view-key boundary survives being stated in two sentences instead of three.

**Screen:** The dashboard. Click the network switch from Testnet to Mainnet and
let the height repaint.

**Say:**

> Same tools, either network. Testnet is the default deliberately - pointing an
> autonomous agent at mainnet should be a decision, not a drift.

**Real captured mainnet output**, for reference - read your own screen, this
moves:

```
**Aleo mainnet - online**
- Latest block: **20,964,402**
- Round: 42,391,480
- Proof target: 22,363,118,239,313
```

**Accuracy note:** mainnet's first call can be slow - one cold request took
**19.3 seconds**, above the 15-second default timeout. Set
`OLEX_TIMEOUT_MS=45000` before recording, and warm the switch once so the demo
call hits a warm path.

**Shot note:** the dashboard tile shows this as `22.36T` with the exact figure on
the line beneath. That is deliberate - fourteen digits overflow the tile at every
width - so don't read the headline as the whole number. The full figure is right
there under it, and the tool output in your editor always prints it in full.

---

## Section 4 - The part no explorer can do (1:30 - 2:20)

This is your strongest section. Give it room and do not rush it.

**Screen:** Editor. Ask for the privacy analysis.

**Prompt to type:**

```
What does credits.aleo's transfer_public expose? Compare it to transfer_private.
```

**Real captured output - `transfer_public`:**

```
`transfer_public` - PUBLIC, PUBLIC
    in  r0: `address.public` → PUBLIC
    in  r1: `u64.public` → PUBLIC
    out r2: `credits.aleo/transfer_public.future` → public (finalize)
    ⚠ writes public mapping state: `account`
    · reads public mapping state
```

**Real captured output - `transfer_private`:**

```
`transfer_private` - private (record), private, private
    in  r0: `credits.record` → private (record)
    in  r1: `address.private` → private
    in  r2: `u64.private` → private
    out r4: `credits.record` → private (record)
    out r5: `credits.record` → private (record)
```

**Say:**

> Same program. Two functions. Completely different privacy.
>
> `transfer_public` puts the recipient and the amount on-chain in the clear, and
> writes to a public mapping - that's the warning line. Anyone can read both
> values forever.
>
> `transfer_private` takes a record in and produces records out. The recipient
> and the amount are encrypted. Nobody sees them without the view key.
>
> This is static analysis of the deployed instructions - it needs no keys at all.
> And it reports per parameter, never per program, because there's no such thing
> as a "private program" on Aleo. A single transition routinely takes a private
> amount and a public recipient. A program-level verdict would be wrong on almost
> every real program.

**Pause for a full second after "wrong on almost every real program."** It's the
sharpest claim in the video and it needs air.

**Optional, if you have time:** ask
`What did transaction at1fv877phzw8hwmaguyhlar7gk364vu6ychecgnafdzv8xgaqlwqrqm9m73w reveal?`
to show `olex_explain_transaction_privacy` walking a real landed transaction.

---

## Section 5 - View keys and the security boundary (2:20 - 2:50)

**Screen:** Split or cut between the docs page "Surfaces" section and your editor.

**Say:**

> Three tools go further and read private state with a view key. A view key
> decrypts records you own. It cannot move funds, and Olex has no tool that
> accepts a private key at all.
>
> Those three tools only exist over stdio, on your own machine. The hosted
> version of Olex doesn't disable them - it never registers them. The web bridge
> imports a server factory that doesn't import the view-key module, so the
> cryptography isn't in that bundle. It's enforced by construction, not by a
> runtime check, because a runtime check is one bad edit away from being wrong.

**Why include this:** it's an architecture decision with a stated rationale.
That reads as engineering maturity, which is exactly what separates a hackathon
project from a weekend script.

---

## Section 6 - Close (2:50 - 3:10)

**Screen:** The dashboard, live block height ticking. Or the GitHub repo page.

**Say:**

> Everything you just saw runs against the live chain - testnet and mainnet
> both - and is covered by an end-to-end smoke suite: real JSON-RPC over stdio,
> no mocks.
>
> Olex is MIT licensed and installs into any MCP client. It's the bridge between
> AI agents and Aleo's privacy model.

**End card, on screen for the last 3 seconds:**

```
Olex
github.com/Ritapossible/Olex
MCP server for Aleo - 13 tools, MIT
```

---

## Things to avoid

- **Don't say "production ready."** Say what's true: verified against live
  testnet and mainnet, covered by smoke tests.
- **Don't claim you've deployed anything to mainnet.** Reading mainnet and
  writing to it are different claims. Olex only reads.
- **Don't demo Leo compile / deploy / execute.** Those are blocked on the Leo
  CLI and are marked as such in the README. Demoing a gap invites a question you
  can't answer well.
- **Don't type a real view key on camera**, even a throwaway. If you demo the
  view-key tools, have it in an env var already set before recording starts.
- **Don't read the tool catalog aloud.** It's on screen and it's boring narrated.

---

## If you only have 90 seconds

Cut to: Section 1 (shortened to two sentences) → Section 4 → Section 6.

The `transfer_public` vs `transfer_private` contrast is the whole pitch. If a
judge watches only one thing, make it that.
