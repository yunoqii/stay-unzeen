// Direction registry shared by every v3 page.
window.DIRS = [
  { k: "a", n: "proof", title: "A · Proof", line: "commitment brackets: a value that is bound but unreadable", zk: true },
  { k: "b", n: "root",  title: "B · Root",  line: "Merkle root: the sum is public, the leaves are not", zk: true },
  { k: "c", n: "bite",  title: "C · Bite",  line: "a disc rising over a yellow tile leaves a heavy u" },
  { k: "d", n: "tape",  title: "D · Tape",  line: "torn redaction tape; the wordmark wears it over zee" },
  { k: "e", n: "visor", title: "E · Visor", line: "mascot: a lump with a censor bar, no face" },
];
window.dirByHash = () => window.DIRS.find((d) => d.k === (location.hash.slice(1) || "a"));
