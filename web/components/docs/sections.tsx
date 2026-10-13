import Link from "next/link";

// User documentation, English only. Facts follow docs/API.md and the public README; no internal
// infrastructure details. Fair-launch has its own lazy section (components/fair/docs-section.tsx).

export interface DocSection {
  id: string;
  title: string;
  body: React.ReactNode;
}

const A = ({ href, children }: { href: string; children: React.ReactNode }) => (
  <Link href={href} className="text-foreground underline decoration-border-strong underline-offset-4 transition-colors hover:decoration-zec">
    {children}
  </Link>
);

const Strong = ({ children }: { children: React.ReactNode }) => <strong className="font-medium text-foreground">{children}</strong>;

function Table({ head, rows }: { head: string[]; rows: React.ReactNode[][] }) {
  return (
    <div className="ledger overflow-x-auto text-sm">
      <table className="w-full min-w-[480px]">
        <thead>
          <tr className="text-left text-xs text-faint-foreground">
            {head.map((h) => (
              <th key={h} scope="col" className="px-3 py-2 font-normal">
                {h}
              </th>
            ))}
          </tr>
        </thead>
        <tbody className="divide-y divide-border/60 border-t border-border/60">
          {rows.map((r, i) => (
            <tr key={i} className="align-top">
              {r.map((c, j) => (
                <td key={j} className={j === 0 ? "px-3 py-2.5 font-medium text-foreground/90" : "px-3 py-2.5"}>
                  {c}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

function List({ children }: { children: React.ReactNode }) {
  return <ul className="list-none space-y-2 [&>li]:relative [&>li]:pl-4 [&>li]:before:absolute [&>li]:before:top-[0.7em] [&>li]:before:left-0 [&>li]:before:h-px [&>li]:before:w-2 [&>li]:before:bg-zec/60">{children}</ul>;
}

function Note({ children }: { children: React.ReactNode }) {
  return <p className="hatch-zec rounded-xl border border-zec/25 px-4 py-3 text-sm text-foreground/85">{children}</p>;
}

function Faq({ q, children }: { q: string; children: React.ReactNode }) {
  return (
    <details className="group border-b border-border/60 py-3 last:border-b-0">
      <summary className="cursor-pointer list-none text-foreground/90 marker:hidden">
        <span className="mr-2 inline-block font-mono text-xs text-zec transition-transform group-open:rotate-45">+</span>
        {q}
      </summary>
      <div className="mt-2 pl-5">{children}</div>
    </details>
  );
}

export const SECTIONS: DocSection[] = [
  {
    id: "how-it-works",
    title: "How it works",
    body: (
      <>
        <p>
          unzeen is a privacy layer for Solana launchpads, paid for with <Strong>shielded ZEC</Strong>. You top up once from any shielded Zcash wallet. After that you buy, sell and launch tokens on
          pump.fun and Meteora DBC from your balance. The trades are made by the pool&rsquo;s shared Solana vaults, so the feed says &ldquo;unzeen bought 1.2M $PEPE&rdquo;. It never says who.
        </p>
        <List>
          <li>No Solana wallet, no email, no sign-up. Your account is a 12-word anon key made and encrypted in your browser.</li>
          <li>The price stays public: the bonding curve and every trade are on-chain. The participants do not.</li>
          <li>The only Zcash transaction you make is the top up. Trades are signed requests from your balance, so your deposit is not tied to your trades in time.</li>
        </List>
        <Table
          head={["Step", "What happens"]}
          rows={[
            ["1. Key", "Your browser creates a 12-word phrase and an anon key from it. The server only ever sees the public key."],
            ["2. Top up", "You pay shielded ZEC to the pool with a QR code. After a few confirmations it shows up as your balance."],
            ["3. Trade", "Buy, sell or launch. A pool vault does it on-chain. The feed shows “unzeen”."],
            ["4. Withdraw", "ZEC back to any shielded address, or tokens to a fresh Solana address, always with a delay."],
          ]}
        />
      </>
    ),
  },
  {
    id: "anon-key",
    title: "Your anon key",
    body: (
      <>
        <p>
          The anon key is your whole account. It is a standard 12-word recovery phrase; your browser derives a signing key from it, a separate one for Devnet and Mainnet. Every action you take
          is a request signed by that key.
        </p>
        <List>
          <li>The phrase is encrypted in this browser with your password and never leaves it. Reloading the page locks the key again; it also locks itself after 30 minutes.</li>
          <li>
            <Strong>Write the 12 words down.</Strong> If you lose them and this browser, nobody can recover your balance. Not us either.
          </li>
          <li>Never paste the phrase anywhere else. The token chat refuses any message that looks like a recovery phrase.</li>
          <li>Your Solana wallet, if you have one, is never connected to the anon key. The app never asks for it.</li>
        </List>
        <p>
          Create or restore it on <A href="/key">/key</A>. &ldquo;Forget this device&rdquo; deletes the encrypted key and your local trade history from this browser.
        </p>
      </>
    ),
  },
  {
    id: "top-up",
    title: "Top up",
    body: (
      <>
        <p>
          Open <A href="/portfolio">Portfolio</A> and choose <Strong>Top up</Strong>. You get a QR code with the pool&rsquo;s shielded address, the amount and a short memo signed by your anon key. Scan it
          with ZODL or any wallet that supports ZIP-321 payment requests.
        </p>
        <List>
          <li>
            <Strong>Pay only from a shielded balance.</Strong> Paying from a transparent address, or straight from an exchange, reveals where the ZEC came from and how much.
          </li>
          <li>The deposit is credited after 3 confirmations plus a random 0 to 3 blocks. The page shows each step: seen, confirming, credited.</li>
          <li>Below the minimum deposit nothing is credited. The app shows the minimum before you pay.</li>
          <li>Top up in advance: trades are faster, and a trade right after a deposit is easier to guess.</li>
        </List>
      </>
    ),
  },
  {
    id: "execution",
    title: "Now, Delayed and Max privacy",
    body: (
      <>
        <p>Pick the mode next to the Buy and Sell buttons. The default is Delayed; you can change it in Settings. It is stored in this browser only.</p>
        <Table
          head={["Mode", "Speed", "How"]}
          rows={[
            ["Delayed", "30–60 s", "Your action waits for the next pool batch and runs with everyone else’s, in random order."],
            ["Max privacy", "5–15 min", "The same, with longer batches."],
            ["Now", "1–3 s", "Runs at once, for a small flat fee. Buy, sell and launch only, never withdrawals."],
          ]}
        />
        <p>
          On-chain, all three look the same: the same pool vaults, the same fee profile, no marker. What differs is timing. With <Strong>Now</Strong>, anyone who can see your connection (your ISP,
          Wi-Fi, VPN or our hosting provider) can match the moment you sent the request to the trade that follows. Delayed narrows it down only to a batch. Use Tor or a VPN if that matters to you.
        </p>
      </>
    ),
  },
  {
    id: "orders",
    title: "Private orders",
    body: (
      <>
        <p>
          On a token page, the <Strong>Orders</Strong> tab places limit buys, limit sells, take-profits and stop-losses. They live only in the pool&rsquo;s ledger and never go on-chain, so nobody can
          see where your stop is.
        </p>
        <List>
          <li>The pool checks prices about once a minute. A stop-loss fires after two checks in a row at or below its price.</li>
          <li>A triggered order trades in Delayed or Max privacy, never Now. Slippage is measured from the price check that triggered it.</li>
          <li>Orders expire after at most 72 hours. Cancel any open order at any time; the reserved amount comes back at once.</li>
          <li>
            A <Strong>bracket</Strong> puts a take-profit and a stop-loss on one position with one hold: whichever hits first sells, and the other is cancelled.
          </li>
          <li>
            <Strong>Retry after slippage</Strong> sends an order back to open when its trade misses the slippage limit, up to 3 times. A stop-loss with retry may still not
            exit in a crash.
          </li>
          <li>Orders work for SOL-paired pump.fun tokens on the bonding curve that the pool already trades. Tokens paired with ZEC, USDC or USD1 are bought and sold directly.</li>
        </List>
      </>
    ),
  },
  {
    id: "withdraw",
    title: "Withdraw",
    body: (
      <>
        <p>Withdrawals always wait. An instant one would link your trade to the receiving address on-chain.</p>
        <Table
          head={["What", "Where to", "Delay"]}
          rows={[
            ["ZEC", "Any shielded Zcash address", "1–10 min (10–60 min in Max privacy), batched with other payouts"],
            ["Tokens", "A new Solana address", "30 s – 5 min, with a small SOL drop for gas"],
          ]}
        />
        <List>
          <li>
            <Strong>Use a fresh Solana address.</Strong> The gas comes from a pool vault, so anyone can see the address was funded by unzeen.
          </li>
          <li>Withdrawing exactly the amount you bought links the address to that buy. The app warns you; withdraw a different amount or wait.</li>
          <li>Smart withdraw splits tokens into 2–5 unequal parts, each to its own address at its own random time.</li>
        </List>
      </>
    ),
  },
  {
    id: "chat",
    title: "Token chat",
    body: (
      <>
        <p>Every token page has an anonymous chat. Reading is open to everyone; posting needs an unlocked anon key and a small account balance (ZEC plus tokens), so spam costs money.</p>
        <List>
          <li>Your nickname is different in every token chat, so your messages in two chats cannot be linked to each other.</li>
          <li>Messages are published in batches together with trades, never the instant you send them. If you just traded this token, posting is delayed a few minutes by default so your message cannot be lined up with your trade.</li>
          <li>Text only. Links are not clickable and nothing is previewed, so a chat message never makes your browser contact anyone.</li>
          <li>You can delete your own messages. The token&rsquo;s creator can hide messages (readers can still reveal them). Messages reported by several people are hidden automatically.</li>
          <li>The creator badge means the pool checked that this nickname belongs to the account that launched the token. It is a separate nickname, so the creator&rsquo;s other messages stay unlinked.</li>
        </List>
      </>
    ),
  },
  {
    id: "verify",
    title: "Verify",
    body: (
      <>
        <p>
          <A href="/verify">/verify</A> lets anyone check that the pool is solvent without learning anything about its users. Once a day the pool publishes signed roots of its liabilities and
          anchors them on Solana.
        </p>
        <Table
          head={["Claim", "Status"]}
          rows={[
            ["Your balance is counted in the liabilities", "Proven to you: “Check my balance” verifies your proof in this browser."],
            ["Everyone sees the same roots", "Proven: signed by the operator key and anchored on Solana."],
            ["The vaults belong to the pool and hold the tokens", "Proven: each vault signs the snapshot."],
            ["The pool holds enough ZEC", "Attested by the operator, not proven. A shielded balance cannot be proven today without a viewing key, and that is never published."],
          ]}
        />
      </>
    ),
  },
  {
    id: "trust",
    title: "Trust and threat model",
    body: (
      <>
        <Note>unzeen is a custodial pool in this version. The operator holds the keys and could link your anon key to your trades. We say so plainly.</Note>
        <p className="text-foreground/90">What stays private</p>
        <List>
          <li>On-chain: who traded. Every trade, launch and withdrawal is signed by a public pool vault, never by you.</li>
          <li>On Zcash: your deposit. Sender, amount and memo are encrypted.</li>
          <li>Between tokens: your chat nicknames, and your launches (each one gets a fresh creator address).</li>
          <li>Amounts in the pool&rsquo;s records are erased 24 hours after an action; journals after 48 hours.</li>
        </List>
        <p className="text-foreground/90">What does not</p>
        <List>
          <li>If you are the only unzeen user trading a small token, all unzeen trades in it are yours: a pseudonymous position, not an identity.</li>
          <li>A network observer sees when you talk to the server, though not what. Delayed and Max privacy hide you in a batch; Now does not.</li>
          <li>Privacy grows with the number of users. While unzeen is small, batches are small.</li>
          <li>Creator rules (24 h lock, 5% cap) apply to the launching key; a second key could get around them.</li>
          <li>Anyone with your unlocked device can see that you use unzeen.</li>
        </List>
      </>
    ),
  },
  {
    id: "faq",
    title: "FAQ",
    body: (
      <div className="ledger block px-4">
        <Faq q="Do I need a Solana wallet?">No. You need a shielded Zcash wallet to top up, and a Solana address only if you want to withdraw tokens.</Faq>
        <Faq q="Can unzeen see my trades?">Yes, the operator can, because the pool is custodial. Nobody else can tie them to you, on-chain or in the app.</Faq>
        <Faq q="What if I lose my 12 words?">If you also lose this browser, the balance is gone. There is no reset, because there is no account to reset.</Faq>
        <Faq q="Why did my trade take a minute?">Delayed mode waits for the next batch so your trade hides among others. Choose Now if speed matters more than timing privacy.</Faq>
        <Faq q="Why is the ZEC reserve only attested?">Proving a shielded balance would need a viewing key or revealing individual notes, and both would reveal deposits. A zero-knowledge proof is on the roadmap.</Faq>
        <Faq q="Is this on mainnet?">Both. The header switches between Devnet (test funds) and Mainnet. Mainnet is an unaudited custodial pool: do not deposit more than you can lose.</Faq>
      </div>
    ),
  },
];
