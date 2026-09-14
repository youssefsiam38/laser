## Conversations stay under your control

### Fixed in 0.6.4

- Repeated wheel, trackpad and touch scrolling is no longer undone by transcript layout updates. Earlier pages still arrive above the section you are reading without moving it.
- Sending from earlier history now returns to the new prompt and follows its streamed answer. Scrolling away while it runs still wins.
- A finished or failed context compaction now leaves the Compacting state immediately instead of keeping the conversation stuck there.
- A temporary provider or network interruption no longer permanently fails a child agent. It stays live, backs off, and continues from its saved transcript; explicit Stop still wins immediately.
- Quitting or restarting now warns when it would stop live agents or background commands. A confirmed shutdown is recorded as your action instead of being mistaken for a crash.

### Project Bash setup

- Settings now has a Projects tab instead of Environment. Every known project is its own collapsible section.
- Each project has one optional command that runs in the same shell before every Bash command, including child-agent, worktree and background commands.
- An empty value disables the setup. If the setup command fails, no part of the requested Bash script runs.
- Project sections show blocked, trust and older-setup state while keeping saved resolver arguments and resolved values hidden.
