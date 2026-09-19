# Laser 0.9.4

One fix, for long conversations.

## The top of a long conversation stops being a skeleton

Scrolling up far enough in a long conversation could leave the screen full of placeholder rows that never became messages, however long you waited or however much you scrolled.

The conversation was asking for the older messages the whole time, and the answers were arriving — they were being thrown away. A page of earlier history is placed against the oldest row the window is holding, and in a long conversation that row is not always one the transcript draws (a very large tool result, for example, is held as a reference). When it was not, the page was refused, the same request went out again, and the placeholders stayed for ever.

Now such a page is kept: it is older than everything on screen by definition, so it goes where it belongs. Measured on a real 27 MB conversation, the loaded transcript goes from 3,800 px of content to 54,000 px as you read upwards, instead of standing still.

Two supporting changes: unloaded history now occupies at most three screens in front of you rather than an estimate of the entire past — an estimate of tens of thousands of pixels was a blank region no amount of loading could fill — and reading upwards into it loads pages one after another as you go, while the explicit "Load earlier messages" button still loads exactly one.
