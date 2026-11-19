---
name: wisprflow4agents
description: >-
  Wispr Flow notes, meetings and transcripts (recorded by Wispr Flow or its Notetaker). Use when the user asks about their Wispr Flow notes, Wispr meetings or Wispr transcripts ("any new Wispr notes?", "what did Wispr record from my last meeting?"), or asks to check, watch, summarize or monitor them. Wispr Flow cannot be read from memory or the repo: this skill says how to reach it through the plugin's `wispr` tool. Meetings recorded by other tools are outside this skill.
---

# Wispr Flow from Claude Code

You reach Wispr Flow only through the plugin's `wispr` tool. Do not try another way (no web requests, no scripts, no searching the disk for tokens or notes).

When the user's request is about Wispr Flow notes or meetings recorded by Wispr Flow:

1. If the user asked (typed in this session, or relayed by another Claude session on their behalf) to check, watch, stop watching, list watches or list folders, call the `wispr` tool with that verb and its args. Never call it on your own initiative.
2. Reading is limited to what this session watches: `check` reads only a scope this session has an armed watch on (no scope: every watched scope); a session with no watch reads nothing. When the user wants to read a folder this session does not watch, ask whether to watch it, then arm the watch with the tool.
3. Never tell the user to type a command for something they already asked for: carry it out with the tool, or say why the tool refused.
4. Do not guess at note contents or invent a summary. Work from the tool's result or a watch notice in this session.

## The tool's verbs

- `watch` `[all | folder name] [--every 5m] [--toast]`: arm a watch; this session is told when a note appears, changes, or is filed into or out of a folder.
- `unwatch` `[all | name]`: stop watches in this session.
- `watches`: this session's watches, last poll and errors.
- `folders`: folder names only, to resolve a folder the user described ("the folder with Standup in its name").
- `check` `[all | folder name] [--since 1d] [--transcript]`: what is new or changed; `--transcript` adds each meeting's full notes and transcript.

A watch the user asked for also covers checking its folders, reading their transcripts, listing watch status and re-arming it.

## Commands only the user runs

- `/wisprflow4agents:login`: sign in to Wispr once per machine (open the printed link and sign in; the login finishes by itself, or paste the address the browser ends on). You may run this one yourself when the user asks to sign in to Wispr: it only makes a link and reads no notes.
- `/wisprflow4agents:logout`: forget this machine's Wispr sign-in. Only the user runs it, by typing it.
- `/wisprflow4agents:check`, `watch`, `unwatch`, `watches`: the same verbs as slash commands the user types. A typed `check` may read any folder.

If the user has never signed in, `/wisprflow4agents:login` comes first.
