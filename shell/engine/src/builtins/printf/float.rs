mod decimal;
mod integer;
mod parse;

use super::{
    PrintFailure, Printer,
    fields::{Arguments, Flags, ResolvedField},
};
use decimal::Decimal;

struct Float {
    negative: bool,
    magnitude: Magnitude,
}

enum Magnitude {
    Finite { significand: u64, exponent: i32 },
    Infinity,
    Nan,
}

impl Float {
    fn finite(negative: bool, significand: u64, exponent: i32) -> Self {
        Self {
            negative,
            magnitude: Magnitude::Finite {
                significand,
                exponent,
            },
        }
    }

    fn sign(&self, flags: Flags) -> &'static [u8] {
        if self.negative {
            return b"-";
        }
        if flags.plus {
            return b"+";
        }
        if flags.space {
            return b" ";
        }
        b""
    }

    async fn print(
        self,
        conversion: u8,
        flags: Flags,
        field: ResolvedField,
        printer: &mut Printer<'_>,
    ) -> Result<(), PrintFailure> {
        let sign = self.sign(flags);
        let Magnitude::Finite {
            significand,
            exponent,
        } = self.magnitude
        else {
            let special = match (self.magnitude, conversion.is_ascii_uppercase()) {
                (Magnitude::Infinity, false) => &b"inf"[..],
                (Magnitude::Infinity, true) => &b"INF"[..],
                _ if conversion.is_ascii_uppercase() => &b"NAN"[..],
                _ => &b"nan"[..],
            };
            let padding = field.width.saturating_sub(sign.len() + special.len());
            return special_field(sign, special, field.left, padding, printer).await;
        };
        let _storage = printer
            .context
            .admit_builtin_buffer(1024 + exponent.unsigned_abs() as usize * 4)?;
        let decimal =
            Decimal::new(significand, exponent, conversion, field.precision, printer).await?;
        let formatted = Formatted::new(decimal, conversion, field.precision, flags.alternate);
        let mut padding = field.width.saturating_sub(sign.len() + formatted.length());
        let zeroes = if flags.zero && !field.left {
            std::mem::take(&mut padding)
        } else {
            0
        };
        if !field.left {
            printer.padding(padding, b' ').await?;
        }
        printer.operand(sign, false).await?;
        printer.padding(zeroes, b'0').await?;
        formatted.print(printer).await?;
        if field.left {
            printer.padding(padding, b' ').await?;
        }
        Ok(())
    }
}

pub(super) async fn print(
    conversion: u8,
    flags: Flags,
    field: Option<ResolvedField>,
    args: &mut Arguments<'_>,
    printer: &mut Printer<'_>,
) -> Result<bool, PrintFailure> {
    let number = argument(args, printer).await?;
    let Some(field) = field else {
        return super::fields::field_overflow(args, printer).await;
    };
    number.print(conversion, flags, field, printer).await?;
    Ok(false)
}

async fn argument(
    args: &mut Arguments<'_>,
    printer: &mut Printer<'_>,
) -> Result<Float, PrintFailure> {
    let Some(value) = args.take() else {
        return Ok(Float::finite(false, 0, 0));
    };
    printer.scan(value.len()).await?;
    let (number, diagnostic) = parse::parse(value, printer).await?;
    if let Some(diagnostic) = diagnostic {
        args.status = 1;
        printer.numeric_warning(b"/usr/bin/bash: printf: ").await?;
        printer.numeric_warning(value.as_bytes()).await?;
        printer.numeric_warning(diagnostic).await?;
    }
    Ok(number)
}

async fn special_field(
    sign: &[u8],
    value: &[u8],
    left: bool,
    padding: usize,
    printer: &mut Printer<'_>,
) -> Result<(), PrintFailure> {
    if !left {
        printer.padding(padding, b' ').await?;
    }
    printer.operand(sign, false).await?;
    printer.operand(value, false).await?;
    if left {
        printer.padding(padding, b' ').await?;
    }
    Ok(())
}

struct Formatted {
    decimal: Decimal,
    fraction: usize,
    point: bool,
    exponent: Option<i32>,
    upper: bool,
}

impl Formatted {
    fn new(
        mut decimal: Decimal,
        conversion: u8,
        precision: Option<usize>,
        alternate: bool,
    ) -> Self {
        let precision = precision.unwrap_or(6);
        let kind = conversion.to_ascii_lowercase();
        let precision = if kind == b'g' {
            precision.max(1)
        } else {
            precision
        };
        let keep = match kind {
            b'f' => i64::from(decimal.point) + precision as i64,
            b'e' => precision as i64 + 1,
            _ => precision as i64,
        };
        let was_fixed = decimal.point > -4 && i64::from(decimal.point) <= precision as i64;
        decimal.round(keep);
        let scientific = kind == b'e'
            || (kind == b'g'
                && (decimal.point <= -4 || i64::from(decimal.point) > precision as i64));
        let exponent = scientific.then_some(decimal.point - 1);
        let point = if scientific { 1 } else { decimal.point };
        let mut fraction = match kind {
            b'f' | b'e' => precision,
            _ => (precision as i64 - i64::from(point)).max(0) as usize,
        };
        if kind == b'g' && alternate && was_fixed && scientific {
            fraction = 0;
        }
        if kind == b'g' && !alternate {
            let significant = decimal
                .digits
                .iter()
                .rposition(|digit| *digit != b'0')
                .map_or(0, |index| index + 1);
            fraction = fraction.min((significant as i64 - i64::from(point)).max(0) as usize);
        }
        Self {
            decimal,
            fraction,
            point: fraction != 0 || alternate,
            exponent,
            upper: conversion.is_ascii_uppercase(),
        }
    }

    fn length(&self) -> usize {
        let integer = if self.exponent.is_some() {
            1
        } else {
            self.decimal.point.max(1) as usize
        };
        let exponent = self
            .exponent
            .map_or(0, |value| 2 + value.unsigned_abs().to_string().len().max(2));
        integer + usize::from(self.point) + self.fraction + exponent
    }

    async fn print(&self, printer: &mut Printer<'_>) -> Result<(), PrintFailure> {
        let point = if self.exponent.is_some() {
            1
        } else {
            self.decimal.point
        };
        if point > 0 {
            self.decimal.range(0, point as usize, printer).await?;
        } else {
            printer.operand(b"0", false).await?;
        }
        if self.point {
            printer.operand(b".", false).await?;
        }
        self.decimal.range(point, self.fraction, printer).await?;
        if let Some(exponent) = self.exponent {
            let marker = if self.upper { 'E' } else { 'e' };
            let sign = if exponent < 0 { '-' } else { '+' };
            let suffix = format!("{marker}{sign}{:02}", exponent.unsigned_abs());
            printer.operand(suffix.as_bytes(), false).await?;
        }
        Ok(())
    }
}
