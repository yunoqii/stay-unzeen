// Brand v4 Peek (docs/design/tape-peel.md): the value under the tape is in the DOM only while the tape is off.
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

describe("Peek under tape", () => {
  it("covered: the value is not in the DOM, only a fixed stand-in and 'hidden'", () => {
    const html = render(false);
    expect(html).not.toContain(SECRET);
    expect(html).not.toContain("12.4");
    expect(html).toContain("00.000");
    expect(html).toContain("hidden");
    expect(html).toContain('data-peeled="false"');
    expect(html).toContain('aria-pressed="false"');
  });

  it("covered: a node value is not rendered either", () => {
    const html = render(false, createElement("b", null, SECRET));
    expect(html).not.toContain(SECRET);
  });

  it("tape off: the value is there", () => {
    const html = render(true);
    expect(html).toContain(SECRET);
    expect(html).toContain('data-peeled="true"');
    expect(html).toContain('aria-pressed="true"');
  });
});

describe("header logo", () => {
  it("the hidden z exists only while the tape is off", () => {
    expect(renderToStaticMarkup(createElement(Wordmark, { peeled: false }))).not.toContain("logo-z");
    expect(renderToStaticMarkup(createElement(Wordmark, { peeled: true }))).toContain("logo-z");
  });
});
