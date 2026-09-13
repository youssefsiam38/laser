/**
 * The math renderer itself: the one module that pulls KaTeX and its stylesheet
 * into the bundle, so both live in a chunk of their own (M16-T31).
 *
 * Nothing may import this statically. `markdown-math.ts` imports it when a
 * message's source carries math; the stylesheet rides with the chunk and its
 * font faces load only for the glyphs a formula actually uses.
 */
import "katex/dist/katex.min.css";

import rehypeKatex from "rehype-katex";

export default rehypeKatex;
