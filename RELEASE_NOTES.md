# Laser 0.9.1

A repair release. Everything here came from using Laser for real work and finding it wanting.

## The conversation follows you again

If you were sitting at the bottom of a conversation, new work did not always scroll into view. The cause was small and unkind: nudging the wheel or tapping at the very bottom — where nothing can scroll — was treated as *you walking away*, and nothing ever brought the view back. One dead wheel notch and the conversation quietly left you 2,000 pixels behind for the rest of the session.

Now the live edge is decided by where the view actually is, not by what your fingers did. Anything that arrives while you are at the bottom keeps you there: the agent's reply, a message from a child agent, a result appearing inside an actions group you already opened, a row that grows as an image or a diff finishes rendering. Scroll away deliberately — wheel, touch, keyboard or the scrollbar, even in the middle of a streaming answer — and your place is kept exactly.

## Goals no longer pause themselves

A long autonomous goal could stop overnight with no explanation. It was not the agent deciding to stop: any interrupted request — a cancelled turn, a provider hiccup, a child agent ending badly — was being read as an instruction to pause the whole goal. On top of that, an inherited safety limit paused goals after 25 automatic turns.

Now only a real decision stops a goal. An interruption cancels that one step and the goal stays active, and Laser's own limits are off by default, so long autonomous work runs as long as the work takes. Every stop that was not the agent's own choice records what caused it, so the next one explains itself.

## Mentioning a file looks like a path

Picking a file or folder with `@` used to insert `:directory[/home/you/projects/thing/]`. It now inserts `@./server/index.ts` — what you would have typed. Package names and handles in ordinary prose (`@lasercode/protocol`) stay as written, and conversations saved before this release still render their file links.

## The transcript behaves like a web page

Double-click selects a word, triple-click selects a block, right-click opens the menu your browser or system actually provides — including spelling suggestions and Look Up. The composer spellchecks like any text box you type in. Quoting is now a "Quote selection" item in a message's menu, so it works with touch as well as a keyboard shortcut (Ctrl/Cmd+Shift+9).

## Actions say what they were doing

The short line an agent writes for each thing it does now titles the row wherever it appears — while it runs and after it finishes, on its own and inside a group of actions. A finished group reads as a list of intentions instead of eighteen truncated shell commands, with the exact command a line below, still searchable. Search now highlights those lines correctly, in live conversations and in saved history.

## Agents get names people can read

An agent naming its helper now writes "Mention format" rather than `mention-format`. Names recorded before this release read that way too, everywhere they appear.

## Fallback chains work with agent-chosen models

If a model came from the agent you picked rather than from the model selector, its fallback chain never activated, so a provider outage ended the turn instead of moving to the next model. Chains now follow the model the conversation is actually on, whoever chose it.
