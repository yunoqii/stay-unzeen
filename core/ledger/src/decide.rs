//! Pure deposit policy: what to do with an incoming shielded note. No I/O, fully unit-tested.

use unzeen_protocol::{
    ChainId,
    memo::{DecodeError, Op, Target, Verdict, classify},
};

/// Ledger policy knobs (from env in the scanner).
#[derive(Clone, Copy, Debug)]
pub struct Policy {
    pub chain: ChainId,
    /// Confirmations before a deposit is acted on (K). Default 3.
    pub confirmations: u32,
    /// Notes below this are kept by the pool as dust and never credited.
    pub min_deposit_zat: u64,
    /// Smallest hold a balance action may place.
    pub min_action_zat: u64,
    /// R-core-7: a deposit is credited at K + extra confirmations, extra in 0..=credit_jitter,
    /// fixed per note (derived from its keyed note_ref), so the crediting moment is not
    /// exactly "mined height + K". 3 in production, 0 in tests.
    pub credit_jitter: u32,
}

/// The memo of a note as known by the wallet.
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum MemoInput {
    /// Full tx not fetched yet (compact blocks carry no memo).
    NotFetched,
    /// ZIP-302 text memo (padding stripped).
    Text(String),
    /// Empty, binary or reserved memo.
    NonText,
}

/// One incoming (non-change) shielded note observed in the pool wallet.
#[derive(Clone, Debug)]
pub struct NoteObs {
    pub note_ref: [u8; 32],
    pub amount_zat: u64,
    pub mined_height: Option<u32>,
    pub tip: u32,
    /// Header time of the mining block (unix seconds); `expiry` is checked against it.
    pub block_time: Option<u64>,
    pub memo: MemoInput,
    /// D3: the deposit tx had transparent inputs or unshielded value from Sapling / legacy
    /// Orchard, so its amount is public on chain. `false` when unknown.
    pub public_source: bool,
}

impl NoteObs {
    /// Confirmations this note needs before it is acted on: K + a per-note extra.
    pub fn required(&self, p: &Policy) -> u32 {
        let extra = if p.credit_jitter == 0 {
            0
        } else {
            u32::from(self.note_ref[31]) % (p.credit_jitter + 1)
        };
        p.confirmations.max(1) + extra
    }

    pub fn confirmations(&self) -> u32 {
        match self.mined_height {
            Some(h) if self.tip >= h => self.tip - h + 1,
            _ => 0,
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Stage {
    /// Not in the main chain (never mined, or un-mined by a reorg).
    Unmined,
    /// Mined, fewer than K confirmations.
    Seen,
    /// >= K confirmations but the memo is not available yet.
    Confirmed,
    /// Ready to be finalized.
    Final(Outcome),
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub enum Outcome {
    Dust,
    /// Bad signature or unreadable memo. The pubkey (if any) is NOT trusted.
    Frozen {
        reason: &'static str,
    },
    /// Add the note value to `pk`'s balance.
    Credit {
        pk: [u8; 32],
        op: Op,
        reason: Option<&'static str>,
    },
}

pub fn evaluate(obs: &NoteObs, p: &Policy, fallback_now: u64) -> Stage {
    if obs.mined_height.is_none() {
        return Stage::Unmined;
    }
    if obs.confirmations() < obs.required(p) {
        return Stage::Seen;
    }
    if obs.amount_zat < p.min_deposit_zat {
        return Stage::Final(Outcome::Dust);
    }
    let text = match &obs.memo {
        MemoInput::NotFetched => return Stage::Confirmed,
        MemoInput::NonText => {
            return Stage::Final(Outcome::Frozen {
                reason: "memo_not_text",
            });
        }
        MemoInput::Text(t) => t,
    };
    let now = obs.block_time.unwrap_or(fallback_now);
    Stage::Final(match classify(text.trim_end(), p.chain, now) {
        Verdict::Malformed(DecodeError::OpNotAllowed(_)) => Outcome::Frozen {
            reason: "op_not_allowed",
        },
        Verdict::Malformed(_) => Outcome::Frozen {
            reason: "memo_malformed",
        },
        Verdict::BadSignature(_) => Outcome::Frozen {
            reason: "bad_signature",
        },
        // Refunds are not used in memo v1 (lead decision 12.10): an expired but correctly
        // signed deposit is always credited to the balance, whatever `target_kind` says.
        Verdict::Expired(m) => Outcome::Credit {
            pk: m.body.anon_pubkey,
            op: m.body.op,
            reason: Some(if m.body.target == Target::None {
                "expired_no_refund_target"
            } else {
                "expired_refund_unsupported"
            }),
        },
        // Each note is credited on its own (idempotency = note_ref), so paying the same
        // deposit QR twice credits both payments; the memo nonce is not uniquified.
        Verdict::Valid(m) => Outcome::Credit {
            pk: m.body.anon_pubkey,
            op: m.body.op,
            reason: None,
        },
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use unzeen_protocol::{
        SigningKey, SolanaCluster, ZcashNet,
        memo::{Unz1Body, Venue},
    };

    const CHAIN: ChainId = ChainId::new(ZcashNet::Testnet, SolanaCluster::Devnet);
    const P: Policy = Policy {
        chain: CHAIN,
        confirmations: 3,
        min_deposit_zat: 100_000,
        min_action_zat: 100_000,
        credit_jitter: 0,
    };
    const T0: u64 = 1_800_000_000;

    fn memo(op: Op, expiry: u32, target: Target) -> String {
        let (venue, mint) = if op == Op::Deposit {
            (Venue::None, [0; 32])
        } else {
            (Venue::PumpFun, [5; 32])
        };
        Unz1Body {
            op,
            venue,
            mint,
            min_out: 0,
            anon_pubkey: [0; 32],
            nonce: 9,
            expiry,
            target,
        }
        .sign(&SigningKey::from_bytes(&[4; 32]), CHAIN)
        .encode()
    }

    fn pk() -> [u8; 32] {
        SigningKey::from_bytes(&[4; 32]).verifying_key().to_bytes()
    }

    fn obs(amount: u64, h: Option<u32>, tip: u32, memo: MemoInput) -> NoteObs {
        NoteObs {
            note_ref: [0; 32],
            amount_zat: amount,
            mined_height: h,
            tip,
            block_time: Some(T0),
            memo,
            public_source: false,
        }
    }

    #[test]
    fn credit_jitter_is_per_note_and_bounded() {
        let pj = Policy { credit_jitter: 3, ..P };
        let m = MemoInput::Text(memo(Op::Deposit, T0 as u32 + 60, Target::None));
        let mut seen = std::collections::BTreeSet::new();
        for b in 0u8..=255 {
            let mut o = obs(1_000_000, Some(100), 100, m.clone());
            o.note_ref[31] = b;
            let need = o.required(&pj);
            assert!((3..=6).contains(&need));
            seen.insert(need);
            // Exactly `need` confirmations finalize; one less does not.
            o.tip = 100 + need - 1;
            assert!(matches!(evaluate(&o, &pj, T0), Stage::Final(_)));
            o.tip -= 1;
            assert_eq!(evaluate(&o, &pj, T0), Stage::Seen);
        }
        assert_eq!(seen.len(), 4, "all of K..K+3 occur");
    }

    #[test]
    fn confirmations_gate() {
        let m = MemoInput::Text(memo(Op::Deposit, T0 as u32 + 60, Target::None));
        assert_eq!(evaluate(&obs(1_000_000, None, 100, m.clone()), &P, T0), Stage::Unmined);
        assert_eq!(evaluate(&obs(1_000_000, Some(99), 100, m.clone()), &P, T0), Stage::Seen); // 2 conf
        assert!(matches!(
            evaluate(&obs(1_000_000, Some(98), 100, m), &P, T0),
            Stage::Final(_)
        )); // 3 conf
        assert_eq!(
            evaluate(&obs(1_000_000, Some(98), 100, MemoInput::NotFetched), &P, T0),
            Stage::Confirmed
        );
    }

    #[test]
    fn deposit_credits() {
        let m = MemoInput::Text(memo(Op::Deposit, T0 as u32, Target::None));
        assert_eq!(
            evaluate(&obs(1_000_000, Some(1), 10, m), &P, 0),
            Stage::Final(Outcome::Credit {
                pk: pk(),
                op: Op::Deposit,
                reason: None
            })
        );
    }

    #[test]
    fn dust_is_not_credited() {
        let m = MemoInput::Text(memo(Op::Deposit, T0 as u32, Target::None));
        assert_eq!(
            evaluate(&obs(99_999, Some(1), 10, m), &P, 0),
            Stage::Final(Outcome::Dust)
        );
    }

    #[test]
    fn expired_uses_block_time() {
        let exp = T0 as u32 - 1;
        let with_target = MemoInput::Text(memo(Op::Deposit, exp, Target::Shielded([1; 43])));
        assert_eq!(
            evaluate(&obs(1_000_000, Some(1), 10, with_target.clone()), &P, 0),
            Stage::Final(Outcome::Credit {
                pk: pk(),
                op: Op::Deposit,
                reason: Some("expired_refund_unsupported")
            })
        );
        let no_target = MemoInput::Text(memo(Op::Deposit, exp, Target::None));
        assert_eq!(
            evaluate(&obs(1_000_000, Some(1), 10, no_target), &P, 0),
            Stage::Final(Outcome::Credit {
                pk: pk(),
                op: Op::Deposit,
                reason: Some("expired_no_refund_target")
            })
        );
        // Block time missing -> fallback clock.
        let mut o = obs(1_000_000, Some(1), 10, with_target);
        o.block_time = None;
        assert_eq!(
            evaluate(&o, &P, u64::from(exp)),
            Stage::Final(Outcome::Credit {
                pk: pk(),
                op: Op::Deposit,
                reason: None
            })
        );
    }

    #[test]
    fn bad_and_garbage_are_frozen() {
        let mut s = memo(Op::Deposit, T0 as u32, Target::None);
        // Corrupt one base64 char inside the signature region (last chars).
        let last = s.pop().unwrap();
        s.push(if last == 'A' { 'B' } else { 'A' });
        let r = evaluate(&obs(1_000_000, Some(1), 10, MemoInput::Text(s)), &P, 0);
        assert!(matches!(r, Stage::Final(Outcome::Frozen { .. })), "{r:?}");
        assert_eq!(
            evaluate(&obs(1_000_000, Some(1), 10, MemoInput::Text("hello".into())), &P, 0),
            Stage::Final(Outcome::Frozen {
                reason: "memo_malformed"
            })
        );
        assert_eq!(
            evaluate(&obs(1_000_000, Some(1), 10, MemoInput::NonText), &P, 0),
            Stage::Final(Outcome::Frozen {
                reason: "memo_not_text"
            })
        );
    }

    #[test]
    fn non_deposit_ops_are_frozen() {
        let m = MemoInput::Text(memo(Op::Buy, T0 as u32, Target::Shielded([1; 43])));
        assert_eq!(
            evaluate(&obs(1_000_000, Some(1), 10, m), &P, 0),
            Stage::Final(Outcome::Frozen {
                reason: "op_not_allowed"
            })
        );
    }

    #[test]
    fn trailing_whitespace_tolerated() {
        let m = MemoInput::Text(format!("{}\n", memo(Op::Deposit, T0 as u32, Target::None)));
        assert!(matches!(
            evaluate(&obs(1_000_000, Some(1), 10, m), &P, 0),
            Stage::Final(Outcome::Credit { .. })
        ));
    }
}
