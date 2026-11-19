---
name: wisprflow4agents
description: >-
  Wispr Flow notes, meetings and transcripts (recorded by Wispr Flow or its Notetaker). Use when the user asks about their Wispr Flow notes, Wispr meetings or Wispr transcripts ("any new Wispr notes?", "what did Wispr record from my last meeting?"), or asks to check, watch, summarize or monitor them. Wispr Flow cannot be read from memory or the repo: this skill says which /wisprflow4agents:* skill fits and when you may invoke it. Meetings recorded by other tools are outside this skill.
---

# Wispr Flow from Claude Code

There is no Wispr tool, and you must not try to reach Wispr Flow another way (no web requests, no scripts, no searching the disk for tokens or notes). The user decides when their notes are read: a command runs when they type it, or when they ask for it in plain words in their own message ("watch my Standup folder in Wispr"). The plugin refuses any run they did not ask for.

When the user's request is about Wispr Flow notes or meetings recorded by Wispr Flow:

1. If this message of theirs asks to check, watch, stop watching or list watches, invoke the matching skill once (Skill tool, e.g. `wisprflow4agents:watch` with the folder name as args).
2. Otherwise do not invoke anything: name the one command that fits and ask them to type it or ask for it.
3. Do not guess at note contents or invent a summary. After a check runs, or a watch alert arrives, the result is a message in this session; work from that.

## Commands

- `/wisprflow4agents:login`: sign in to Wispr once per machine (open the printed link and sign in; the login finishes by itself, or paste the address the browser ends on). This is the one command you may run yourself, when the user asks to sign in to Wispr: it only makes a link and reads no notes.
- `/wisprflow4agents:logout`: forget this machine's Wispr sign-in. Only the user runs it, by typing it.
- `/wisprflow4agents:check [folder name | all] [--since 1d]`: read now what is new or changed and send it to this session.
- `/wisprflow4agents:watch [folder name | all] [--every 5m] [--toast]`: watch a folder or everything and tell this session when a note appears or changes.
- `/wisprflow4agents:unwatch [name | all]`: stop watches in this session.
- `/wisprflow4agents:watches`: list this session's watches, last poll and errors.

If the user has never signed in, `/wisprflow4agents:login` comes first.
