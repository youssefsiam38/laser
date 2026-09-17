Laser 0.7.2

## Every conversation opens again

### Fixed in 0.7.2

- Long conversations open again. Since 0.7.0, a conversation where an agent worked through hundreds of steps in one go, or a long-running goal, could show "This session didn't load". They now open at the latest message, and earlier parts load as you scroll up. Nothing in those conversations was lost.
- MCP servers no longer show "Access changed. Sign in again" each time you open a conversation. That message now appears only when access really changed.
- Removing a project after archiving all of its conversations now takes it off the list, instead of saying it stays because one of its conversations is open.
- The green activity mark beside a conversation's name now means only that the agent is working. It no longer appears while a conversation is loading; the page itself shows that.
