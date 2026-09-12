import { test } from "node:test";
import assert from "node:assert/strict";
import { checkDirectionSource } from "./check-direction.mjs";

test("rejects physical utilities including variants, arbitrary spacing and corners", () => {
  for (const utility of ["ml-2", "ml-custom-spacing", "hover:mr-auto", "md:-left-3", "right-[12%]", "pr-[var(--x)]", "pl-px", "text-right", "text-left", "rounded-l", "rounded-tr-md", "border-r", "border-l-2", "space-x-2", "-translate-x-1/2", "float-left"]) {
    assert.ok(checkDirectionSource(`<div className="${utility}"/>`).length, utility);
  }
  assert.ok(checkDirectionSource('const classes = `bg-bg ${active ? "mr-2" : "mr-3"} pl-4`;').length);
});

test("accepts logical utilities, symmetric geometry and token names", () => {
  assert.deepEqual(checkDirectionSource('<div className="ms-2 me-auto ps-4 pe-3 start-0 end-0 inset-x-0 text-start rounded-ss-lg rounded-lg border-line border-live shadow-float-sm gap-2" />'), []);
  assert.deepEqual(checkDirectionSource('// text-right is forbidden\nconst side = "right";'), []);
});

test("an exception needs a local explanatory comment", () => {
  assert.deepEqual(checkDirectionSource('// bidi-allow-physical: canvas coordinates are Cartesian\nconst pin = "left-0";'), []);
  assert.equal(checkDirectionSource('// bidi-allow-physical:\nconst pin = "left-0";').length, 1);
  assert.equal(checkDirectionSource('// bidi-allow-physical: canvas coordinates\nconst okay = "start-0";\nconst bad = "left-0";').length, 1);
});

test("checks CSS and arbitrary properties without mistaking custom variables for properties", () => {
  assert.equal(checkDirectionSource('.bad { margin-left: 2px; right: 0; }', 'app.css').length, 2);
  assert.deepEqual(checkDirectionSource('/* left: is physical */\n.ok { inset-inline-start: 0; --line: red; }', 'app.css'), []);
  assert.deepEqual(checkDirectionSource('const code = "[--rs-line-numbers-padding-right:var(--spacing)]"'), []);
  assert.equal(checkDirectionSource('const code = "[margin-left:var(--spacing)]"').length, 1);
});
