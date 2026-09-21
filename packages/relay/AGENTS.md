# @lasercode/relay

A byte forwarder. Two sockets per channel id, and nothing else.

It links no crypto library and never parses a payload beyond the channel id.
Anything that would require it to understand traffic belongs elsewhere.
