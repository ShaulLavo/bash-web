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
    ) -> Result<u64, i32> {
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
enum Count<'a> {
    Literal(u32),
    Star,
    Overflow(&'a [u8]),
}
impl<'a> Count<'a> {
    async fn parse(
        input: &'a [u8],
        offset: &mut usize,
        printer: &mut Printer<'_>,
    ) -> Result<Self, i32> {
        if input.get(*offset) == Some(&b'*') {
            printer.scan(1).await?;
            *offset += 1;
            return Ok(Self::Star);
        }
        let start = *offset;
        let mut value = Some(0u32);
        while let Some(digit @ b'0'..=b'9') = input.get(*offset) {
            printer.scan(1).await?;
            value = value.and_then(|n| n.checked_mul(10)?.checked_add(u32::from(digit - b'0')));
            *offset += 1;
        }
        Ok(match value.filter(|n| *n <= i32::MAX as u32) {
            Some(value) => Self::Literal(value),
            None => Self::Overflow(&input[start..*offset]),
        })
    }
    async fn resolve(
        self,
        args: &mut Arguments<'_>,
        printer: &mut Printer<'_>,
    ) -> Result<Option<i64>, i32> {
        match self {
            Self::Literal(value) => Ok(Some(i64::from(value))),
            Self::Star => Ok(Some(args.number(printer, NumberRange::Star).await? as i64)),
            Self::Overflow(_) => Ok(None),
        }
    }
}

#[derive(Clone, Copy, Default)]
struct Flags {
    left: bool,
    plus: bool,
    space: bool,
    zero: bool,
    alternate: bool,
    grouping: bool,
}
impl Flags {
    async fn parse(
        input: &[u8],
        offset: &mut usize,
        printer: &mut Printer<'_>,
    ) -> Result<Self, i32> {
        let mut flags = Self::default();
        while let Some(flag @ (b'-' | b'+' | b' ' | b'#' | b'0' | b'\'')) = input.get(*offset) {
            printer.scan(1).await?;
            flags.left |= *flag == b'-';
            flags.plus |= *flag == b'+';
            flags.space |= *flag == b' ';
            flags.zero |= *flag == b'0';
            flags.alternate |= *flag == b'#';
            flags.grouping |= *flag == b'\'';
            *offset += 1;
        }
        Ok(flags)
    }
}

pub(super) struct Field<'a> {
    flags: Flags,
    width: Count<'a>,
    precision: Option<Count<'a>>,
    conversion: u8,
}
struct ResolvedField {
    left: bool,
    width: usize,
    precision: Option<usize>,
}
impl<'a> Field<'a> {
    pub async fn parse(
        input: &'a [u8],
        offset: &mut usize,
        printer: &mut Printer<'_>,
    ) -> Result<Option<Self>, i32> {
        let flags = Flags::parse(input, offset, printer).await?;
        let width = Count::parse(input, offset, printer).await?;
        let precision = if input.get(*offset) == Some(&b'.') {
            printer.scan(1).await?;
            *offset += 1;
            Some(Count::parse(input, offset, printer).await?)
        } else {
            None
        };
        let Some(
            &conversion @ (b's' | b'c' | b'd' | b'i' | b'u' | b'o' | b'x' | b'X' | b'q' | b'Q'),
        ) = input.get(*offset)
        else {
            return Ok(None);
        };
        if !matches!(conversion, b's' | b'c' | b'q' | b'Q') && flags.grouping {
            return Ok(None);
        }
        printer.scan(1).await?;
        *offset += 1;
        Ok(Some(Self {
            flags,
            width,
            precision,
            conversion,
        }))
    }
    async fn resolve(
        &self,
        args: &mut Arguments<'_>,
        printer: &mut Printer<'_>,
    ) -> Result<Option<ResolvedField>, i32> {
        let overflow = matches!(self.width, Count::Overflow(_))
            || matches!(self.precision, Some(Count::Overflow(_)));
        if self.conversion == b's' && overflow {
            return Ok(None);
        }
        let width = self.width.resolve(args, printer).await?;
        let precision = match self.precision {
            Some(count) => count.resolve(args, printer).await?,
            None => Some(-1),
        };
        Ok(width
            .zip(precision)
            .map(|(width, precision)| ResolvedField {
                left: self.flags.left || width < 0,
                width: width.unsigned_abs() as usize,
                precision: (precision >= 0).then_some(precision as usize),
            }))
    }
    async fn print_quoted(
        self,
        args: &mut Arguments<'_>,
        printer: &mut Printer<'_>,
    ) -> Result<bool, i32> {
        let width = self.width.resolve(args, printer).await?.unwrap_or(0);
        let precision = match self.precision {
            Some(count) => count.resolve(args, printer).await?,
            None => Some(-1),
        };
        quote_count_warning(self.width, args, printer).await?;
        if let Some(count) = self.precision {
            quote_count_warning(count, args, printer).await?;
        }
        let precision = precision.unwrap_or(if self.conversion == b'q' { 0 } else { -1 });
        let mut field = ResolvedField {
            left: self.flags.left || width < 0,
            width: width.unsigned_abs() as usize,
            precision: (precision >= 0).then_some(precision as usize),
        };
        let value = args.take().unwrap_or("").as_bytes();
        let value = if self.conversion == b'Q' {
            let length = field
                .precision
                .take()
                .map_or(value.len(), |n| value.len().min(n));
            &value[..length]
        } else {
            value
        };
        let quoted = super::quoting::Quoted::new(value, self.flags.alternate, printer).await?;
        let length = quoted.walk(field.precision, false, printer).await?;
        let padding = field.width.saturating_sub(length);
        if !field.left {
            printer.padding(padding, b' ').await?;
        }
        quoted.walk(field.precision, true, printer).await?;
        if field.left {
            printer.padding(padding, b' ').await?;
        }
        Ok(false)
    }
    pub async fn print(
        self,
        args: &mut Arguments<'_>,
        printer: &mut Printer<'_>,
    ) -> Result<bool, i32> {
        if matches!(self.conversion, b'q' | b'Q') {
            return self.print_quoted(args, printer).await;
        }
        let field = self.resolve(args, printer).await?;
        if matches!(self.conversion, b's' | b'c') {
            let Some(mut field) = field else {
                return field_overflow(args, printer).await;
            };
            let value = args.take().unwrap_or("").as_bytes();
            let value = if self.conversion == b'c' {
                field.precision = None;
                value.get(..1).unwrap_or(b"\0")
            } else {
                value
            };
            field.print_string(value, printer).await?;
            return Ok(false);
        }
        let range = if matches!(self.conversion, b'd' | b'i') {
            NumberRange::Signed
        } else {
            NumberRange::Unsigned
        };
        let number = args.number(printer, range).await?;
        let Some(field) = field else {
            return field_overflow(args, printer).await;
        };
        Integer::new(number, self.conversion, self.flags, field)
            .print(printer)
            .await?;
        Ok(false)
    }
}
async fn quote_count_warning(
    count: Count<'_>,
    args: &mut Arguments<'_>,
    printer: &mut Printer<'_>,
) -> Result<(), i32> {
    let Count::Overflow(value) = count else {
        return Ok(());
    };
    args.status = 1;
    printer.numeric_warning(b"/usr/bin/bash: printf: ").await?;
    printer.numeric_warning(value).await?;
    printer
        .numeric_warning(b": Numerical result out of range\n")
        .await
}

async fn field_overflow(args: &mut Arguments<'_>, printer: &mut Printer<'_>) -> Result<bool, i32> {
    printer
        .emit(
            2,
            b"/usr/bin/bash: printf: Value too large for defined data type\n",
        )
        .await?;
    args.status = 1;
    Ok(true)
}

impl ResolvedField {
    async fn print_string(&self, value: &[u8], printer: &mut Printer<'_>) -> Result<(), i32> {
        let length = self.precision.map_or(value.len(), |n| value.len().min(n));
        let padding = self.width.saturating_sub(length);
        if !self.left {
            printer.padding(padding, b' ').await?;
        }
        printer.operand(&value[..length], false).await?;
        if self.left {
            printer.padding(padding, b' ').await?;
        }
        Ok(())
    }
}

struct Integer {
    digits: [u8; 22],
    start: usize,
    prefix: &'static [u8],
    zeroes: usize,
    padding: usize,
    left: bool,
}
impl Integer {
    fn new(number: u64, conversion: u8, flags: Flags, field: ResolvedField) -> Self {
        let negative = matches!(conversion, b'd' | b'i') && (number as i64) < 0;
        let magnitude = if negative {
            number.wrapping_neg()
        } else {
            number
        };
        let (digits, mut start) = integer_digits(magnitude, conversion);
        if number == 0 && field.precision == Some(0) {
            start = digits.len();
        }
        let mut zeroes = field
            .precision
            .unwrap_or(0)
            .saturating_sub(digits.len() - start);
        if conversion == b'o' && flags.alternate && (start == digits.len() || digits[start] != b'0')
        {
            zeroes = zeroes.max(1);
        }
        let prefix = integer_prefix(number, conversion, flags);
        let mut padding = field
            .width
            .saturating_sub(prefix.len() + zeroes + digits.len() - start);
        if flags.zero && !field.left && field.precision.is_none() {
            zeroes += padding;
            padding = 0;
        }
        Self {
            digits,
            start,
            prefix,
            zeroes,
            padding,
            left: field.left,
        }
    }
    async fn print(&self, printer: &mut Printer<'_>) -> Result<(), i32> {
        if !self.left {
            printer.padding(self.padding, b' ').await?;
        }
        printer.operand(self.prefix, false).await?;
        printer.padding(self.zeroes, b'0').await?;
        printer.operand(&self.digits[self.start..], false).await?;
        if self.left {
            printer.padding(self.padding, b' ').await?;
        }
        Ok(())
    }
}

fn integer_digits(mut magnitude: u64, conversion: u8) -> ([u8; 22], usize) {
    let radix = match conversion {
        b'o' => 8,
        b'x' | b'X' => 16,
        _ => 10,
    };
    let alphabet = if conversion == b'X' {
        b"0123456789ABCDEF"
    } else {
        b"0123456789abcdef"
    };
    let mut digits = [0u8; 22];
    let mut offset = digits.len();
    loop {
        offset -= 1;
        digits[offset] = alphabet[(magnitude % radix) as usize];
        magnitude /= radix;
        if magnitude == 0 {
            return (digits, offset);
        }
    }
}

fn integer_prefix(number: u64, conversion: u8, flags: Flags) -> &'static [u8] {
    if matches!(conversion, b'd' | b'i') {
        if (number as i64) < 0 {
            return b"-";
        }
        if flags.plus {
            return b"+";
        }
        if flags.space {
            return b" ";
        }
        return b"";
    }
    if number == 0 || !flags.alternate {
        return b"";
    }
    match conversion {
        b'x' => b"0x",
        b'X' => b"0X",
        _ => b"",
    }
}

#[derive(Clone, Copy)]
pub(super) enum NumberRange {
    Star,
    Signed,
    Unsigned,
}
impl NumberRange {
    fn limit(self, negative: bool) -> u64 {
        let maximum = match self {
            Self::Star => i32::MAX as u64,
            Self::Signed => i64::MAX as u64,
            Self::Unsigned => return u64::MAX,
        };
        maximum + u64::from(negative)
    }
    fn overflow(self, negative: bool) -> u64 {
        match self {
            Self::Star | Self::Unsigned => u64::MAX,
            Self::Signed if negative => i64::MIN as u64,
            Self::Signed => i64::MAX as u64,
        }
    }
}

fn parse_number(value: &str, utf8: bool, range: NumberRange) -> (u64, Option<&'static [u8]>) {
    let input = value.as_bytes();
    if matches!(input.first(), Some(b'\'' | b'"')) {
        let character = if utf8 {
            value[1..].chars().next().map(u32::from).unwrap_or(0)
        } else {
            u32::from(input.get(1).copied().unwrap_or(0))
        };
        return (u64::from(character), None);
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
    let mut number = Some(0u64);
    while let Some(digit) = input
        .get(offset)
        .and_then(|byte| super::hex(*byte))
        .filter(|n| *n < radix)
    {
        number = number.and_then(|n| {
            n.checked_mul(u64::from(radix))?
                .checked_add(u64::from(digit))
        });
        offset += 1;
    }
    let limit = range.limit(negative);
    let range_error = number
        .is_none_or(|n| n > limit)
        .then_some(&b": Numerical result out of range\n"[..]);
    let number = match number.filter(|n| *n <= limit) {
        Some(n) if negative => n.wrapping_neg(),
        Some(n) => n,
        None => range.overflow(negative),
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
