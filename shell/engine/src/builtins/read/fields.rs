use crate::{expand::Work, interpreter::Context, state::IfsMembers};
use std::ops::Range;

pub(super) struct Fields<'a> {
    text: &'a str,
    protected: &'a [u8],
    members: IfsMembers,
    offset: usize,
}

impl<'a> Fields<'a> {
    pub(super) fn new(text: &'a str, protected: &'a [u8], members: IfsMembers) -> Self {
        Self {
            text,
            protected,
            members,
            offset: 0,
        }
    }

    fn delimiter(&self) -> Option<(char, bool)> {
        let ch = self.text[self.offset..].chars().next()?;
        let quoted = self
            .protected
            .get(self.offset / 8)
            .is_some_and(|bits| bits & (1 << (self.offset % 8)) != 0);
        if quoted || !self.members.contains(ch) {
            return None;
        }
        Some((ch, matches!(ch, ' ' | '\t' | '\n')))
    }

    async fn whitespace(&mut self, context: &Context, work: &mut Work) -> Result<(), i32> {
        while let Some((ch, true)) = self.delimiter() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(super::error_status)?;
            self.offset += ch.len_utf8();
        }
        Ok(())
    }

    async fn next(
        &mut self,
        context: &Context,
        work: &mut Work,
    ) -> Result<Option<Range<usize>>, i32> {
        self.whitespace(context, work).await?;
        if self.offset == self.text.len() {
            return Ok(None);
        }
        let start = self.offset;
        while self.offset < self.text.len() && self.delimiter().is_none() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(super::error_status)?;
            self.offset += self.text[self.offset..].chars().next().ok_or(2)?.len_utf8();
        }
        let end = self.offset;
        self.whitespace(context, work).await?;
        if let Some((ch, false)) = self.delimiter() {
            self.offset += ch.len_utf8();
        }
        self.whitespace(context, work).await?;
        Ok(Some(start..end))
    }

    async fn remainder(
        &self,
        start: usize,
        context: &Context,
        work: &mut Work,
    ) -> Result<&'a str, i32> {
        let mut end = self.text.len();
        for ch in self.text[start..].chars().rev() {
            work.checkpoint(&context.cancel)
                .await
                .map_err(super::error_status)?;
            if !matches!(ch, ' ' | '\t' | '\n') || !self.members.contains(ch) {
                break;
            }
            end -= ch.len_utf8();
        }
        Ok(&self.text[start..end])
    }

    pub(super) async fn value(
        &mut self,
        last: bool,
        context: &Context,
        work: &mut Work,
    ) -> Result<&'a str, i32> {
        let Some(field) = self.next(context, work).await? else {
            return Ok("");
        };
        if last && self.next(context, work).await?.is_some() {
            return self.remainder(field.start, context, work).await;
        }
        Ok(&self.text[field])
    }
}
