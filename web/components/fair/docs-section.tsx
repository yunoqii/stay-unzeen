// Docs section for the sealed-bid fair launch. Lazy chunk: compiled in only with
// NEXT_PUBLIC_FAIR_LAUNCH_BUILD=1 and loaded only when PoolInfo.features.fairLaunch is on.

const ID = "fair-launch";
const TITLE = "Fair launch (sealed bids)";

export function FairDocsTocItem({ render }: { render: (label: string, id: string) => React.ReactNode }) {
  return <>{render(TITLE, ID)}</>;
}

export function FairDocsSection({ n }: { n: number }) {
  return (
    <section id={ID} data-doc-section aria-labelledby={`${ID}-h`} className="scroll-mt-24 border-t border-border/60 pt-10 pb-10">
      <p className="font-mono text-[11px] tracking-wider text-faint-foreground uppercase">{String(n).padStart(2, "0")}</p>
      <h2 id={`${ID}-h`} className="mt-1 text-2xl font-medium tracking-tight">
        {TITLE}
      </h2>
      <div className="mt-4 space-y-4 text-[15px] leading-relaxed text-pretty text-muted-foreground">
        <p>A launch can run as a sealed-bid fair launch: the price is public, the participants are not, and nobody gets in before anyone else.</p>
        <ol className="list-decimal space-y-2 pl-5 marker:text-faint-foreground">
          <li>During the bid window, your amount is encrypted in your browser to a drand round after the window closes (timelock). Nobody can read any bid before that round: not other bidders, not the creator, not us. Your balance holds a fixed denomination, at least your bid.</li>
          <li>When the window closes, before the round, the pool commits to the set of bids (a Merkle root written to Solana). You can check that your bid is in it.</li>
          <li>After the round, all bids open at once and the token is created and bought in one transaction. The mint does not exist before it, so nobody can buy earlier or cheaper.</li>
          <li>Everyone pays the same price; tokens are split in proportion to the bids. If bids pass the cap, every bid is cut by the same ratio and the rest of each hold comes back.</li>
        </ol>
        <p>The number of bids is shown only when there are at least five. Anyone can still buy right after the launch, at a higher price.</p>
      </div>
    </section>
  );
}
