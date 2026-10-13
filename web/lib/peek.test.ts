// Peek (motion-v2 M6: click toggle, redaction tape, decrypting digits): the real value is in the DOM only
// while peeked. The brand v4 tape peel lives on the header logo only.
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { PeekProvider, PeekToggle, Veiled } from "@/components/portfolio/peek";
import { Wordmark } from "@/components/layout/logo";

const SECRET = "12.40271";
const render = (shown: boolean, child: React.ReactNode = SECRET) =>
  renderToStaticMarkup(
    createElement(PeekProvider as (p: { initialShown?: boolean }) => React.ReactNode, { initialShown: shown }, createElement(Veiled, null, child), createElement(PeekToggle)),
  );

describe("Peek veil", () => {
  it("veiled: the value is not in the DOM, only a fixed stand-in and 'hidden'", () => {
    const html = render(false);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("12.4");
    expect(html).toContain("00.000");
    expect(html).toContain("hidden");
    expect(html).toContain('data-veiled="covered"');
    expect(html).toContain("redaction-tape");
    expect(html).toContain('aria-pressed="false"');
    expect(html).toContain(">Peek<");
  });

  it("veiled: a node value is not rendered either", () => {
    const html = render(false, createElement("b", null, SECRET));
    expect(html).not.toContain(SECRET);
    expect(html).toContain("00.000");
  });

  it("the toggle is a click button, not press-and-hold", () => {
    const html = render(false);
    expect(html).not.toContain("touch-none");
    expect(html).not.toContain("(hold)");
  });

  it("peeked: the value is there and the tape is not the brand peel", () => {
    const html = render(true);
    expect(html).toContain(SECRET);
    expect(html).toContain('data-veiled="open"');
    expect(html).not.toContain("data-peeled");
    expect(html).toContain('aria-pressed="true"');
    expect(html).toContain(">Hide<");
    expect(render(true, createElement("b", null, SECRET))).toContain(SECRET);
  });
});

describe("header logo", () => {
  it("the hidden z exists only while the tape is off", () => {
    expect(renderToStaticMarkup(createElement(Wordmark, { peeled: false }))).not.toContain("logo-z");
    expect(renderToStaticMarkup(createElement(Wordmark, { peeled: true }))).toContain("logo-z");
  });
});
