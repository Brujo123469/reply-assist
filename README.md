# Reply Assist for MemoMind One

Live conversation help on smart glasses. When someone speaks to you in
another language, the glasses show what they said, translated, plus three
short replies you can say back. Say one out loud and it's picked. No tapping,
no ring, no looking down at a phone.

```
┌──────────────────────────────────────────────┐
│ Are you staying in the city long?            │  their words, translated
├──────────────────────────────────────────────┤
│ Solo unos días                               │
│ just a few days                              │
├──────────────────────────────────────────────┤
│ Hasta el viernes                             │  say any one of these
│ until Friday                                 │
├──────────────────────────────────────────────┤
│ ¿Por qué lo pregunta?                        │
│ why do you ask?                              │
└──────────────────────────────────────────────┘
```

**Status:** working prototype, a MemoMind One web plugin built on MemoMind's
[plugin-open-platform](https://github.com/memomind-open/plugin-open-platform)
SDK. Tested end to end in MemoMind's Desktop Studio and Browser Studio. I
have the glasses; on-glasses testing is waiting on developer access.

## What it does

- **Translate and reply.** Their words appear live as they speak, then the
  translation and three replies that differ in intent (answer, decline, ask
  back).
- **Pick by voice.** Saying a reply selects it. The other options make way,
  and the words you've said dim as you go, even if you pause midway.
- **Say it in English.** None of the replies fit? Double-press, say it in
  your own words, and read out the translation.
- **Any script, with pronunciation.** Japanese, Arabic, Chinese, Korean and
  more are shown in their own writing with an easy pronunciation underneath.
  An optional learning mode shows the original, the pronunciation and the
  meaning on separate lines.
- **Phrasebook first.** Common questions are answered instantly from a saved
  phrasebook, with no AI call; the AI is only asked when something new comes
  up, and useful answers are kept for next time.
- **Q&A assist.** For presentations and interviews in your own language:
  likely questions are prepared from your notes, with answer points ready.
- **Built for the glasses.** Bluetooth to the glasses is the bottleneck, so
  the display either sends plain text for the glasses' own font, or draws on
  the phone and sends compressed images of only the areas that changed (any
  script, text sized to fit, word highlighting). Layouts: stacked, or
  question left and replies right.

## How it works

```
glasses mic ─▶ phone plugin ─▶ live speech to text
                    │
      one of the replies on screen? ── yes ─▶ picked, it stays up as you say it
                    │ no
      in the phrasebook?            ── yes ─▶ translation + 3 replies instantly
                    │ no
                    ▼
              AI (streamed) ─▶ translation + 3 replies on the glasses
```

Built with MemoMind's PhoneSDK (web plugin, display and audio bridge),
streaming speech to text, and Claude for translation and replies.

## In this repository

- `plugin/`: the web plugin (phone page, conversation logic, glasses display).
- `test/`: unit tests for the conversation flow, matching, phrasebook,
  display layout and compression.

MemoMind's SDK files aren't included; their terms don't allow republishing
them. Setup and deployment details aren't public yet.

## Privacy and consent

Audio is streamed for live transcription and not recorded. The other person
is being transcribed, and the rules for that vary by place: tell people
you're using live translation glasses.

## License

Copyright (c) 2026 Khai Muse. All rights reserved; see [LICENSE](LICENSE).
The code is public to read and review, not to reuse. The bundled fonts in
`plugin/fonts/` (Space Grotesk, JetBrains Mono) are under the SIL Open Font
License 1.1.
