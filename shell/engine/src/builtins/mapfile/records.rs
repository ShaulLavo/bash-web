use crate::{
    expand::Work,
    interpreter::Context,
    io::{Endpoint, IoError},
};

#[derive(Clone, Copy, PartialEq, Eq)]
pub(super) enum End {
    Delimiter,
    Input,
}

pub(super) struct Reader {
    ceiling: usize,
    delimiter: u8,
    trim: bool,
    chunk: Vec<u8>,
    position: usize,
    length: usize,
    record: Vec<u8>,
}
impl Reader {
    pub(super) fn new(
        ceiling: usize,
        chunk_bytes: usize,
        delimiter: u8,
        trim: bool,
    ) -> Result<Self, i32> {
        let mut chunk = Vec::new();
        chunk.try_reserve_exact(chunk_bytes).map_err(|_| 2)?;
        chunk.resize(chunk_bytes, 0);
        let mut record = Vec::new();
        record.try_reserve_exact(ceiling).map_err(|_| 2)?;
        Ok(Self {
            ceiling,
            delimiter,
            trim,
            chunk,
            position: 0,
            length: 0,
            record,
        })
    }

    pub(super) fn has_record(&self) -> bool {
        !self.record.is_empty()
    }
    pub(super) fn reset(&mut self) {
        self.record.clear();
    }

    pub(super) fn value(&self) -> Result<&str, std::str::Utf8Error> {
        let end = self
            .record
            .iter()
            .position(|byte| *byte == 0)
            .unwrap_or(self.record.len());
        let mut value = &self.record[..end];
        if self.trim && self.delimiter != 0 && value.last() == Some(&self.delimiter) {
            value = &value[..value.len() - 1];
        }
        std::str::from_utf8(value)
    }

    pub(super) async fn next(
        &mut self,
        input: &Endpoint,
        context: &Context,
        work: &mut Work,
    ) -> Result<End, i32> {
        loop {
            if self.position == self.length && !self.refill(input, context, work).await? {
                return Ok(End::Input);
            }
            let byte = self.chunk[self.position];
            self.position += 1;
            if self.record.len() == self.ceiling {
                return Err(2);
            }
            self.record.push(byte);
            if byte == self.delimiter {
                return Ok(End::Delimiter);
            }
        }
    }

    async fn refill(
        &mut self,
        input: &Endpoint,
        context: &Context,
        work: &mut Work,
    ) -> Result<bool, i32> {
        self.position = 0;
        self.length = match input.read_cancelled(&mut self.chunk, &context.cancel).await {
            Ok(length) => length,
            Err(IoError::Cancelled) => return Err(130),
            Err(_) => 0,
        };
        super::super::scan_bytes(self.length, context, work).await?;
        Ok(self.length != 0)
    }
}
