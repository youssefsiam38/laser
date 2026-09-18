# Laser 0.9.3

One repair, finished properly: the images in a conversation.

## Every image you asked for is there

In a conversation with many pictures, the last ones used to go grey — "Image not kept in this window" — and stay that way. Opening them was impossible too, because the button was tied to the same small pool of decoded pictures. Twenty-four was the whole budget, and the twenty-fifth image was refused once and never asked about again.

Now a picture that cannot be decoded right now is *waiting*, not failed. Whatever is on screen is drawn; scrolling towards a waiting picture loads it before you reach it; and opening any picture always works — it reads the bytes from the conversation itself, verified against the image's own fingerprint, whether or not it happens to be decoded. A picture that genuinely could not be rebuilt says so in words and offers Try again.

Memory is still bounded, and now honestly: only pictures nobody is looking at count against the limit, and when the window comes under memory pressure those are the first thing released. A conversation with forty images stays around 50 MB while you read it.

Two supporting repairs: a picture is now identified by its own content, so a conversation that is still being written no longer re-reads every image each time it changes; and images stay attached to the conversation they belong to.
