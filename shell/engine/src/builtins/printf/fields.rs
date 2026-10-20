use super::Printer;

pub(super) struct Arguments<'a> {
    pub values: &'a [String],
    pub index: usize,
    pub status: i32,
}
impl<'a> Arguments<'a> {
    pub fn take(&mut self) -> Option<&'a str> {
        let value = self.values.get(self.index).map(String::as_str);
        self.index += 1;
        value
    }
    pub(super) async fn number(
        &mut self,
        printer: &mut Printer<'_>,
        range: NumberRange,
    ) -> Result<i64, i32> {
        let Some(value) = self.take() else {
            return Ok(0);
        };
        printer.scan(value.len()).await?;
        let (number, diagnostic) = parse_number(value, printer.utf8, range);
        if let Some(diagnostic) = diagnostic {
            self.status = 1;
            printer.numeric_warning(b"/usr/bin/bash: printf: ").await?;
            printer.numeric_warning(value.as_bytes()).await?;
            printer.numeric_warning(diagnostic).await?;
        }
        Ok(number)
    }
}

#[derive(Clone, Copy)]
enum Count {
    Literal(u32),
    Star,
    Overflow,
}
impl Count {
    async fn parse(
        input: &[u8],
        offset: &mut usize,
        printer: &mut Printer<'_>,
    ) -> Result<Self, i32> {
        if input.get(*offset) == Some(&b'*') {
            printer.scan(1).await?;
            *offset += 1;
            return Ok(Self::Star);
        }
        let mut value = Some(0u32);
        while let Some(digit @ b'0'..=b'9') = input.get(*offset) {
            printer.scan(1).await?;
            value = value.and_then(|n| n.checked_mul(10)?.checked_add(u32::from(digit - b'0')));
            *offset += 1;
        }
        Ok(match value.filter(|n| *n <= i32::MAX as u32) {
            Some(value) => Self::Literal(value),
            None => Self::Overflow,
        })
    }
    async fn resolve(
        self,
        args: &mut Arguments<'_>,
        printer: &mut Printer<'_>,
    ) -> Result<i64, i32> {
        match self {
            Self::Literal(value) => Ok(i64::from(value)),
            Self::Star => args.number(printer, NumberRange::Star).await,
            Self::Overflow => Err(1),
        }
    }
}

pub(super) struct StringField {
    left: bool,
    width: Count,
    precision: Option<Count>,
}
impl StringField {
    pub async fn parse(
        input: &[u8],
        offset: &mut usize,
        printer: &mut Printer<'_>,
    ) -> Result<Option<Self>, i32> {
        let mut left = false;
        while let Some(flag @ (b'-' | b'+' | b' ' | b'#' | b'0' | b'\'')) = input.get(*offset) {
            printer.scan(1).await?;
            left |= *flag == b'-';
            *offset += 1;
        }
        let width = Count::parse(input, offset, printer).await?;
        let precision = if input.get(*offset) == Some(&b'.') {
            printer.scan(1).await?;
            *offset += 1;
            Some(Count::parse(input, offset, printer).await?)
        } else {
            None
        };
        if input.get(*offset) != Some(&b's') {
            return Ok(None);
        }
        printer.scan(1).await?;
        *offset += 1;
        Ok(Some(Self {
            left,
            width,
            precision,
        }))
    }
    pub async fn print(
        self,
        args: &mut Arguments<'_>,
        printer: &mut Printer<'_>,
    ) -> Result<bool, i32> {
        if matches!(self.width, Count::Overflow) || matches!(self.precision, Some(Count::Overflow))
        {
            printer
                .emit(
                    2,
                    b"/usr/bin/bash: printf: Value too large for defined data type\n",
                )
                .await?;
            args.status = 1;
            return Ok(true);
        }
        let width = self.width.resolve(args, printer).await?;
        let precision = match self.precision {
            Some(count) => count.resolve(args, printer).await?,
            None => -1,
        };
        let value = args.take().unwrap_or("").as_bytes();
        let length = if precision < 0 {
            value.len()
        } else {
            value.len().min(precision as usize)
        };
        let padding = (width.unsigned_abs() as usize).saturating_sub(length);
        let left = self.left || width < 0;
        if !left {
            printer.padding(padding).await?;
        }
        printer.operand(&value[..length], false).await?;
        if left {
            printer.padding(padding).await?;
        }
        Ok(false)
    }
}

#[derive(Clone, Copy)]
pub(super) enum NumberRange {
    Star,
    Signed,
}
impl NumberRange {
    fn limit(self, negative: bool) -> u64 {
        let maximum = match self {
            Self::Star => i32::MAX as u64,
            Self::Signed => i64::MAX as u64,
        };
        maximum + u64::from(negative)
    }
    fn overflow(self, negative: bool) -> i64 {
        match self {
            Self::Star => -1,
            Self::Signed if negative => i64::MIN,
            Self::Signed => i64::MAX,
        }
    }
}

fn parse_number(value: &str, utf8: bool, range: NumberRange) -> (i64, Option<&'static [u8]>) {
    let input = value.as_bytes();
    if matches!(input.first(), Some(b'\'' | b'"')) {
        let character = if utf8 {
            value[1..].chars().next().map(u32::from).unwrap_or(0)
        } else {
            u32::from(input.get(1).copied().unwrap_or(0))
        };
        return (i64::from(character), None);
    }
    let mut offset = 0;
    while input
        .get(offset)
        .is_some_and(|byte| matches!(byte, b' ' | b'\t'..=b'\r'))
    {
        offset += 1;
    }
    let negative = input.get(offset) == Some(&b'-');
    if matches!(input.get(offset), Some(b'+' | b'-')) {
        offset += 1;
    }
    let radix = number_radix(input, &mut offset);
    let start = offset;
    let mut number = 0u64;
    while let Some(digit) = input
        .get(offset)
        .and_then(|byte| super::hex(*byte))
        .filter(|n| *n < radix)
    {
        number = number
            .saturating_mul(u64::from(radix))
            .saturating_add(u64::from(digit));
        offset += 1;
    }
    let limit = range.limit(negative);
    let range_error = (number > limit).then_some(&b": Numerical result out of range\n"[..]);
    let number = if range_error.is_some() {
        range.overflow(negative)
    } else if negative {
        (number as i64).wrapping_neg()
    } else {
        number as i64
    };
    let diagnostic = if offset == start || offset != input.len() {
        Some(invalid_number(input))
    } else {
        range_error
    };
    (number, diagnostic)
}
fn invalid_number(input: &[u8]) -> &'static [u8] {
    match input {
        [b'0', b'0'..=b'9', ..] => b": invalid octal number\n",
        [b'0', b'x', ..] => b": invalid hex number\n",
        _ => b": invalid number\n",
    }
}
fn number_radix(input: &[u8], offset: &mut usize) -> u32 {
    if input.get(*offset) != Some(&b'0') {
        return 10;
    }
    if matches!(input.get(*offset + 1), Some(b'x' | b'X')) {
        *offset += 2;
        return 16;
    }
    if matches!(input.get(*offset + 1), Some(b'b' | b'B')) {
        *offset += 2;
        return 2;
    }
    8
}
