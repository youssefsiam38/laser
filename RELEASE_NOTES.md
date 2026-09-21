# Laser 0.12.0 — Model profiles

One idea replaces three. A **Model profile** is a list of models you name and order: the first is the one it prefers, the rest take over, in order, when that one stops answering. Everything that used to pick a model — new sessions, session naming, agents, the composer, onboarding — now picks a profile. Fallback chains, default-model settings and per-model thinking levels are gone as separate ideas; they became profiles.

## What you get

- **Settings → Providers and models → Model profiles.** Add, duplicate, rename, reorder, remove. Each profile shows who uses it. Deleting one that is in use asks you what should take its place, in the same dialog, so nothing is ever left pointing at a profile that no longer exists.
- **Three to start with.** Smart, Balanced and Fast are seeded from the models you have connected. They are ordinary profiles: edit them, rename them, delete them.
- **Assignments.** New sessions start on your default profile; titles are written on the naming profile; consultation and design work have their own. All four are pickers in Settings.
- **The composer control shows two lines:** the profile, and beneath it the model actually answering right now. Pick a profile to re-anchor the conversation; pick a single model to pin it — the control says "Pinned · no fallback" and means it.
- **When a profile moves a conversation** to its next model you see "Moved to …" in the transcript and in the status line, with the reason. A profile never moves to a model outside itself.
- **Agents choose a profile** in their file (`profile:`), or inherit your default. A file that names a profile that no longer exists still runs, on the default, and the fleet row shows the substitution.
- **Onboarding** connects a provider, shows the three seeded profiles pre-filled from what just connected, and goes on to your first project. You can edit them or skip.
- **Fleet, session list, logs and usage** show the profile as what was intended and the model as what answered. A captured request in the logs inspector names the profile it ran on.
- `laser doctor` checks every model of every profile and names the profile in its report; `laser runs` and `laser session` print both.

## Migration

The first start after updating rewrites your settings once, through the app, and writes a preview record of what it did into the app's state directory:

- each fallback chain becomes a profile named after its first model ("Sonnet 4.5 profile"), which you can rename;
- your default model becomes the default profile — the profile that starts with it, or a new "Default" profile holding just that model;
- default and per-model thinking levels fold into the matching profile entries;
- the models you chose for Beam, Chat and the namer become their profile choices;
- agent files that said `model: provider/id` are rewritten to `profile:`, once, and the record lists each file.

The old settings keys are left in place for one release, so going back to 0.11 reads them unchanged. Conversations from before this release keep the model and thinking level they had and show as pinned; they are not moved onto a profile behind your back.

## Also

- The product's own copy never says "chain" or "tier" any more, and a check in the build keeps it that way.
