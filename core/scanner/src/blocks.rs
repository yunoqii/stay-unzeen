//! Minimal in-memory `BlockSource`: we download a batch of compact blocks, scan it,
//! and drop it. No on-disk block cache needed for the pool wallet.

use std::convert::Infallible;

use zcash_client_backend::{
    data_api::chain::{BlockSource, error::Error as ChainError},
    proto::compact_formats::CompactBlock,
};
use zcash_protocol::consensus::BlockHeight;

#[derive(Default)]
pub struct MemBlocks {
    blocks: Vec<CompactBlock>,
}

impl MemBlocks {
    pub fn new(mut blocks: Vec<CompactBlock>) -> Self {
        blocks.sort_by_key(|b| b.height);
        Self { blocks }
    }

    pub fn len(&self) -> usize {
        self.blocks.len()
    }
}

impl BlockSource for MemBlocks {
    type Error = Infallible;

    fn with_blocks<F, WalletErrT>(
        &self,
        from_height: Option<BlockHeight>,
        limit: Option<usize>,
        mut with_block: F,
    ) -> Result<(), ChainError<WalletErrT, Self::Error>>
    where
        F: FnMut(CompactBlock) -> Result<(), ChainError<WalletErrT, Self::Error>>,
    {
        let from = from_height.map_or(0, u64::from);
        let iter = self.blocks.iter().filter(|b| b.height >= from);
        for b in iter.take(limit.unwrap_or(usize::MAX)) {
            with_block(b.clone())?;
        }
        Ok(())
    }
}
