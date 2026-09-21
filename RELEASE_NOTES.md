# Laser 0.13.0 — a plain Chat

Chat is a conversation again, not an assistant with a persona. Three built-in agents — Beam, Chat and the namer — are gone, and what they did is now done by the app itself.

## Chat

- A Chat is a plain conversation: no hidden role, no product name in its instructions, no project. Its system prompt is exactly the tools available, the tool guidelines and your discovered skills — nothing else.
- Three ways in, all the same: the **+** in the Chat tab, **New chat** in the command palette, and a new shortcut, **Ctrl/⌘+Shift+N**. Each opens an empty conversation with the cursor in the composer.
- A Chat runs on your default profile and can be re-anchored or pinned like any conversation. Moving it to a project works as before.

## Naming

- Conversations are still named from their first message. Naming is now one short request on your **naming profile** (Settings → Providers and models), with a hard time limit and no benchmark, no qualification, no editable prompt. If it cannot answer, the conversation simply keeps the name you gave it or none.
- If you had chosen a model for the namer before, the update keeps naming on that model: it becomes the naming profile.

## Beam is gone

The floating launcher, its bubble, its model dialog, its sidebar group and its mark are removed. Everything you said in a Beam conversation is kept: those conversations now appear in the Chat tab, open where they always lived, and nothing on disk is moved or rewritten.

## Agents page

The Agents page lists only agents you wrote. With none, it tells you how to write one. Agent files that allowed `beam`, `chat` or `namer` as sub-agents still load, with a note on that field, and run with the name dropped.

## Also

- Sessions from before this release open unchanged; their stored records are read, never rewritten.
- The app's copy never names Beam or the namer any more, and a build check keeps it that way.
