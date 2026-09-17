Laser 0.8.0

## Agents are files you can read and edit

### New in 0.8.0

- Every custom agent is now one Markdown file: a short header with its description, model, thinking level, skills and the agents it may start, then its instructions as the body. Your existing agents are converted the first time this version starts; the old `agents.json` is kept beside them as a backup.
- Global agents live in the app's `agents` folder and follow you into every project. Project agents live in `.laser/agents/` inside a project and appear only there — commit them with the code and everyone who opens the project gets them. A project agent with the same name as a global one takes its place in that project.
- Edit the file or edit in the Agents page, it is the same thing: the app watches the folders and picks up a change within a second. A file it cannot read shows a warning that says what to fix, and the last good version keeps working.
- Every custom agent now starts from Laser's core instructions — the rules that hold for all of them — before its own. An agent that should not have them has an "Exclude Laser's Core Instructions Prompt" switch in its settings. Beam, Chat and Namer are unaffected.
- The Agents page shows where each agent lives and lets you choose Global or This project when creating one. The new-session agent picker offers only the agents this project can run.
