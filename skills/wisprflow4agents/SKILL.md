---
name: wisprflow4agents
description: >-
  Wispr Flow notes, meetings and transcripts (recorded by Wispr Flow or its Notetaker). Use when the user asks about their Wispr Flow notes, Wispr meetings or Wispr transcripts ("any new Wispr notes?", "what did Wispr record from my last meeting?"), or asks to check, watch, summarize or monitor them. Wispr Flow cannot be read from memory or the repo: this skill says which /wisprflow4agents:* command the user must type. Meetings recorded by other tools are outside this skill.
---

# Wispr Flow from Claude Code

You have no access to Wispr Flow. There is no Wispr tool, and you must not try to reach it another way (no web requests, no scripts, no searching the disk for tokens or notes). Only the user can read Wispr, by typing a slash command. Typed commands are the only way in because the user decides when their notes are read; a command you suggest does not run until they type it.

When the user's request is about Wispr Flow notes or meetings recorded by Wispr Flow:

1. Say plainly that you cannot read Wispr yourself.
2. Name the one command that fits and ask them to type it.
3. Do not guess at note contents or invent a summary. After they run /wisprflow4agents:check, or a watch alert arrives, the result is a message in this session; work from that.

## Commands the user can type

- `/wisprflow4agents:login`: sign in to Wispr once per machine (open the printed link and sign in; the login finishes by itself, or paste the address the browser ends on). This is the one command you may run yourself, when the user asks to sign in to Wispr: it only makes a link and reads no notes.
- `/wisprflow4agents:logout`: forget this machine's Wispr sign-in.
- `/wisprflow4agents:check [folder name | all] [--since 1d]`: read now what is new or changed and send it to this session.
- `/wisprflow4agents:watch [folder name | all] [--every 5m] [--toast]`: watch a folder or everything and tell this session when a note appears or changes.
- `/wisprflow4agents:unwatch [name | all]`: stop watches in this session.
- `/wisprflow4agents:watches`: list this session's watches, last poll and errors.

If the user has never signed in, `/wisprflow4agents:login` comes first.
